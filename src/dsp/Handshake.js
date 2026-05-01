'use strict';

/**
 * Handshake Engine — ITU-T V.8 spec-conformant modem negotiation
 *
 * Manages the full modem handshake sequence from call-connect to data mode.
 *
 * Answer mode sequence (V.8 §8.2):
 *   1. ≥0.2 s silence after connection
 *   2. Transmit ANSam (2100 Hz + 15 Hz AM + 180° phase reversals at 450ms)
 *   3. Listen for CI or CM on V.21(L) (channel 1, originate direction)
 *   4. On ≥2 identical CM: start sending JM on V.21(H)
 *   5. Continue JM until CJ detected (three zero octets on V.21(L))
 *   6. After CJ: 75 ± 5 ms silence
 *   7. Switch to the selected modulation's answer-side training
 *
 * Originate mode sequence (V.8 §8.1):
 *   1. ≥1 s silence after off-hook
 *   2. Optionally send CI on V.21(L) (can be continuous or cadenced)
 *   3. Listen for ANS / ANSam / sigA
 *   4. On ANSam detected: stop CI, Te = 0.5-1 s silence, then send CM on V.21(L)
 *   5. Listen for JM on V.21(H)
 *   6. On ≥2 identical JM: finish current CM octet, send CJ
 *   7. After CJ: 75 ± 5 ms silence
 *   8. Switch to the selected modulation's originate-side training
 *
 * V.8 signalling format (per V.8 §5, §7):
 *   CI  = V.21(L) FSK: sync byte 0x00 + call-function byte 0xC1 (Data)
 *   CM  = V.21(L) FSK: sync byte 0xE0 + call-fn 0xC1 + modulation-modes octets
 *   JM  = V.21(H) FSK: same format as CM but on the answer-direction channel
 *   CJ  = V.21(L) FSK: three 0x00 octets (no preamble, no sync)
 *
 * Each byte is UART-framed (start bit + 8 LSB-first data bits + stop bit)
 * by the V.21 modulator — which happens to match the V.8 spec's octet
 * framing. The 10-bit "sync pattern" of CI/CM/JM is sent as a pseudo-byte
 * whose UART frame equals the sync pattern (0x00 for CI, 0xE0 for CM/JM).
 */

const { EventEmitter }    = require('events');
const config              = require('../../config');
const { makeLogger }      = require('../logger');
const { generateTone }    = require('./Primitives');
const V8                  = require('./V8');
const { V8Sequencer }     = require('./V8Sequencer');
const { V21 }             = require('./protocols/V21');
const { Bell103 }         = require('./protocols/Bell103');
const { V22, V22bis }     = require('./protocols/V22');
const { V23 }             = require('./protocols/V23');

const log = makeLogger('Handshake');
const SR  = config.rtp.sampleRate;
const cfg = config.modem.native;

// ─── Protocol registry ─────────────────────────────────────────────────────
//
// All protocol classes that can be instantiated by name. Whether a given
// protocol is *advertised* during V.8 negotiation is controlled separately
// by config.modem.native.protocolPreference and v8ModulationModes; the
// registry just makes the class reachable when it is selected.
//
// Post-cleanup-phase-2 status:
//   V21, V22, Bell103  — active, default-advertised
//   V22bis             — TESTING (pure-JS implementation in V22.js, not
//                        known-working; preserved as the basis for a
//                        future native-V.22bis fix)
//   V23                — TESTING. spandsp-port (April 2026); coherent
//                        quadrature-correlator demod + sub-sample-
//                        accurate baud TX. Self-loopback round-trip
//                        validated on both 1200-bps forward and 75-bps
//                        backward channels with arbitrary byte
//                        patterns. Real-V.23-peer validation pending.
//
const PROTOCOLS = {
  V21:     (role) => new V21(role),
  Bell103: (role) => new Bell103(role),
  V22:     (role) => new V22(role),
  V22bis:  (role) => new V22bis(role),
  V23:     (role) => new V23(role),
};

// ─── Detection constants ───────────────────────────────────────────────────

const ANS_FREQ = 2100;                  // ANS / ANSam (used by forced-protocol path)

// V.8 timing (§8) — only TE_MS is still used by the forced-protocol path
// for V.21. The V.8 negotiation path uses sample-counted timers inside
// V8Sequencer instead; see src/dsp/V8Sequencer.js for those.
const TE_MS = 1000;

