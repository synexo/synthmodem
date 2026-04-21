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
const {
  generateTone, generateANSam, goertzel, rms, mix
} = require('./Primitives');
const V8                  = require('./V8');
const { V21 }             = require('./protocols/V21');
const { Bell103 }         = require('./protocols/Bell103');
const { V22, V22bis }     = require('./protocols/V22');
const { V23, V32bis }     = require('./protocols/V32bis');
const { V32bisAnswerer }  = require('./V32bisAnswerer');
const { V34 }             = require('./protocols/V34');

const log = makeLogger('Handshake');
const SR  = config.rtp.sampleRate;
const cfg = config.modem;

// ─── Protocol registry ─────────────────────────────────────────────────────

const PROTOCOLS = {
  V21:     (role) => new V21(role),
  Bell103: (role) => new Bell103(role),
  V22:     (role) => new V22(role),
  V22bis:  (role) => new V22bis(role),
  V23:     (role) => new V23(role),
  V32bis:  (role) => new V32bis(role),
  V34:     (role) => new V34(role),
};

// ─── Detection constants ───────────────────────────────────────────────────

const ANS_FREQ = 2100;                  // ANS / ANSam
const DETECT_WINDOW_MS = 200;
const DETECT_SAMPLES   = Math.round(SR * DETECT_WINDOW_MS / 1000);
const DETECT_THRESHOLD = 0.03;

// V.8 timing (§8)
const TE_MS            = 1000;   // Te: pre-CM silence period (≥0.5s, 1s for echo cancel disable)
const POST_CJ_MS       = 80;     // post-CJ silence (75 ± 5 ms)
// V.8 timeout from ANSam start until we give up waiting for CM. Previously
// 5 s which was too short — with our 3.3 s ANSam, that left only 1.7 s
// for the modem to complete CM, but per RFC 4734 §2.3 the modem pauses
// ≥ 0.5 s AFTER ANSam detection (which itself may take 1 s+ for echo
// canceller disable), then CM ~500 ms, and we need ≥ 2 identical CMs.
// 15 s from ANSam start gives the modem ~12 s after ANSam ends to
// produce two CMs, matching real-modem timing (total negotiation
// typically takes 10-15 s).
const V8_RESPONSE_TIMEOUT_MS = 15000;

// ─── State machine ─────────────────────────────────────────────────────────