// ─── State machine ─────────────────────────────────────────────────────────
//
// Post-V8Sequencer simplification: the V.8 phase now lives inside
// V8Sequencer (faithful spandsp v8.c port), with its own internal state
// machine. Handshake.js exposes a single V8_NEGOTIATE meta-state for
// the entire V.8 negotiation, plus the legacy ANS_SEND state used by
// the forced-protocol shortcut path (which bypasses V.8 entirely).

const HS_STATE = {
  IDLE:          'IDLE',
  ANS_SEND:      'ANS_SEND',     // Forced-protocol path: emitting plain ANS
  V8_NEGOTIATE:  'V8_NEGOTIATE', // Delegating audio TX/RX to V8Sequencer
  TRAINING:      'TRAINING',     // Protocol-specific training
  DATA:          'DATA',
  FAILED:        'FAILED',
};

// ─── FSK probe discriminator ──────────────────────────────────────────────
//
// V.21 and Bell103 use distinct FSK frequencies (V.21 caller mark 980 Hz,
// Bell103 caller mark 1270 Hz) but the bandpass filters in the FSK demod
// classes (Q=15, ~80 Hz BW) are wide enough for each protocol's caller
// mark to bleed into the OTHER protocol's mark/space passband and trip
// `carrierDetected`. Capture analysis (Bell103 mark fed to V.21 demod
// at answer-side, and V.21 mark fed to Bell103 demod) confirms both
// directions of the cross-talk.
//
// Without correction, whichever FSK probe runs first in the legacy
// automode chain wins, regardless of which protocol the caller is
// actually using.
//
// The discriminator runs two narrow Goertzels — one at the in-band
// caller-mark frequency, one at the cross-protocol caller-mark
// frequency — with smoothed energy. `isInBand()` returns true only
// when in-band energy meaningfully dominates cross-band energy. We
// require a 1.5× ratio with a small noise floor to avoid flapping at
// low signal levels.
class FskDiscriminator {
  constructor(inBandHz, crossBandHz) {
    this._inHz    = inBandHz;
    this._crossHz = crossBandHz;
    this._inE    = 0;
    this._crossE = 0;
    // EMA smoothing factor: 0.2 mixes ~5 blocks (each typically 160-200
    // samples = 20-25 ms). That gives a ~100 ms time-constant — fast
    // enough to react during the 500 ms CD-stable window, slow enough
    // to ride out brief noise blips.
    this._alpha = 0.2;
  }

  process(samples) {
    const n = samples.length;
    const kIn    = 2 * Math.PI * this._inHz    / SR;
    const kCross = 2 * Math.PI * this._crossHz / SR;
    const cIn    = 2 * Math.cos(kIn);
    const cCross = 2 * Math.cos(kCross);
    let s1i = 0, s2i = 0, s1c = 0, s2c = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      let nw = x + cIn * s1i - s2i;
      s2i = s1i; s1i = nw;
      nw = x + cCross * s1c - s2c;
      s2c = s1c; s1c = nw;
    }
    const magIn    = Math.sqrt(s1i*s1i + s2i*s2i - cIn   *s1i*s2i) / n;
    const magCross = Math.sqrt(s1c*s1c + s2c*s2c - cCross*s1c*s2c) / n;
    this._inE    = this._inE    * (1 - this._alpha) + magIn    * this._alpha;
    this._crossE = this._crossE * (1 - this._alpha) + magCross * this._alpha;
  }

  /** True if in-band energy dominates cross-band energy. */
  isInBand() {
    return this._inE > 1.5 * this._crossE + 0.001;
  }

  /** Diagnostic. */
  get inE()    { return this._inE; }
  get crossE() { return this._crossE; }
}

// ═══════════════════════════════════════════════════════════════════════════
// HandshakeEngine
// ═══════════════════════════════════════════════════════════════════════════

class HandshakeEngine extends EventEmitter {

  constructor(role) {
    super();
    this._role          = role;
    this._state         = HS_STATE.IDLE;
    this._protocol      = null;
    this._protocolName  = null;
    this._audioQueue    = [];
    this._timer         = null;
    this._forced        = cfg.forceProtocol;
    // Sample-accurate transition flag. When set (non-null) and state
    // is ANS_SEND, generateAudio() drains the queue then immediately
    // calls _selectProtocol(this._pendingForcedProtocol) with ZERO
    // silence gap. See generateAudio() for rationale.
    this._pendingForcedProtocol = null;

    // V.8 sequencer (created lazily in start() if V.8 is enabled).
    // Owns all of: ANSam generation, V.21 modulator/demodulator,
    // CM/JM/CJ exchange, post-CJ silence, and the V.8 state machine.
    // We listen for 'result' / 'failed' / 'non-v8' events.
    this._v8seq = null;

    // For originate: restrict what we advertise in CM (useful for testing).
    if (cfg.advertiseProtocol && this._role === 'originate') {
      this._advertise = [cfg.advertiseProtocol];
    }
  }

  // ─── Start / stop ────────────────────────────────────────────────────────

  /**
   * Start the handshake.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.skipV8=false] — Skip V.8 entirely; jump straight
   *     to the V.25 legacy automode probe chain. Implies skipAnsam=true
   *     because by definition the caller has already heard ANSam from
   *     elsewhere (the `auto` backend uses this after slmodemd-pjsip
   *     played 12 s of ANSam and timed out waiting for CM).
   * @param {boolean} [opts.skipAnsam=false] — Skip the ANSam phase even
   *     in V.8 mode. Currently only meaningful in conjunction with
   *     skipV8.
   *
   * Default behaviour (no opts) is unchanged: forced-protocol path,
   * else V.8 negotiation, else V.25 fallback.
   */
  start(opts) {
    opts = opts || {};
    this._state = HS_STATE.IDLE;
    log.info(`Handshake starting (${this._role})${opts.skipV8 ? ' [skipV8]' : ''}${opts.skipAnsam ? ' [skipAnsam]' : ''}`);

    // Fall-through entry point used by the `auto` backend after
    // slmodemd-pjsip's V.8 attempt times out. The caller has already
    // heard ~12 s of ANSam from PJSIP and is sitting in V.25
    // "answer-tone-heard, awaiting training" state. We jump directly
    // into the legacy automode probe chain — no ANSam, no V.8 wait.
    if (opts.skipV8) {
      log.info('Skipping V.8 / ANSam — entering V.25 legacy automode probe directly');
      // Same probe queue as V8Sequencer's timeout-no-cm fallback.
      // See _selectProtocol's failure handler / _advanceProbe for
      // window rationale.
      this._probeQueue = [
        { protocol: 'V22bis',  listenMs: 5000 },
        { protocol: 'V21',     listenMs: 3000 },
        { protocol: 'Bell103', listenMs: 5000 },
      ];
      this._advanceProbe();
      return;
    }

    if (this._forced) {
      log.info(`Protocol forced to ${this._forced} — bypassing V.8`);
      // Real modems on the far side expect to hear an answer tone
      // (ANS / ANSam per V.25) before any modulation handshake begins.
      // Skipping it causes the originate modem to stay silent, waiting
      // for the answer it never hears. Prepend ANSam for ALL answer-side
      // forced protocols (including V.21) just like the normal V.8 path
      // does, so that the far-end modem detects a real answer tone
      // before we start our training signals.
      //
      // (Previously we skipped ANSam for V.21 on the assumption that V.21
      // doesn't require it. Empirically, real modems DO require ANSam
      // before engaging V.21 originate mode — they need to know the
      // answer side picked up.)
      if (this._role === 'answer') {
        // V.25 §3.1 initial silence (≥ 1800 ms) so the caller's modem
        // has time to come fully off-hook and ready itself to listen.
        // Without this, the modem may still be in its off-hook transient
        // when our ANSam starts, and miss the tone entirely.
        const initialDelay = Math.max(cfg.answerToneDelayMs || 0, 1800);

        // Te silence after ANS. Per V.22 Figure 4/V.22, after the answer
        // modem stops transmitting ANS, it should begin transmitting
        // USB1 in the high channel after a short silence. Empirical
        // comparison against spandsp-era captures showed that spandsp
        // produced ~150 ms of post-ANS silence. For V.22/V.22bis that
        // is what works; for V.21 forced path we use the longer TE_MS
        // (1000 ms) which has been verified.
        const teMs = (this._forced === 'V22' || this._forced === 'V22bis')
          ? 150
          : TE_MS;

        // For FORCED protocol mode we bypass V.8 entirely. Critical:
        // we must send PLAIN V.25 ANS (2100 Hz, no 15 Hz AM modulation)
        // — NOT ANSam. The 15 Hz envelope in ANSam is how a V.8-capable
        // modem identifies a V.8-capable peer; seeing it, the caller
        // will send CM and wait for JM. If we then never respond with
        // JM (because we're forced to V.21/V.22/V.22bis and skip V.8),
        // the caller times out and gives up before we start training.
        log.info(`Initial silence (${initialDelay} ms) + plain ANS (${cfg.answerToneDurationMs} ms) + Te silence (${teMs} ms) before ${this._forced} training`);
        this._enqueueSilence(initialDelay);
        this._enqueue(generateTone(ANS_FREQ, cfg.answerToneDurationMs, SR, 0.15));
        this._enqueueSilence(teMs);
        this._state = HS_STATE.ANS_SEND;
        // CRITICAL TIMING: transition into the forced protocol the
        // instant the queued audio is consumed — not via a setTimeout.
        // Node.js setTimeout has jitter that would insert extra silence
        // between Te and the start of V.22 training. V.22 spec allows
        // only 75 ± 20 ms for Te; exceeding this causes strict hardware
        // modems to abandon the call.
        this._pendingForcedProtocol = this._forced;
      } else {
        this._selectProtocol(this._forced);
      }
      return;
    }

    // V.8 negotiation path. The answer side prepends a configurable
    // silence (default 1 s) so the caller's modem can fully come off-hook
    // before ANSam begins. We do this with a queued-audio silence rather
    // than a wall-clock setTimeout so the timing is sample-accurate
    // (matches the rest of the V8Sequencer's sample-counted timing).
    if (this._role === 'answer' && cfg.answerToneDelayMs > 0) {
      this._enqueueSilence(cfg.answerToneDelayMs);
      // _startV8 below sets state to V8_NEGOTIATE; generateAudio will
      // drain the queued silence first before delegating to the sequencer.
    }
    this._startV8();
  }