const HS_STATE = {
  IDLE:        'IDLE',
  ANS_SEND:    'ANS_SEND',
  V32_AC_SEND: 'V32_AC_SEND', // V.32bis forced: tx AC (600+3000 Hz), listen for caller AA at 1800 Hz
  V8_WAIT:     'V8_WAIT',      // Waiting for ANSam (originate) or CI/CM (answer)
  V8_CM_TX:    'V8_CM_TX',     // Call side: transmitting CM, waiting for JM
  V8_JM_TX:    'V8_JM_TX',     // Answer side: transmitting JM, waiting for CJ
  V8_POST_CJ:  'V8_POST_CJ',   // 75 ms silence window before sigA/sigC
  TRAINING:    'TRAINING',     // Protocol-specific training
  DATA:        'DATA',
  FAILED:      'FAILED',
};

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
    this._detectBuf     = [];
    this._timer         = null;
    this._forced        = cfg.forceProtocol;
    // Sample-accurate transition flag. When set (non-null) and state
    // is ANS_SEND, generateAudio() drains the queue then immediately
    // calls _selectProtocol(this._pendingForcedProtocol) with ZERO
    // silence gap. See generateAudio() for rationale.
    this._pendingForcedProtocol = null;

    // V.21 modems used for V.8 signalling. Separate from the data-path
    // protocol modem (which is set up later via _selectProtocol).
    //   _v8Signaller: the V.21 codec we use for V.8 TX (CI/CM/CJ on call,
    //                 JM on answer) and RX of remote V.8 messages.
    // For call (originate): TX on ch1 (originate), RX on ch2 (answer).
    // For answer:           TX on ch2 (answer),   RX on ch1 (originate).
    // Both sides listen to the OPPOSITE channel, so RX of remote V.8:
    //   - Call (us=originate) listens for JM on ch2 (answer's TX)
    //   - Answer (us=answer)  listens for CI/CM on ch1 (originate's TX)
    this._v8 = null;            // V21 instance for V.8 signalling
    this._v8Parser = {};        // parseV8Bytes state (accumulating buffer)
    this._lastV8Msg = null;     // last decoded V.8 message (for dedup)
    this._remoteModesSeen = null;
    this._remoteCallFn = null;          // last-seen CM call function
    this._remoteModesMerged = {};       // union of modes across repeated CMs

    // Track number of CMs seen — V.8 §7.4 requires ≥2 before starting
    // JM. We relax "identical" to "same call function" because real
    // CMs in a continuous stream sometimes decode with slightly
    // different mode bits due to occasional UART byte-drops.
    this._cmRepeatCount = 0;
    this._jmRepeatCount = 0;

    // For originate: restrict what we advertise in CM (useful for testing).
    if (cfg.advertiseProtocol && this._role === 'originate') {
      this._advertise = [cfg.advertiseProtocol];
    }
  }

  // ─── Start / stop ────────────────────────────────────────────────────────

  start() {
    this._state = HS_STATE.IDLE;
    log.info(`Handshake starting (${this._role})`);

    // Create V.21 modem for V.8 signalling. Role follows ours.
    this._v8 = PROTOCOLS['V21'](this._role);
    this._v8.on('data', buf => this._onV8Byte(buf));

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
        // USB1 in the high channel after a short silence. The call
        // modem is in "silent listening" mode during this gap — it's
        // waiting to detect USB1 but not transmitting. If the gap is
        // too long, the call modem's "no signal from answerer" timer
        // will expire and it abandons the call.
        //
        // V.25 specifies Ta = 75 ms between ANS end and data signal
        // start. Previously we used 2500 ms for V.22/V.22bis based on
        // misobservation of V.21 behaviour — that caused the call
        // modem to time out and start generating its own unrelated
        // 1800 Hz tone (observed in captures) instead of waiting for
        // USB1. Use a short Ta (~75 ms) to match V.22 spec.
        //
        // For V.21 forced path keep TE_MS (1000 ms) which has been
        // verified working.
        const teMs = (this._forced === 'V22' || this._forced === 'V22bis'
                   || this._forced === 'V32bis')
          ? 75
          : TE_MS;

        // For FORCED protocol mode we bypass V.8 entirely. Critical:
        // we must send PLAIN V.25 ANS (2100 Hz, no 15 Hz AM modulation)
        // — NOT ANSam. The 15 Hz envelope in ANSam is how a V.8-capable
        // modem identifies a V.8-capable peer; seeing it, the caller
        // will send CM and wait for JM. If we then never respond with
        // JM (because we're forced to V.21/V.22/V.22bis and skip V.8),
        // the caller times out and gives up before we start training.
        //
        // Plain ANS (no AM, no phase reversals) tells the caller "legacy
        // V.25 answerer", which the modem handles by proceeding to its
        // configured modulation mode (V.21 / V.22 / V.22bis) without
        // V.8 negotiation — exactly what we want.
        // After ANS + 75 ms Te silence, spandsp transmits USB1
        // (unscrambled binary 1 at 1200 bps) as the V.22 answerer's
        // training signal. Per V.22bis §6.3.1.1.2.a this is the correct
        // first signal from the answering modem.
        //
        // IMPORTANT INTERACTION WITH V.32 AUTOMODE CALLERS:
        // When a modern V.32-capable modem hears our plain ANS, it goes
        // into automode and transmits continuous 1800 Hz Signal AA
        // while listening for one of {1300 Hz, 1650 Hz, AC, USB1}.
        //   - 1300 Hz = V.23 answerback
        //   - 1650 Hz = V.21 answer channel
        //   - AC      = V.32 Signal AC (600+3000 Hz)
        //   - USB1    = V.22bis unscrambled binary 1 (our U11 from spandsp)
        // If the caller detects USB1, it drops V.32 automode and proceeds
        // as a V.22 originator.
        //
        // The 1800 Hz AA, however, leaks into spandsp's 1200 Hz RX
        // bandpass filter and causes power-meter oscillation in the
        // carrier_on/off hysteresis band. Each oscillation fires
        // v22bis_restart() which resets tx.training back to
        // INITIAL_TIMED_SILENCE — so our USB1 TX dies within ~800 ms
        // and the caller never sees it. The caller then stays in V.32
        // automode forever.
        //
        // The fix for that is in V22.js `_gateIfV32AA` — while the RX
        // contains dominant 1800 Hz, we feed spandsp silence so its TX
        // state machine stays in U11 (USB1). The caller then sees USB1,
        // switches to V.22 originator, stops sending AA, and normal
        // negotiation proceeds.
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
        //
        // Instead, we set a flag that generateAudio() checks each block.
        // When the audio queue drains (sample-accurate because TX
        // samples are consumed by the RTP clock), the generator
        // immediately calls _selectProtocol(). No jitter, no gap.
        this._pendingForcedProtocol = this._forced;
      } else {
        this._selectProtocol(this._forced);
      }
      return;
    }

    if (this._role === 'answer') {
      // Answer tone delay per config (V.25 §3.1 allows 1.8-2.5 seconds
      // after off-hook, but shorter delays work for most modems and
      // this is what the known-working autonegotiate path used).
      this._timer = setTimeout(() => this._sendAnswerTone(), cfg.answerToneDelayMs);
    } else {
      this._sendCI();
    }
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
    if (this._v8) {
      this._v8.removeAllListeners();
      this._v8 = null;
    }
  }

  // ─── Audio generation ────────────────────────────────────────────────────

  generateAudio(n) {
    // Data mode: full delegation to protocol.
    if (this._state === HS_STATE.DATA && this._protocol) {
      return this._protocol.generateAudio(n);
    }

    // V.32bis drives its own training audio live during TRAINING state.
    // Other protocols use a fixed pre-enqueued training burst.
    if (this._state === HS_STATE.TRAINING && this._protocol &&
        this._protocolName === 'V32bis') {
      return this._protocol.generateAudio(n);
    }

    // V.8 signalling states: mix the audio queue (for ANSam, pre-CM silence)
    // with V.21 modulator output (for CI/CM/JM/CJ).
    if (this._state === HS_STATE.V8_CM_TX || this._state === HS_STATE.V8_JM_TX) {
      // V.8 FSK audio is the primary signal; no tone queue content here
      // once V.8 tx is running. But the audio queue may still have residual
      // ANSam or Te silence — draining it first.
      const queued = this._drainQueue(n);
      // If the queued block is entirely silence, replace with V.21 audio.
      // Otherwise add them (ANSam may overlap CI reception briefly).
      let hasNonSilence = false;
      for (let i = 0; i < queued.length; i++) {
        if (queued[i] !== 0) { hasNonSilence = true; break; }
      }
      if (hasNonSilence) return queued;
      return this._v8.generateAudio(n);
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
        // V.32bis gets an extra step: AC/AA handshake before V.17 training.
        // See _onV32AcSend handling below. For other protocols we go
        // straight to training (the original path).
        if (forced === 'V32bis') {
          this._startV32AcSend();
          if (this._state === HS_STATE.V32_AC_SEND) {
            const remaining = n - pos;
            const live = this._generateV32Ac(remaining);
            out.set(live.subarray(0, remaining), pos);
          }
        } else {
          this._selectProtocol(forced);
          if (this._protocol && this._protocol.generateAudio) {
            const remaining = n - pos;
            const live = this._protocol.generateAudio(remaining);
            out.set(live.subarray(0, remaining), pos);
          }
        }
      }
      return out;
    }

    // V32_AC_SEND state: transmit V.32 Signal AC continuously while we
    // listen for caller's AA on 1800 Hz. See _startV32AcSend.
    if (this._state === HS_STATE.V32_AC_SEND) {
      return this._generateV32Ac(n);
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
      return;
    }

    // V.32bis AC-send state: process RX looking for caller AA at 1800 Hz
    // + phase reversal. See _processV32AaRx.
    if (this._state === HS_STATE.V32_AC_SEND) {
      this._processV32AaRx(samples);
      return;
    }

    // V.8 signalling states: feed V.21 demodulator to decode incoming CI/CM/JM/CJ.
    if (this._state === HS_STATE.V8_WAIT || this._state === HS_STATE.V8_CM_TX ||
        this._state === HS_STATE.V8_JM_TX || this._state === HS_STATE.ANS_SEND) {
      if (this._v8) this._v8.receiveAudio(samples);
    }

    // Also run amplitude-based detection for ANSam (on originate side).
    for (const s of samples) this._detectBuf.push(s);
    if (this._detectBuf.length >= DETECT_SAMPLES) {
      this._runDetection();
    }
  }

  _runDetection() {
    const buf = new Float32Array(this._detectBuf.splice(0, DETECT_SAMPLES));
    // Originate: listening for ANSam during V8_WAIT.
    if (this._role === 'originate' &&
        (this._state === HS_STATE.V8_WAIT || this._state === HS_STATE.ANS_SEND)) {
      this._detectANSam(buf);
    }
  }

  // ─── V.8 message handler (decoded from V.21 byte stream) ─────────────────

  _onV8Byte(buf) {
    // buf: Buffer of bytes decoded by V.21 UART demodulator.
    // Feed to V.8 byte-level parser.
    const msgs = V8.parseV8Bytes(this._v8Parser, buf);
    for (const m of msgs) this._handleV8Message(m);
  }

  _handleV8Message(msg) {
    log.debug(`V.8 RX: ${msg.type}` +
              (msg.modes ? ' modes=' + this._summarizeModes(msg.modes) : '') +
              (msg.callFn !== undefined ? ' callFn=' + msg.callFn : ''));

    if (this._role === 'answer') {
      // Answer side state machine.
      if (msg.type === 'CM/JM' && (this._state === HS_STATE.ANS_SEND ||
                                    this._state === HS_STATE.V8_WAIT ||
                                    this._state === HS_STATE.V8_JM_TX)) {
        // Reject CMs that advertise no modulation modes at all — these
        // are almost certainly garbage decodes caused by noise or echo.
        if (!this._hasAnyMode(msg.modes)) {
          log.debug('V.8: ignoring CM with no modulation modes (likely noise)');
          return;
        }
        // V.8 §5.2 nominally requires ≥2 identical CMs before replying
        // with JM. The purpose of that rule is to ensure the calling
        // DCE has really committed to a CM (and isn't still mid-stream
        // with a partially-received message).
        //
        // Our byte-level V.8 parser has a correctness floor: V.8 octets
        // are framed as V.21 UART frames (start + 8 data + stop) and
        // occasionally UART phase drifts across many back-to-back
        // octets, dropping or mis-decoding some of the CM stream. In
        // observed real-modem captures we reliably decode E0 C1 CM
        // starts but only ~1-4 full CMs in a 10-second CM burst.
        //
        // Pragmatic relaxation: accept ANY single CM that:
        //   (a) has valid call function
        //   (b) advertises at least one real modulation mode
        //   (c) repeats a second time with the SAME call function
        //       OR is accepted after a grace period even without repeat
        //
        // The CM's internal structure (sync byte + call-fn byte with
        // low-5-bits = 0x01 + at least one valid mod-mode byte) is
        // already sanity-checked inside parseV8Bytes(). If it passes
        // that, it's overwhelmingly likely to be a real CM.
        if (this._remoteCallFn === msg.callFn) {
          this._cmRepeatCount++;
          for (const k of Object.keys(msg.modes)) {
            if (msg.modes[k]) this._remoteModesMerged[k] = true;
          }
        } else {
          this._remoteCallFn    = msg.callFn;
          this._remoteModesMerged = { ...msg.modes };
          this._cmRepeatCount   = 1;
          // First CM seen with this call function. Schedule a grace-period
          // acceptance: if we haven't seen a second CM within 2 seconds,
          // accept this single CM anyway — our lossy byte parser often
          // drops the second CM, and without this we'd time out waiting
          // for a CM we already decoded.
          if (!this._cmGraceTimer) {
            this._cmGraceTimer = setTimeout(() => {
              this._cmGraceTimer = null;
              if (this._state === HS_STATE.V8_WAIT ||
                  this._state === HS_STATE.ANS_SEND) {
                log.info(`V.8: single CM (callFn=${this._remoteCallFn}) grace-period elapsed, starting JM with merged modes`);
                this._startJM(this._remoteModesMerged);
              }
            }, 2000);
          }
        }
        if (this._cmRepeatCount >= 2 && this._state !== HS_STATE.V8_JM_TX) {
          if (this._cmGraceTimer) {
            clearTimeout(this._cmGraceTimer);
            this._cmGraceTimer = null;
          }
          log.info(`V.8: ≥2 CM with matching callFn=${msg.callFn} received, starting JM transmission`);
          this._startJM(this._remoteModesMerged);
        }
        return;
      }
      if (msg.type === 'CJ' && this._state === HS_STATE.V8_JM_TX) {
        log.info('V.8: CJ detected, completing handshake');
        this._completeV8();
        return;
      }
    } else {
      // Originate side state machine.
      if (msg.type === 'CM/JM' && this._state === HS_STATE.V8_CM_TX) {
        if (!this._hasAnyMode(msg.modes)) {
          log.debug('V.8: ignoring JM with no modulation modes (likely noise)');
          return;
        }
        // Received JM from answer side. Need ≥2 identical.
        const key = JSON.stringify(msg.modes);
        if (this._remoteModesSeen === key) {
          this._jmRepeatCount++;
        } else {
          this._remoteModesSeen = key;
          this._jmRepeatCount = 1;
        }
        if (this._jmRepeatCount >= 2) {
          log.info('V.8: ≥2 identical JM received, sending CJ');
          this._startCJ(msg.modes);
        }
        return;
      }
    }
  }

  _hasAnyMode(modes) {
    if (!modes) return false;
    return !!(modes.v34 || modes.v34hd || modes.v32bis || modes.v22bis ||
              modes.v17 || modes.v29hd || modes.v27ter ||
              modes.v26ter || modes.v26bis || modes.v23 || modes.v23hd ||
              modes.v21);
  }

  _summarizeModes(modes) {
    if (!modes) return '{}';
    const on = Object.keys(modes).filter(k => modes[k] === true);
    return '{' + on.join(',') + '}';
  }

  // ─── Answer mode: send ANSam ─────────────────────────────────────────────

  _sendAnswerTone() {
    this._state = HS_STATE.ANS_SEND;
    log.debug(`Sending ${cfg.useANSam ? 'ANSam' : 'ANS'} tone`);

    if (cfg.useANSam) {
      // Peak amplitude 0.15 (~-10 dBm0 in PCMU). Previously 0.45
      // (+3 dBm0) which is 15+ dB too hot and can clip codec AM peaks.
      this._enqueue(generateANSam(
        cfg.answerToneDurationMs,
        SR,
        cfg.answerTonePhaseReversalMs,
        0.15
      ));
    } else {
      // Plain ANS = 2100 Hz steady.
      this._enqueue(generateTone(ANS_FREQ, cfg.answerToneDurationMs, SR, 0.15));
    }

    if (cfg.enableV8) {
      this._state = HS_STATE.V8_WAIT;
      log.debug(`V.8 enabled — listening for CM on V.21(L) while sending ANSam (timeout ${V8_RESPONSE_TIMEOUT_MS} ms)`);
      this._timer = setTimeout(() => this._v8Timeout(), V8_RESPONSE_TIMEOUT_MS);
    } else {
      // After tone finishes, Te silence (V.8 §5.2.1 ≥500ms, 1000ms recommended)
      // then start legacy fallback.
      this._enqueueSilence(TE_MS);
      this._timer = setTimeout(() => {
        log.debug('V.8 disabled — falling through to protocol preference');
        this._selectProtocol(cfg.protocolPreference[0]);
      }, cfg.answerToneDurationMs + TE_MS);
    }
  }

  // ─── Originate: send CI + wait for ANSam ────────────────────────────────

  _sendCI() {
    this._state = HS_STATE.V8_WAIT;
    log.debug('Sending V.8 CI on V.21(L) channel 1 (originate FSK)');

    // V.8 CI is a V.21(L) FSK transmission of sync byte + call-function byte.
    // We queue the bytes through the V.21 modulator — it will UART-frame each
    // byte, which matches V.8's octet framing requirement. The "10 ones"
    // idle prefix happens naturally as V.21 marking between octets.
    //
    // Cadence: §7.1 says ON periods ≥ 3 full CI sequences (≥ 0.5 s at 300
    // bps, 30 bits each), OFF periods 0.4-2 s. We repeat CI continuously
    // with short silences until ANSam is detected.
    const ciBytes = V8.buildCIBytes();
    this._ciRepeatTimer = setInterval(() => {
      if (this._state !== HS_STATE.V8_WAIT) {
        clearInterval(this._ciRepeatTimer);
        this._ciRepeatTimer = null;
        return;
      }
      // Send 3 CI sequences back-to-back, then a brief silence (enforced
      // by marking idle while V.21 bit queue is empty).
      this._writeV8Message(Buffer.concat([ciBytes, ciBytes, ciBytes]));
    }, 600);
    // Fire the first batch immediately too.
    this._writeV8Message(Buffer.concat([ciBytes, ciBytes, ciBytes]));

    this._timer = setTimeout(() => this._v8Timeout(), V8_RESPONSE_TIMEOUT_MS);
  }

  _detectANSam(buf) {
    const ansPower = goertzel(buf, ANS_FREQ, SR);
    if (ansPower > DETECT_THRESHOLD) {
      this._ansDetectCount = (this._ansDetectCount || 0) + 1;
      if (this._ansDetectCount >= 3) {
        log.info('V.8: ANSam detected — stopping CI, Te silence, then sending CM');
        if (this._ciRepeatTimer) {
          clearInterval(this._ciRepeatTimer);
          this._ciRepeatTimer = null;
        }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        // Te silence before CM (§8.1.1): ≥ 0.5 s, 1 s for echo-canceller disable.
        this._enqueueSilence(TE_MS);
        setTimeout(() => this._sendCM(), TE_MS);
      }
    } else {
      this._ansDetectCount = 0;
    }
  }

  // ─── Originate: send CM, wait for JM ────────────────────────────────────

  _sendCM() {
    this._state = HS_STATE.V8_CM_TX;
    const modes = this._buildCapabilityModes();
    log.debug('V.8 CM: sending ' + this._summarizeModes(modes));

    const cmBytes = V8.buildCMBytes(modes);
    // Repeat CM continuously until JM detected. V.8 §7.4 requires answer
    // to see ≥2 identical CMs. We send 4 repetitions up front, then more
    // on a timer if JM hasn't arrived. Leading mark bits give the remote
    // demod time to lock onto our carrier before the first start bit.
    this._writeV8Message(Buffer.concat([cmBytes, cmBytes, cmBytes, cmBytes]));

    this._cmRepeatTimer = setInterval(() => {
      if (this._state !== HS_STATE.V8_CM_TX) {
        clearInterval(this._cmRepeatTimer);
        this._cmRepeatTimer = null;
        return;
      }
      this._writeV8Message(cmBytes);
    }, 250);  // one extra CM every 250ms

    this._timer = setTimeout(() => this._v8Timeout(), V8_RESPONSE_TIMEOUT_MS);
  }

  /**
   * Write a V.8 message batch to the V.21 modulator, prefixing it with
   * the 10-bit marking-idle preamble required by V.8 §5. Each bit lasts
   * ~3.33 ms at 300 bps, so 10 mark bits = 33 ms of pure carrier before
   * the first start bit — this lets the remote demod's bit-timing
   * recovery lock on cleanly.
   */
  _writeV8Message(bytes) {
    if (!this._v8) return;
    // Ten ones = V.8 §5 preamble. If the modem supports writeBits we use
    // it; otherwise fall through to a plain write (which relies on the
    // V.21 modulator emitting mark idle between bytes).
    if (typeof this._v8.writeBits === 'function') {
      const preamble = new Array(10).fill(1);
      this._v8.writeBits(preamble);
    }
    this._v8.write(bytes);
  }

  // ─── Answer: send JM, wait for CJ ────────────────────────────────────────

  _startJM(remoteModes) {
    this._state = HS_STATE.V8_JM_TX;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    // JM per V.8 §7.4: include modulation modes that are BOTH in the
    // remote CM and available locally — a strict set intersection.
    //
    // When the intersection is non-empty (e.g. remote has V.22bis and
    // we have V.22bis locally), JM advertises the common modes and the
    // originator then picks one and proceeds with CJ + training for
    // that modulation. This is the path we want for V.22/V.22bis.
    //
    // When the intersection is EMPTY (e.g. remote only offered V.34+PCM
    // which we don't support), JM contains all zeros. Per §7.4 this is
    // the spec-conformant "no deal" signal: the originator recognises
    // an empty modulation category and falls back to a legacy
    // modulation (typically V.21) without further V.8 negotiation.
    // An earlier attempt to offer our local capabilities as an
    // "alternative" when the intersection was empty caused real V.34
    // modems to stop listening partway through our JM repeats — the
    // modes we advertised (v22bis/v21) weren't in the CM so the modem
    // treated the JM as malformed. The empty-JM cleardown is what
    // produced reliable V.21 fallback historically, so we keep it.
    const localModes = this._buildCapabilityModes();
    const jmModes = {};
    const modeKeys = ['v34','v34hd','v32bis','v22bis','v17','v29hd','v27ter',
                      'v26ter','v26bis','v23','v23hd','v21','pcm'];
    for (const k of modeKeys) {
      jmModes[k] = !!(remoteModes[k] && localModes[k]);
    }
    log.debug('V.8 JM: sending ' + this._summarizeModes(jmModes));

    // Save negotiated modes for protocol selection after CJ.
    this._negotiatedModes = jmModes;

    const jmBytes = V8.buildJMBytes(jmModes);
    // Repeat JM continuously until CJ detected.
    this._writeV8Message(Buffer.concat([jmBytes, jmBytes, jmBytes, jmBytes]));

    this._jmRepeatTimer = setInterval(() => {
      if (this._state !== HS_STATE.V8_JM_TX) {
        clearInterval(this._jmRepeatTimer);
        this._jmRepeatTimer = null;
        return;
      }
      this._writeV8Message(jmBytes);
    }, 250);

    this._timer = setTimeout(() => this._v8Timeout(), V8_RESPONSE_TIMEOUT_MS);
  }

  // ─── Originate: send CJ, post-CJ silence, then modulation ───────────────

  _startCJ(jmModes) {
    this._state = HS_STATE.V8_POST_CJ;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._cmRepeatTimer) { clearInterval(this._cmRepeatTimer); this._cmRepeatTimer = null; }

    // Select the highest-preference protocol from jmModes.
    const chosen = V8.selectProtocol(jmModes, cfg.protocolPreference);
    if (!chosen) {
      log.warn('V.8: no common protocol in JM — aborting');
      this._v8Timeout();
      return;
    }
    log.info(`V.8: selected ${chosen} based on JM ${this._summarizeModes(jmModes)}`);

    // Send CJ (three zero octets) then 75 ms silence then modulation.
    const cjBytes = V8.buildCJBytes();
    this._v8.write(cjBytes);

    // Schedule the switch to the modulation's originate-side training.
    // We need ~30ms for CJ transmission (3 bytes × 10 bits × 3.33ms each
    // = 100ms at 300 bps), then 75ms silence.
    setTimeout(() => this._selectProtocol(chosen), 100 + POST_CJ_MS);
  }

  _completeV8() {
    // Answer side post-CJ completion.
    this._state = HS_STATE.V8_POST_CJ;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._jmRepeatTimer) { clearInterval(this._jmRepeatTimer); this._jmRepeatTimer = null; }

    const chosen = V8.selectProtocol(this._negotiatedModes || {}, cfg.protocolPreference);
    if (!chosen) {
      log.warn('V.8: no protocol selected — aborting');
      this._v8Timeout();
      return;
    }
    log.info(`V.8: selected ${chosen} (answer side)`);

    // 75 ms post-CJ silence, then start modulation.
    this._enqueueSilence(POST_CJ_MS);
    setTimeout(() => this._selectProtocol(chosen), POST_CJ_MS);
  }

  _v8Timeout() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._ciRepeatTimer) { clearInterval(this._ciRepeatTimer); this._ciRepeatTimer = null; }
    if (this._cmRepeatTimer) { clearInterval(this._cmRepeatTimer); this._cmRepeatTimer = null; }
    if (this._jmRepeatTimer) { clearInterval(this._jmRepeatTimer); this._jmRepeatTimer = null; }
    const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
    log.warn(`V.8 handshake timeout — falling back to ${fallback}`);
    this._selectProtocol(fallback);
  }

  // ─── Build capability modes from config ─────────────────────────────────

  _buildCapabilityModes() {
    const advertised = this._advertise || cfg.v8ModulationModes || cfg.protocolPreference;
    return {
      v34:    advertised.includes('V34'),
      v34hd:  false,
      v32bis: advertised.includes('V32bis'),
      v22bis: advertised.includes('V22bis') || advertised.includes('V22'),
      v17:    advertised.includes('V17'),
      v29hd:  false,
      v27ter: false,
      v26ter: false,
      v26bis: false,
      v23:    advertised.includes('V23'),
      v23hd:  false,
      v21:    advertised.includes('V21'),
      pcm:    false,   // We don't implement V.90/V.92 yet.
    };
  }


  // ─── V.32bis answer-mode call-establishment (ITU-T V.32bis §5.2) ────────
  //
  // Delegates to the V32bisAnswerer class which implements the full
  // answer-side signal sequence: AC/CA/AC handshake → S (ABAB) → S−
  // (CDCD) → TRN → R1 → (wait for caller R2) → S → S− → TRN → R3 →
  // (wait for caller E) → E → handoff to V.17 TX for B1 data phase.
  //
  // The answerer exposes events the Handshake engine subscribes to:
  //   'phase' { from, to } — transition events for logging
  //   'done'  { rate }     — handshake complete; time to start B1 data phase
  //
  // Timeout: if the sequencer doesn't reach 'done' within V32_TIMEOUT_MS,
  // the Handshake engine fails out.

  _startV32AcSend() {
    log.info('V.32bis answer-mode call-establishment — starting sequencer');
    this._state = HS_STATE.V32_AC_SEND;

    this._v32Answerer = new V32bisAnswerer({
      log: {
        info:  (msg, ...rest) => log.info(msg, ...rest),
        warn:  (msg, ...rest) => log.warn(msg, ...rest),
        trace: (msg, ...rest) => log.trace ? log.trace(msg, ...rest) : null,
      },
      amp: 0.20,
    });
    this._v32Answerer.on('done', info => {
      // Handshake signaling complete; hand off to V.17 for B1 data phase
      // at the agreed rate. We use spandsp's V.17 TX via the existing
      // V32bis protocol binding for the actual data modulation.
      log.info(`V.32bis signaling complete (rate=${info.rate}) — handing off to V.17 for B1 data phase`);
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._selectProtocol('V32bis');
    });
    this._v32Answerer.on('failed', info => {
      log.warn(`V.32bis sequencer failed: reason=${info.reason} — falling back to V.22bis`);
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this._state !== HS_STATE.V32_AC_SEND) return;
      // Clean up V.32bis answerer so it stops generating audio.
      this._v32Answerer = null;
      // Top-down fallback: V.32bis failed → drop tier to V.22bis. The
      // caller modem may be a V.22bis modem that ignored our 1800 Hz AC
      // probe (it doesn't speak V.32), or a V.32 modem that couldn't
      // complete training. Either way, V.22bis is the next-best option;
      // if it also fails the engine will emit handshake-failed.
      log.info('Fallback: selecting V.22bis');
      this._state = HS_STATE.TRAINING;
      this._selectProtocol('V22bis');
    });

    // Failsafe timeout. Real caller may take up to 3s to start AA after
    // our AC begins (per empirical observation from capture). Full
    // sequence from AA-lock onward adds ~2 more seconds. Use 20s to
    // give comfortable margin for slow-responding callers.
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const TIMEOUT_MS = 20000;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._state !== HS_STATE.V32_AC_SEND) return;
      const phase = this._v32Answerer ? this._v32Answerer.phase() : '?';
      log.warn(`V.32bis call-establishment timed out (${TIMEOUT_MS} ms) in phase=${phase} — falling back to V.22bis`);
      this._v32Answerer = null;
      log.info('Fallback: selecting V.22bis');
      this._state = HS_STATE.TRAINING;
      this._selectProtocol('V22bis');
    }, TIMEOUT_MS);
  }

  _generateV32Ac(n) {
    if (!this._v32Answerer) return new Float32Array(n);
    return this._v32Answerer.generate(n);
  }

  _processV32AaRx(samples) {
    if (!this._v32Answerer) return;
    this._v32Answerer.process(samples);
  }


  // ─── Protocol selection and training ────────────────────────────────────

  _selectProtocol(name) {
    log.info(`Selecting protocol: ${name}`);
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    this._protocolName = name;
    this._protocol = PROTOCOLS[name]
      ? PROTOCOLS[name](this._role)
      : PROTOCOLS['V21'](this._role);

    this._protocol.on('data', buf => this.emit('data', buf));

    if (name === 'V34' && this._protocol.startHandshake) {
      this._protocol.startHandshake();
    }

    this._state = HS_STATE.TRAINING;

    // V.32bis, V.22bis, and V.22 drive their own handshake sequence —
    // completion is event-driven via the 'ready' event, not a fixed
    // timer. During the handshake phase, their generateAudio() emits
    // spec-defined training signals on its own. We just keep pulling
    // audio until the protocol fires 'ready'.
    if (name === 'V32bis' || name === 'V22bis' || name === 'V22') {
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
          this._state = HS_STATE.IDLE;
          this.emit('handshake-failed', {
            protocol: name,
            reason:   'no-remote-carrier',
          });
          return;
        }

        this._state = HS_STATE.DATA;
        const tag = info.remoteDetected === true ? ' (remote detected)' : '';
        log.info(`Handshake complete — ${name} @ ${info.bps} bps${tag}`);
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
    const listenWindowMs = 5000;
    const cdStableMs     = 500;
    const pollIntervalMs = 50;

    this._timer = setTimeout(() => {
      const pollStart = Date.now();
      let cdStableStart = null;

      const hasCD = () => {
        if (this._protocol && typeof this._protocol.carrierDetected !== 'undefined') {
          return !!this._protocol.carrierDetected;
        }
        return null;
      };

      // Protocols without CD support (e.g. V.32bis) keep the old
      // permissive behaviour so we don't regress them.
      if (hasCD() === null) {
        this._state = HS_STATE.DATA;
        log.info(`Handshake complete — ${name} @ ${this._protocol.bps || '?'} bps (no CD verification available)`);
        this.emit('connected', {
          protocol: name,
          bps:      this._protocol.bps || 0,
          instance: this._protocol,
        });
        return;
      }

      log.debug(`${name} TX training complete — waiting for stable remote carrier (≥${cdStableMs}ms CD within ${listenWindowMs}ms window)`);

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
          this.emit('connected', {
            protocol: name,
            bps:      this._protocol.bps || 0,
            instance: this._protocol,
          });
          return;
        }

        if (now - pollStart >= listenWindowMs) {
          clearInterval(this._cdPollTimer);
          this._cdPollTimer = null;
          log.warn(`${name} handshake FAILED — no stable remote carrier within ${listenWindowMs}ms (CD last held ${cdStableFor}ms, need ${cdStableMs}ms)`);
          this._state = HS_STATE.IDLE;
          this.emit('handshake-failed', {
            protocol: name,
            reason:   'no-stable-carrier',
          });
        }
      }, pollIntervalMs);
    }, trainEndMs);
  }

  // ─── Data mode passthrough ──────────────────────────────────────────────

  write(data) {
    if (this._protocol) this._protocol.write(data);
  }

  get state()    { return this._state; }
  get protocol() { return this._protocolName; }
  get isData()   { return this._state === HS_STATE.DATA; }
}

module.exports = { HandshakeEngine, PROTOCOLS };