  /** Construct the V8Sequencer, wire its events, and start it. */
  _startV8() {
    const advertised = this._advertise || cfg.v8ModulationModes || cfg.protocolPreference;
    log.debug(`V.8 enabled — starting sequencer (advertising ${advertised.join(',')})`);
    this._state = HS_STATE.V8_NEGOTIATE;

    this._v8seq = new V8Sequencer({
      role:  this._role,
      parms: {
        modulations: advertised,
        callFn:      6,    // V_SERIES — modem data
      },
    });

    this._v8seq.on('result', result => {
      // V.8 succeeded. result.protocol is the chosen modulation name.
      log.info(`V.8 negotiation complete — selected ${result.protocol}`);
      this._v8seq = null;
      this._selectProtocol(result.protocol);
    });

    this._v8seq.on('failed', reason => {
      // V.8 failed. There are two distinct cases:
      //
      //   timeout-no-cm:  We never heard CM from the caller. Most common
      //                   reason: caller has V.8 disabled (vintage modem,
      //                   or modern modem configured for legacy protocol
      //                   via AT command). Caller heard our ANSam, decided
      //                   it's an answer tone, and is now silently waiting
      //                   for the answerer-side modulation training. We
      //                   need to probe down through V.22bis → V.21 →
      //                   Bell103 to find the protocol it speaks.
      //
      //   timeout-no-cj / timeout-no-jm / no-deal:  V.8 negotiation got
      //                   past CMs but the protocol selection broke down.
      //                   In practice this means the caller is V.8
      //                   capable but mismatched somehow. Fall back to
      //                   the lowest-preference protocol (Bell103)
      //                   directly — no full probe chain.
      //
      this._v8seq = null;
      if (reason === 'timeout-no-cm' || reason === 'timeout-no-ansam') {
        log.info(`V.8 timed out (${reason}) — entering V.25 legacy automode probe`);
        // Probe order rationale: V.22bis first because (a) it's the
        // highest-rate, (b) it handles V.22-only callers via the
        // existing TIMED_S11 fallback inside the V22bis class. Then V.21
        // (most modern non-V.22 callers). Then Bell103 (vintage US).
        // Windows: V.22bis 5s (full DPSK handshake takes ~3.5s, leave
        // margin); V.21 3s (FSK lock is near-instant); Bell103 5s (slow
        // vintage hardware deserves headroom).
        this._probeQueue = [
          { protocol: 'V22bis',  listenMs: 5000 },
          { protocol: 'V21',     listenMs: 3000 },
          { protocol: 'Bell103', listenMs: 5000 },
        ];
        this._advanceProbe();
      } else {
        const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
        log.warn(`V.8 handshake failed (${reason}) — falling back to ${fallback}`);
        this._selectProtocol(fallback);
      }
    });

    this._v8seq.on('non-v8', () => {
      // Originate-side: heard plain ANS, peer isn't V.8-capable. Bail
      // out to legacy V.25 fallback. (We're not testing originate; this
      // is a stub.)
      this._v8seq = null;
      const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
      log.info(`V.8: peer not V.8-capable — falling back to ${fallback}`);
      this._selectProtocol(fallback);
    });

    this._v8seq.start();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._cdPollTimer) { clearInterval(this._cdPollTimer); this._cdPollTimer = null; }
    this._pendingForcedProtocol = null;
    this._state = HS_STATE.IDLE;
    if (this._protocol) {
      this._protocol.removeAllListeners();
      this._protocol = null;
    }
    if (this._v8seq) {
      this._v8seq.stop();
      this._v8seq.removeAllListeners();
      this._v8seq = null;
    }
  }

  // ─── Audio generation ────────────────────────────────────────────────────

  generateAudio(n) {
    // Data mode: full delegation to protocol.
    if (this._state === HS_STATE.DATA && this._protocol) {
      return this._protocol.generateAudio(n);
    }

    // V.8 negotiation: delegate audio production to the sequencer. It
    // handles ANSam, post-ANSam silence, V.21 modulation, and 75 ms
    // post-CJ silence internally, sample-accurately. Some pre-V.8
    // silence may still be queued (the answerToneDelayMs ramp) — drain
    // that first if present.
    if (this._state === HS_STATE.V8_NEGOTIATE && this._v8seq) {
      const queued = this._drainQueue(n);
      let hasNonSilence = false;
      for (let i = 0; i < queued.length; i++) {
        if (queued[i] !== 0) { hasNonSilence = true; break; }
      }
      if (hasNonSilence) return queued;
      return this._v8seq.generateAudio(n);
    }

    // ANS_SEND state in FORCED protocol mode: drain queued samples
    // (initial silence + ANS + Te silence). When the queue empties,
    // immediately call _selectProtocol() and fill the remainder of
    // this audio block from the protocol's generator. This gives a
    // sample-accurate transition from Te silence → V.22 training
    // (no setTimeout, no event-loop jitter, no extra silence gap).
    if (this._state === HS_STATE.ANS_SEND && this._pendingForcedProtocol) {
      const out = new Float32Array(n);
      let pos = 0;
      while (pos < n && this._audioQueue.length > 0) {
        const item  = this._audioQueue[0];
        const avail = item.samples.length - item.pos;
        const take  = Math.min(avail, n - pos);
        out.set(item.samples.subarray(item.pos, item.pos + take), pos);
        item.pos += take;
        pos += take;
        if (item.pos >= item.samples.length) this._audioQueue.shift();
      }
      // Queue drained in the middle of this block: transition right now,
      // then fill remainder from the protocol's training audio.
      if (pos < n) {
        const forced = this._pendingForcedProtocol;
        this._pendingForcedProtocol = null;
        this._selectProtocol(forced);
        if (this._protocol && this._protocol.generateAudio) {
          const remaining = n - pos;
          const live = this._protocol.generateAudio(remaining);
          out.set(live.subarray(0, remaining), pos);
        }
      }
      return out;
    }

    // TRAINING state with a pre-queued training burst (V.21, etc.): drain
    // the queue first. If the queue runs dry before the training timer
    // fires — which happens when the scheduled timeout is slightly longer
    // than the queued audio, creating a silence gap — fall through to
    // generating live protocol audio (continued mark idle) so the far-
    // end modem's carrier detect stays locked. Without this, the 100 ms
    // of silence between queue drain and state transition drops CD and
    // the first few bits of data are lost while CD reacquires.
    if (this._state === HS_STATE.TRAINING && this._protocol &&
        this._protocol.generateAudio) {
      return this._drainQueueOrGenerate(n);
    }

    return this._drainQueue(n);
  }

  _drainQueueOrGenerate(n) {
    // Prefer queued audio; if queue doesn't cover the full block, fill
    // the remainder with live protocol audio (continued mark idle or
    // whatever the protocol is currently emitting).
    const out = new Float32Array(n);
    let pos = 0;
    while (pos < n && this._audioQueue.length > 0) {
      const item = this._audioQueue[0];
      const avail = item.samples.length - item.pos;
      const take  = Math.min(avail, n - pos);
      out.set(item.samples.subarray(item.pos, item.pos + take), pos);
      item.pos += take;
      pos += take;
      if (item.pos >= item.samples.length) this._audioQueue.shift();
    }
    if (pos < n) {
      const remaining = n - pos;
      const live = this._protocol.generateAudio(remaining);
      out.set(live.subarray(0, remaining), pos);
    }
    return out;
  }

  _drainQueue(n) {
    const out = new Float32Array(n);
    let pos = 0;
    while (pos < n && this._audioQueue.length > 0) {
      const item = this._audioQueue[0];
      const avail = item.samples.length - item.pos;
      const take  = Math.min(avail, n - pos);
      out.set(item.samples.subarray(item.pos, item.pos + take), pos);
      item.pos += take;
      pos += take;
      if (item.pos >= item.samples.length) this._audioQueue.shift();
    }
    return out;
  }

  _enqueue(samples) {
    this._audioQueue.push({ samples, pos: 0 });
  }

  _enqueueSilence(durationMs) {
    const n = Math.round(SR * durationMs / 1000);
    this._enqueue(new Float32Array(n));
  }

  // ─── Receive audio ───────────────────────────────────────────────────────

  receiveAudio(samples) {
    // Data mode: direct delegation.
    if (this._state === HS_STATE.DATA && this._protocol) {
      this._protocol.receiveAudio(samples);
      return;
    }
    // Training mode: also delegate so protocol's receiver can lock on
    // incoming carrier before we formally enter DATA state.
    if (this._state === HS_STATE.TRAINING && this._protocol) {
      this._protocol.receiveAudio(samples);
      // FSK probe discriminator: while V.21 or Bell103 is running as a
      // probe, also tally goertzel energy at the OTHER protocol's mark
      // frequency. Used by the CD-stable polling logic to reject false
      // positives — a Bell103 1270 Hz mark leaks into V.21's 1180 Hz
      // space filter (and vice versa, V.21's 980 Hz mark leaks into
      // Bell103's 1070 Hz space filter). Without this rejection,
      // whichever probe runs first wins regardless of the actual
      // caller protocol.
      if (this._fskDiscriminator) this._fskDiscriminator.process(samples);
      return;
    }

    // V.8 negotiation: delegate to the sequencer's RX path.
    if (this._state === HS_STATE.V8_NEGOTIATE && this._v8seq) {
      this._v8seq.receiveAudio(samples);
    }
  }

  // ─── Protocol selection and training ────────────────────────────────────

  /**
   * Advance to the next probe in `_probeQueue`. Called when a probe times
   * out without producing a stable carrier. Each probe instantiates a
   * fresh protocol instance, transmits the answer-side training signal,
   * and listens for the configured window. If all probes fail, emits
   * `handshake-failed` with reason `all-probes-failed`.
   *
   * Per V.25 legacy automode (and the implementation tip from the other
   * AI consult): every probe transition fully tears down the previous
   * protocol instance before starting the next. Otherwise the previous
   * demodulator could keep firing carrier-detect events from the new
   * probe's TX signal leaking into its passband, producing false
   * positives that lock us onto the wrong protocol.
   */
  _advanceProbe() {
    // Tear down any previous probe's protocol instance completely.
    if (this._protocol) {
      this._protocol.removeAllListeners();
      this._protocol = null;
      this._protocolName = null;
    }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._cdPollTimer) { clearInterval(this._cdPollTimer); this._cdPollTimer = null; }
    this._fskDiscriminator = null;

    if (!this._probeQueue || this._probeQueue.length === 0) {
      log.warn('Legacy automode probe chain exhausted — no protocol matched');
      this._state = HS_STATE.FAILED;
      this.emit('handshake-failed', { protocol: null, reason: 'all-probes-failed' });
      return;
    }

    const probe = this._probeQueue.shift();
    log.info(`Legacy probe: trying ${probe.protocol} (${probe.listenMs}ms listen window)`);
    this._selectProtocol(probe.protocol, probe.listenMs);
  }

  _selectProtocol(name, listenWindowMs) {
    log.info(`Selecting protocol: ${name}`);
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    this._protocolName = name;
    this._protocol = PROTOCOLS[name]
      ? PROTOCOLS[name](this._role)
      : PROTOCOLS['V21'](this._role);

    this._protocol.on('data', buf => this.emit('data', buf));

    this._state = HS_STATE.TRAINING;

    // V.22bis and V.22 drive their own handshake sequence — completion
    // is event-driven via the 'ready' event, not a fixed timer. During
    // the handshake phase, their generateAudio() emits spec-defined
    // training signals on its own. We just keep pulling audio until
    // the protocol fires 'ready'.
    if (name === 'V22bis' || name === 'V22') {
      log.debug(`${name} start-up — waiting for sequencer ready`);
      // V.22 and V.22bis now have a LISTEN phase between their TX training
      // sequence and declaring themselves "connected". They fire a
      // 'listening' event when they enter that phase and a 'remote-detected'
      // event if they see sustained RX energy from the other modem. Log
      // both so we can diagnose whether the far end is actually responding.
      if (this._protocol.on) {
        this._protocol.on('listening', () => {
          // Informational — the protocol module is accepting audio and
          // its TX generator is producing training signals. The module
          // keeps transmitting training until either the remote peer
          // responds (TRAINING_SUCCEEDED) or the listen window expires.
          log.info(`${name} sequencer running — listening for remote carrier`);
        });
        this._protocol.on('remote-detected', info => {
          log.info(`${name} remote carrier detected (rx RMS=${info.rms.toFixed(3)})`);
        });
      }
      this._protocol.once('ready', info => {
        // If the protocol supports remote detection and no remote carrier
        // was seen during the listen window, the handshake has FAILED.
        // Declaring "connected" and entering data mode in that case just
        // produces garbage — the real modem isn't on the other end of the
        // wire (or hasn't engaged), so any bytes we transmit go nowhere
        // and any bytes we "receive" are decoded noise.
        if (info.remoteDetected === false) {
          log.warn(`${name} handshake FAILED — no remote carrier detected during listen window`);
          this._handleProtocolFailure(name, 'no-remote-carrier');
          return;
        }

        this._state = HS_STATE.DATA;
        const tag = info.remoteDetected === true ? ' (remote detected)' : '';
        log.info(`Handshake complete — ${name} @ ${info.bps} bps${tag}`);
        // A successful connection clears the probe chain — we're done
        // probing.
        this._probeQueue = null;
        this.emit('connected', {
          protocol: name,
          bps:      info.bps,
          instance: this._protocol,
        });
      });
      return;
    }

    // Other protocols: fixed training duration from config.
    const trainMs = cfg.trainingDurationMs[name] || 600;
    log.debug(`Training for ${trainMs}ms`);

    const trainSamples = Math.round(SR * trainMs / 1000);
    if (trainSamples > 0) {
      const trainAudio = this._protocol.generateAudio
        ? this._protocol.generateAudio(trainSamples)
        : new Float32Array(trainSamples);
      this._enqueue(trainAudio);
    }

    // FSK probe discriminator: when V.21 or Bell103 is running as a
    // PROBE (i.e. we entered via the legacy automode chain after V.8
    // failed), install a running Goertzel discriminator that watches
    // the OTHER FSK protocol's primary frequency. The CD-stable
    // polling below will reject CD as false-positive if the
    // cross-protocol energy exceeds the in-band energy. Necessary
    // because biquad bandpass filters at the demod class's chosen Q
    // (=15) have ~80 Hz bandwidth, wide enough for each protocol's
    // caller-mark to leak into the other protocol's demodulator's CD
    // logic — without this, whichever probe runs first wins
    // regardless of the actual caller protocol.
    //
    // Only install when this is a probe in a legacy chain on the
    // answer side. The frequencies tracked are CALLER mark
    // frequencies (originate-side TX), which is what the answer-side
    // demodulator listens for. Originate-side or post-V.8 V.21 paths
    // don't need this — they're in known-good states.
    this._fskDiscriminator = null;
    const isAnswerSideProbe = (this._role === 'answer') &&
                              (this._probeQueue !== null && this._probeQueue !== undefined);
    if (isAnswerSideProbe) {
      if (name === 'V21') {
        // V.21 caller mark = 980 Hz. Cross-check: Bell103 caller mark
        // = 1270 Hz.
        this._fskDiscriminator = new FskDiscriminator(980, 1270);
      } else if (name === 'Bell103') {
        // Bell103 caller mark = 1270 Hz. Cross-check: V.21 caller
        // mark = 980 Hz.
        this._fskDiscriminator = new FskDiscriminator(1270, 980);
      }
    }

    // After the training burst, verify the remote end is actually there
    // and sending a stable carrier before declaring "connected".
    //
    // Previously we just waited trainMs+100ms and emitted 'connected'
    // unconditionally. That produced false positives in V.8-fallback:
    // after 15 s of failed V.8 negotiation there's often residual
    // noise / partial carrier on the line, our new V.21 demod might
    // briefly trip CD on it, and we'd declare success and enter DATA
    // mode to decode garbage.
    //
    // A stable-CD check is a simple but effective filter: a real V.21
    // peer in mark-idle (or sending data) holds CD continuously. Noise
    // or residual junk doesn't sustain it. If we require CD to stay
    // true for cdStableMs, we rule out brief noise trips without
    // rejecting real mark-idle (which emits no bytes but has CD
    // locked).
    //
    // If we don't see stable CD within listenWindowMs, emit
    // 'handshake-failed' so the upper layer can hang up / retry
    // rather than enter DATA mode on a phantom connection.
    const trainEndMs     = trainMs + 100;
    // Listen window: parameterized so the legacy automode probe chain
    // can specify per-protocol windows (e.g. 3000 ms for V.21 because
    // FSK lock is near-instant; 5000 ms for Bell103 to give vintage
    // hardware extra settling margin).
    const finalListenWindowMs = listenWindowMs != null ? listenWindowMs : 5000;
    const cdStableMs     = 500;
    const pollIntervalMs = 50;

    this._timer = setTimeout(() => {
      const pollStart = Date.now();
      let cdStableStart = null;

      const hasCD = () => {
        if (this._protocol && typeof this._protocol.carrierDetected !== 'undefined') {
          if (!this._protocol.carrierDetected) return false;
          // FSK discriminator — if installed, also require that the in-band
          // energy dominates the cross-protocol energy.
          if (this._fskDiscriminator && !this._fskDiscriminator.isInBand()) {
            return false;
          }
          return true;
        }
        return null;
      };

      // Protocols without CD support (e.g. V.32bis) keep the old
      // permissive behaviour so we don't regress them.
      if (hasCD() === null) {
        this._state = HS_STATE.DATA;
        log.info(`Handshake complete — ${name} @ ${this._protocol.bps || '?'} bps (no CD verification available)`);
        this._probeQueue = null;
        this.emit('connected', {
          protocol: name,
          bps:      this._protocol.bps || 0,
          instance: this._protocol,
        });
        return;
      }

      log.debug(`${name} TX training complete — waiting for stable remote carrier (≥${cdStableMs}ms CD within ${finalListenWindowMs}ms window)`);

      this._cdPollTimer = setInterval(() => {
        const now = Date.now();
        const cd  = hasCD();

        if (cd === true) {
          if (cdStableStart === null) cdStableStart = now;
        } else {
          if (cdStableStart !== null) {
            log.debug(`${name} CD dropped after ${now - cdStableStart}ms — restarting stability timer`);
          }
          cdStableStart = null;
        }

        const cdStableFor = cdStableStart !== null ? (now - cdStableStart) : 0;

        if (cdStableFor >= cdStableMs) {
          clearInterval(this._cdPollTimer);
          this._cdPollTimer = null;
          this._state = HS_STATE.DATA;
          log.info(`Handshake complete — ${name} @ ${this._protocol.bps || '?'} bps (CD stable for ${cdStableFor}ms)`);
          this._probeQueue = null;
          this.emit('connected', {
            protocol: name,
            bps:      this._protocol.bps || 0,
            instance: this._protocol,
          });
          return;
        }

        if (now - pollStart >= finalListenWindowMs) {
          clearInterval(this._cdPollTimer);
          this._cdPollTimer = null;
          log.warn(`${name} handshake FAILED — no stable remote carrier within ${finalListenWindowMs}ms (CD last held ${cdStableFor}ms, need ${cdStableMs}ms)`);
          this._handleProtocolFailure(name, 'no-stable-carrier');
        }
      }, pollIntervalMs);
    }, trainEndMs);
  }

  /**
   * A single probe (or forced protocol) failed to lock. If we are in the
   * middle of a legacy automode probe chain, advance to the next probe;
   * otherwise emit `handshake-failed` upward.
   */
  _handleProtocolFailure(protocolName, reason) {
    if (this._probeQueue && this._probeQueue.length > 0) {
      log.info(`${protocolName} probe failed (${reason}) — advancing to next probe`);
      this._advanceProbe();
      return;
    }
    if (this._probeQueue && this._probeQueue.length === 0) {
      // We were in a probe chain and just exhausted it.
      log.warn(`${protocolName} probe failed (${reason}) — chain exhausted`);
      this._state = HS_STATE.FAILED;
      this.emit('handshake-failed', { protocol: protocolName, reason: 'all-probes-failed' });
      return;
    }
    // Not in a probe chain — single forced/V.8-handed-off protocol failure.
    this._state = HS_STATE.IDLE;
    this.emit('handshake-failed', { protocol: protocolName, reason });
  }

  // ─── Data mode passthrough ──────────────────────────────────────────────

  write(data) {
    if (this._protocol) this._protocol.write(data);
  }

  get state()    { return this._state; }
  get protocol() { return this._protocolName; }
  get isData()   { return this._state === HS_STATE.DATA; }
}

module.exports = { HandshakeEngine, PROTOCOLS, FskDiscriminator };
