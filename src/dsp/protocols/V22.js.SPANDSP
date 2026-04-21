'use strict';

/**
 * V.22 / V.22bis — native-backed via vendored spandsp.
 *
 * This file replaces the previous pure-JS V.22 / V.22bis implementation
 * (which was known-broken). The new implementation delegates all DSP work
 * to a compiled N-API addon (`build/Release/synthmodem_v22.node`) that
 * wraps spandsp's `v22bis` data pump — a well-tested, battle-hardened
 * implementation used by many PSTN/softphone stacks.
 *
 * Public API
 * ----------
 *
 * Both classes (V22, V22bis) preserve the exact contract the rest of the
 * codebase expects (see Handshake.js and ModemDSP.js):
 *
 *   new V22(role)  /  new V22bis(role)      // role: 'answer' | 'originate'
 *
 *   .write(Buffer)                          // queue bytes for TX
 *   .generateAudio(nSamples) → Float32Array // pull TX audio
 *   .receiveAudio(Float32Array)             // push RX audio
 *   .get name()                             // 'V22' or 'V22bis'
 *   .get bps()                              // current operating speed
 *   .get carrierDetected()                  // convenience accessor
 *
 * Events:
 *   'data'              (Buffer)         — decoded RX bytes
 *   'listening'         ()               — informational; fires immediately
 *                                           since the native modem begins
 *                                           TX training the instant it's
 *                                           created.
 *   'remote-detected'   ({ rms })        — far-end carrier detected
 *   'ready'             ({ bps,
 *                         remoteDetected:
 *                           true|false }) — training complete; emitted
 *                                           ONCE. If remoteDetected is
 *                                           false the upper layer treats
 *                                           this as a handshake failure.
 *
 * Sample format
 * -------------
 * The rest of the pipeline uses Float32Array in the ±1.0 range. spandsp
 * uses int16_t in the ±32767 range. We convert at the boundary. Native
 * spandsp V.22bis TX produces samples with typical peak around 8000
 * on the int16 scale (roughly -12 dBm0). After normalising to ±1.0 this
 * is a peak of ~0.24 — comparable to the old JS V.22 amplitude and a
 * safe level for G.711 µ-law / A-law encoding without clipping.
 *
 * Listen window
 * -------------
 * Handshake.js requires us to emit 'ready' with remoteDetected=false
 * if no real peer is there — otherwise the upper layer enters DATA
 * mode on noise. We start a timer the instant the modem is constructed.
 * If CARRIER_UP / TRAINING_SUCCEEDED don't fire within
 * LISTEN_WINDOW_MS, we emit 'ready' with remoteDetected=false.
 * Default 8 s — covers V.22bis full handshake (TX training ~650 ms,
 * RX training ~900 ms, plus margin for SIP jitter and modem delay).
 */

const { EventEmitter } = require('events');
const path             = require('path');
const config           = require('../../../config');
const { makeLogger }   = require('../../logger');

const log = makeLogger('V22');

// ─── Load native addon ──────────────────────────────────────────────────────

let native;
try {
  native = require(path.join(__dirname, '..', '..', '..',
                             'build', 'Release', 'synthmodem_v22.node'));
} catch (err) {
  // Provide an actionable error if the addon isn't built yet.
  throw new Error(
    'synthmodem_v22 native addon not built — run `npm install` in the ' +
    'project root. Underlying error: ' + err.message
  );
}

const { V22bisNative } = native;
if (!V22bisNative) {
  throw new Error('synthmodem_v22 addon loaded but V22bisNative export missing');
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Listen-window for CARRIER_UP / TRAINING_SUCCEEDED. If neither fires in
// this time after construction, we emit 'ready' with remoteDetected=false
// so Handshake.js can hang up rather than enter DATA on silence/noise.
//
// Sized to tolerate a variety of caller modems:
//   - Pure V.22 modems respond to our answer sequence within ~1-2 s.
//   - Modern modems that do automode may take longer if they initially
//     try V.32 and only fall back to V.22 after a timeout. Our Handshake
//     sends a pure 2400 Hz "V.22 protocol identifier" tone before V.22
//     training starts, which signals to an automoding caller that we're
//     V.22, not V.32. But some callers still commit to V.32 briefly
//     before falling back.
//   - With forced-V22 mode, the caller sees our ANS + 2400 Hz tone and
//     should respond at 1200 Hz within a few seconds.
// 15 s gives generous margin.
const LISTEN_WINDOW_MS = 15000;

// Time a CARRIER_UP must persist without a CARRIER_DOWN before we count
// it as a real remote carrier. spandsp's V.22 RX has a narrow power-
// detection hysteresis band; out-of-band tones near 1800 Hz (e.g. V.32
// Signal AA from a caller in V.32 automode) can make the power reading
// oscillate within that band, producing many paired UP/DOWN events a
// few ms apart. A real V.22 carrier stays up continuously for hundreds
// of ms before training completes. 200 ms reliably distinguishes the two.
const CARRIER_STABLE_MS = 200;

// Float ↔ int16 conversion.
const FLOAT_TO_I16 = 32767;
const I16_TO_FLOAT = 1 / 32768;

// ─── Base class ─────────────────────────────────────────────────────────────

class V22Base extends EventEmitter {

  constructor(role, bitRate, displayName) {
    super();
    this._role        = role;
    this._bitRate     = bitRate;
    this._name        = displayName;
    this._bps         = bitRate;            // may be revised by TRAINING_SUCCEEDED
    this._carrierUp   = false;              // raw spandsp carrier flag
    this._remoteDetected = false;           // stable carrier confirmed
    this._carrierStabilityTimer = null;
    this._carrierUpAtMs = 0;
    this._rawUpCount   = 0;                 // diagnostic: raw spandsp UP count
    this._rawDownCount = 0;                 // diagnostic: raw spandsp DOWN count
    this._trained     = false;
    this._readyFired  = false;
    this._closed      = false;
    this._listenTimer = null;

    // Reused int16 scratch buffer for RX float→int16 conversion (sized on
    // demand). Avoids allocator churn on the 50 Hz RX hot path.
    this._rxI16     = null;

    // V.32 Signal AA (1800 Hz) detector state — see _gateIfV32AA below
    // for full rationale. Sliding Goertzel computed over every 160-sample
    // block; state tracks consecutive "AA present" / "AA absent" blocks
    // to add hysteresis against momentary frequency jitter. 3 consecutive
    // blocks @ 20 ms = 60 ms: responsive enough to unmute quickly when
    // AA stops, stable enough to not flicker on brief drops.
    this._aaDetected     = false;
    this._aaPresentCount = 0;
    this._aaAbsentCount  = 0;
    // Silence scratch buffer reused across blocks.
    this._rxSilence      = null;

    // Caller-silence gate state — see _gateUntilCallerEnergy below.
    // Closed at construction; opens once we see sustained real-signal
    // energy; stays open for the life of the call.
    this._callerGateOpen     = false;
    this._callerPresentCount = 0;

    // Blind-S1 detector state — see _detectBlindS1 below. Only active in
    // V.22bis answerer mode (bitRate === 2400). Detects S1 via Goertzel
    // (independent of spandsp's QAM demodulator) and latches `_blindS1Seen`
    // once it sees the pattern; then retries forceS1Accept() each block
    // until spandsp is ready to accept the state injection. One-shot per
    // session.
    this._blindS1Active    = (bitRate === 2400 && role !== 'originate');
    this._blindS1Count     = 0;
    this._blindS1MaxRatio  = 0;
    this._blindS1Seen      = false;
    this._blindS1SeenStats = null;
    this._blindS1Triggered = false;

    // Construct the native modem. Event callback runs synchronously
    // on the JS thread — spandsp's put_bit/status callbacks are buffered
    // in C++ and flushed at the end of each rx()/tx() JS call.
    this._native = new V22bisNative(
      role === 'originate' ? 'originate' : 'answer',
      bitRate,
      (ev) => this._onNativeEvent(ev)
    );

    log.info(`${this._name} init: role=${role} bitRate=${bitRate}`);

    // Fire 'listening' on the next tick so Handshake.js listeners (which
    // are attached right after `new V22bis()`) receive it. This is
    // informational — it does NOT mean TX training has finished. It
    // means the module has been constructed and is accepting audio.
    // The message in Handshake.js says "TX training complete" which is
    // misleading but harmless.
    setImmediate(() => {
      if (!this._closed) this.emit('listening');
    });

    // Start the listen window.
    this._listenTimer = setTimeout(() => {
      this._listenTimer = null;
      if (this._readyFired || this._closed) return;
      // Diagnostic: during the window, how many raw UP/DOWN events did
      // spandsp fire? If there was a flood without a stable detect, the
      // far end was probably sending V.32 AA (1800 Hz) or similar out-of-
      // band tone that wiggled spandsp's carrier detector.
      const flap = this._rawUpCount + this._rawDownCount;
      if (flap > 4) {
        log.warn(`${this._name} listen-window expired (${LISTEN_WINDOW_MS}ms) — ` +
                 `no stable remote carrier (spandsp raw events: ` +
                 `UP=${this._rawUpCount} DOWN=${this._rawDownCount} — ` +
                 `likely V.32 automode AA interference or out-of-band tone)`);
      } else {
        log.warn(`${this._name} listen-window expired (${LISTEN_WINDOW_MS}ms) — no remote carrier`);
      }
      this._fireReady(false);
    }, LISTEN_WINDOW_MS);
  }

  // ─── Event fan-out from native ───────────────────────────────────────────

  _onNativeEvent(ev) {
    if (this._closed) return;

    if (ev.type === 'data') {
      if (config.logging.logModemData) {
        log.trace(`${this._name} RX ${ev.bytes.length}B: ${ev.bytes.toString('hex')}`);
      }
      this.emit('data', ev.bytes);
      return;
    }

    if (ev.type === 'status') {
      // ev.code = spandsp SIG_STATUS_* (negative). ev.name = tag.
      // Note: during V.32 automode fallback (when a caller tries V.32
      // before V.22), spandsp sees strong 1800 Hz AA in its passband
      // and oscillates its own internal carrier-detect. This produces
      // many paired CARRIER_UP / CARRIER_DOWN events over the ~3 s AA
      // phase. That's normal — spandsp is doing its best with a tone
      // it's not designed to track. We debounce below so we don't
      // flood the log or fire 'remote-detected' spuriously.

      switch (ev.name) {
        case 'CARRIER_UP': {
          this._rawUpCount++;
          // Don't log or emit on every CARRIER_UP. Record the timestamp;
          // if it stays stable (no matching CARRIER_DOWN) for
          // CARRIER_STABLE_MS, THEN we count it as a real remote carrier.
          if (!this._remoteDetected) {
            this._carrierUpAtMs = Date.now();
            if (!this._carrierStabilityTimer) {
              this._carrierStabilityTimer = setTimeout(() => {
                this._carrierStabilityTimer = null;
                // Still up after the stability window → real carrier.
                if (!this._remoteDetected && !this._closed) {
                  this._remoteDetected = true;
                  let rms = 0;
                  try {
                    const stats = this._native.getStats();
                    // rxSignalPower is dBm0 (negative). Convert to
                    // a linear rms 0..1 figure so Handshake.js's log
                    // formatting works like the old JS implementation.
                    rms = Math.pow(10, (stats.rxSignalPower || -20) / 20);
                  } catch (_) { /* fallback to 0 */ }
                  log.info(`${this._name} CARRIER_UP — remote carrier detected (stable)`);
                  this.emit('remote-detected', { rms });
                }
              }, CARRIER_STABLE_MS);
            }
          }
          // Track low-level flag for carrierDetected accessor. Logged
          // only at trace level to keep debug logs readable.
          if (!this._carrierUp) {
            this._carrierUp = true;
            log.trace(`${this._name} carrier flag up`);
          }
          break;
        }

        case 'CARRIER_DOWN': {
          this._rawDownCount++;
          // Cancel any pending stability timer — if carrier drops before
          // the window expires, the earlier CARRIER_UP wasn't a real
          // remote signal (likely V.32 AA noise, etc.).
          if (this._carrierStabilityTimer) {
            clearTimeout(this._carrierStabilityTimer);
            this._carrierStabilityTimer = null;
          }
          if (this._carrierUp) {
            this._carrierUp = false;
            log.trace(`${this._name} carrier flag down`);
          }
          break;
        }

        case 'TRAINING_SUCCEEDED': {
          if (!this._trained) {
            this._trained = true;
            // If there was a pending stability timer, cancel it — training
            // success supersedes it.
            if (this._carrierStabilityTimer) {
              clearTimeout(this._carrierStabilityTimer);
              this._carrierStabilityTimer = null;
            }
            try {
              const stats = this._native.getStats();
              if (stats.currentBitRate > 0) this._bps = stats.currentBitRate;
            } catch (_) {}
            // TRAINING_SUCCEEDED always implies remote was detected.
            if (!this._remoteDetected) {
              this._remoteDetected = true;
              this.emit('remote-detected', { rms: 1 });
            }
            log.info(`${this._name} TRAINING_SUCCEEDED — bps=${this._bps}`);
            this._fireReady(true);
          }
          break;
        }

        case 'TRAINING_FAILED': {
          log.warn(`${this._name} TRAINING_FAILED`);
          this._fireReady(false);
          break;
        }

        // Other statuses (END_OF_DATA / SHUTDOWN_COMPLETE / etc.) don't
        // drive the handshake state machine. Log-only above.
        default:
          break;
      }
      return;
    }
  }

  _fireReady(remoteDetected) {
    if (this._readyFired) return;
    this._readyFired = true;
    if (this._listenTimer) {
      clearTimeout(this._listenTimer);
      this._listenTimer = null;
    }
    this.emit('ready', {
      bps:             this._bps,
      remoteDetected:  !!remoteDetected,
    });
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  write(data) {
    if (this._closed) return;
    if (config.logging.logModemData) {
      log.trace(`${this._name} TX ${data.length}B: ${data.toString('hex')}`);
    }
    this._native.writeData(data);
  }

  // ─── Audio generation ────────────────────────────────────────────────────

  /** Generate n Float32 audio samples for TX (pulls from the native modem). */
  generateAudio(n) {
    const i16 = this._native.tx(n);   // Int16Array of length n
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = i16[i] * I16_TO_FLOAT;
    return out;
  }

  /** Feed Float32 audio samples to the RX side.
   *
   *  If the remote is sending a strong out-of-band tone (specifically
   *  1800 Hz V.32 Signal AA from a caller in V.32 automode), we REPLACE
   *  the audio with silence before feeding spandsp. Background:
   *
   *  spandsp's V.22 answerer RX has an RRC filter centered at 1200 Hz
   *  to receive the caller's V.22 signal. The filter's stopband doesn't
   *  fully reject 1800 Hz (it's only 600 Hz away), so a strong 1800 Hz
   *  tone produces a significant power reading that fluctuates around
   *  the carrier_on/off hysteresis band. This triggers hundreds of
   *  spurious v22bis_restart() calls per second, which in turn reset
   *  tx.training back to INITIAL_TIMED_SILENCE — making our TX go silent.
   *
   *  When our TX goes silent, the caller never sees USB1 (our V.22
   *  protocol identifier signal) and stays in V.32 automode forever.
   *
   *  By feeding spandsp silence while AA is detected, we:
   *   - prevent the restart loop → TX keeps emitting U11 correctly
   *   - give the caller a stable USB1 to detect, per V.22bis spec
   *   - automatically resume normal RX when AA stops (caller falls
   *     back to V.22, starts transmitting 1200 Hz, 1800 Hz drops away)
   */
  receiveAudio(samples) {
    if (this._closed) return;
    const n = samples.length;

    // Two gates run in series:
    // 1) V.32 AA gate — silences 1800 Hz automode tones before they reach
    //    spandsp and destabilise its carrier detector.
    // 2) Caller-silence gate — keeps spandsp in its pre-CARRIER_UP state
    //    until we actually see real caller energy, so its SYMBOL_ACQUISITION
    //    and S1-detection windows fire AFTER real caller signal arrives
    //    rather than on echo or line noise. Without this, spandsp frequently
    //    fires CARRIER_UP on our own TX echo and races through its 67 ms
    //    SYMBOL_ACQUISITION + 270 ms S1-detection window before the caller
    //    has even started transmitting — committing to 1200 bps prematurely
    //    even when the caller wants V.22bis 2400.
    const aaGated      = this._gateIfV32AA(samples);
    const afterAa      = aaGated || samples;
    const silenceGated = this._gateUntilCallerEnergy(afterAa);
    const src          = silenceGated || afterAa;

    // Blind-S1 detector — only active in V.22bis answerer mode.
    //
    // Runs on raw caller audio (pre-gates) so we can see S1 even when the
    // AA gate is silencing for spandsp's benefit (S1 can arrive while AA
    // is still fading and the gate hasn't released yet). The detector's
    // own AA-rejection (1800 Hz bin below threshold) prevents false
    // positives during actual AA.
    //
    // The "seen" state is latched and forceS1Accept is retried each block
    // until it takes. Binding guards ensure acceptance only happens when
    // spandsp's RX is in the right state (SCRAMBLED_ONES_AT_1200).
    if (this._blindS1Active && !this._blindS1Triggered) {
      this._detectBlindS1(samples);
    }

    if (!this._rxI16 || this._rxI16.length !== n) {
      this._rxI16 = new Int16Array(n);
    }
    const i16 = this._rxI16;
    for (let i = 0; i < n; i++) {
      let s = src[i] * FLOAT_TO_I16;
      if (s > 32767)   s = 32767;
      if (s < -32768)  s = -32768;
      i16[i] = s | 0;
    }
    this._native.rx(i16);
  }

  /** Caller-silence gate.
   *
   *  Feeds spandsp silence until we observe sustained caller energy in
   *  the V.22 band (1200 Hz originator carrier). Once opened, stays open
   *  for the life of the call.
   *
   *  Why this matters — spandsp's V.22bis answerer RX state machine is:
   *
   *    silent → CARRIER_UP → SYMBOL_ACQUISITION (40 symbols, 67 ms)
   *           → SCRAMBLED_ONES_AT_1200 (270 ms window to detect caller's S1)
   *           → commit to 1200 or 2400
   *           → TIMED_S11 (756 ms)
   *           → TRAINING_SUCCEEDED
   *
   *  The RX state machine advances on spandsp's clock, not the caller's.
   *  If CARRIER_UP fires prematurely (on TX echo, line noise, or RTP
   *  jitter artifacts), the S1-detection window closes before the real
   *  caller signal arrives — and spandsp commits to 1200 bps even when
   *  the caller is trying to negotiate V.22bis.
   *
   *  WHY 1200 Hz SPECIFIC (not broadband) — the caller's V.22 originator
   *  carrier is at 1200 Hz, and its SB1/S1 signals are broadband in a
   *  band centered there. A broadband energy threshold would also trigger
   *  on V.32 Signal AA (1800 Hz, strong) before our AA gate has had time
   *  to engage (the AA gate needs 60 ms of sustained 1800 Hz before it
   *  suppresses — and we don't want the caller gate opening during that
   *  initial 60 ms). By Goertzel-filtering at 1200 Hz with a reasonably
   *  narrow bandwidth we ignore 1800 Hz AA entirely and only open on
   *  genuine V.22 originator energy.
   *
   *  OPEN_BLOCKS = 2 (40 ms) trades a tiny latency for immunity to
   *  single-block RTP glitches. Threshold is on the Goertzel magnitude
   *  at 1200 Hz, tuned to ignore both echo and AA-band leakage.
   */
  _gateUntilCallerEnergy(samples) {
    const n = samples.length;
    if (n === 0) return null;

    // Once open, stay open — don't re-gate mid-session.
    if (this._callerGateOpen) return null;

    // Goertzel at 1200 Hz (V.22 originator carrier).
    const coeff = 2 * Math.cos(2 * Math.PI * 1200 / 8000);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const mag2 = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    const rms1200 = Math.sqrt(mag2) * Math.SQRT2 / n;

    // Threshold well below a real V.22 carrier (~0.05 in 1200 Hz bin for
    // a signal at -12 dBm0) but well above typical echo / AA-band leakage.
    const OPEN_THRESHOLD = 0.01;
    const OPEN_BLOCKS    = 2;

    if (rms1200 >= OPEN_THRESHOLD) {
      this._callerPresentCount++;
      if (this._callerPresentCount >= OPEN_BLOCKS) {
        this._callerGateOpen = true;
        log.info(`${this._name} V.22 caller carrier (1200 Hz) detected — opening RX to spandsp`);
        return null;   // this block passes through
      }
    } else {
      this._callerPresentCount = 0;
    }

    if (!this._rxSilence || this._rxSilence.length !== n) {
      this._rxSilence = new Float32Array(n);
    }
    return this._rxSilence;
  }


  /** Blind S1 detector — detects the caller's V.22bis S1 signal in the
   *  frequency domain, bypassing spandsp's QAM demodulator.
   *
   *  Background
   *  ----------
   *  V.22bis S1 is a 100ms burst of unscrambled double-dibit (00/11
   *  alternating) transmitted at 1200 bps by a caller requesting 2400
   *  bps operation. Modulating alternating 00/11 dibits onto a 1200 Hz
   *  carrier at 600 baud produces a phase oscillation whose spectrum is
   *  two narrow lines at 1200 ± 300 Hz (i.e. 900 Hz and 1500 Hz), plus
   *  residual energy at the 1200 Hz carrier.
   *
   *  spandsp's built-in S1 detector runs inside its QAM demodulator:
   *  after Gardner symbol-timing recovery has settled (67 ms), it looks
   *  for 15+ consecutive raw_bits transitions matching the 00↔11 pattern.
   *  In practice, with S1-first callers, Gardner fails to lock on the
   *  clean alternating-phase signal (it needs random/scrambled data for
   *  proper timing recovery) and pattern_repeats never exceeds ~4.
   *
   *  This detector is a frequency-domain alternative: simultaneous
   *  Goertzel filters at 900 and 1500 Hz (the S1 sidebands) and at
   *  1050 and 1350 Hz (the valleys between the S1 peaks). During S1
   *  the "peaks" are large and the "valleys" are near-zero, producing
   *  a very high peak-to-valley ratio. During SB1 (scrambled 1s, which
   *  is what the caller transmits after S1) the spectrum is broadband
   *  around 1200 Hz and the ratio collapses.
   *
   *  On detection we call the binding's forceS1Accept() method which
   *  performs the same state transition spandsp's native S1 handler
   *  would have performed: TX advances to U0011 (transmit our own S1
   *  burst), and negotiated_bit_rate is bumped to 2400. From there,
   *  spandsp's normal RX state machine takes over, expecting the
   *  caller's SB1 that follows its S1 — which Gardner CAN lock to.
   *
   *  Activation guards
   *  -----------------
   *   - Only active for V22bis answerer (see _blindS1Active init).
   *   - Only runs after the caller-silence gate has opened, so we only
   *     analyze real caller signal, not echo/noise/silence.
   *   - One-shot: once _blindS1Triggered is set, this never runs again.
   *
   *  Hysteresis
   *  ----------
   *  Requires 3 consecutive blocks (60 ms) matching the S1 pattern
   *  before triggering. Empirically against real capture data this
   *  fires ~80 ms after the caller's first S1 block — well within
   *  spandsp's 270 ms commit-to-1200 window.
   */
  _detectBlindS1(samples) {
    const n = samples.length;
    if (n === 0) return;

    // Goertzel at five frequencies. Reusing inner helper to minimise code.
    const goertzelMag = (freq) => {
      const coeff = 2 * Math.cos(2 * Math.PI * freq / 8000);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = samples[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const mag2 = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      return Math.sqrt(mag2) * Math.SQRT2 / n;
    };

    const g900  = goertzelMag(900);
    const g1200 = goertzelMag(1200);
    const g1500 = goertzelMag(1500);
    const g1050 = goertzelMag(1050);
    const g1350 = goertzelMag(1350);
    const g1800 = goertzelMag(1800);  // V.32 AA rejection

    // Peaks: energy at the S1 spectral lines (900, 1200, 1500 Hz).
    // Valleys: energy between them (1050, 1350 Hz). During S1 these
    // valleys are near-zero; during broadband SB1 they're comparable
    // to the peaks.
    const peaks   = g900 + g1200 + g1500;
    const valleys = g1050 + g1350;

    // Thresholds tuned empirically against real modem captures:
    //   PEAK_MIN   — reject blocks with too little energy (silence tails,
    //                low-level echo). Real V.22 caller signal is ~0.08 RMS,
    //                so peak sum comfortably exceeds 0.05.
    //   RATIO_MIN  — S1 typically shows ratios of 3-20+; SB1 rarely
    //                exceeds 2. Threshold of 3.0 distinguishes reliably.
    //   AA_MAX     — reject blocks where 1800 Hz bin dominates. Pure S1
    //                has very little 1800 Hz content. V.32 AA puts all its
    //                energy at 1800 Hz. But real captures sometimes have
    //                persistent 1800 Hz residue even while genuine S1 is
    //                on the line (poor line conditions, PBX tone leakage,
    //                etc.) so the threshold is set to clearly-above-quiet
    //                rather than absolute-zero to avoid missing real S1.
    //   RATIO_STRONG — a higher-confidence ratio threshold. The 3-block
    //                consecutive trigger requires AT LEAST ONE block to
    //                meet this stronger threshold, not just the lower
    //                RATIO_MIN. Scrambled V.22 data occasionally produces
    //                high-ratio spurious blocks near 900/1200/1500 Hz
    //                bins by chance (ratios 3-10); real S1 shows ratios
    //                of 500+ when properly aligned. Requiring at least
    //                one strong block in a run rejects the occasional
    //                3-block random-chance cluster while still accepting
    //                genuine S1 (which typically has 1-2 blocks at
    //                perfect alignment with ratios in the hundreds).
    //   CONSECUTIVE_BLOCKS — 3 × 20 ms = 60 ms, enough to filter
    //                transient spectral peaks in scrambled data while
    //                still firing well within S1's 100 ms duration.
    const PEAK_MIN           = 0.05;
    const RATIO_MIN          = 3.0;
    const RATIO_STRONG       = 100.0;
    const AA_MAX             = 0.10;
    const CONSECUTIVE_BLOCKS = 3;

    const ratio = valleys > 1e-6 ? peaks / valleys : peaks * 1e6;
    const isS1  = peaks >= PEAK_MIN
               && ratio >= RATIO_MIN
               && g1800 < AA_MAX;

    if (isS1) {
      this._blindS1Count++;
      // Track max ratio across the current run of consecutive S1-like
      // blocks. Scrambled data can occasionally produce 3 consecutive
      // low-ratio (3-10) blocks by chance; real S1 reliably shows at
      // least one block with ratio ≥ RATIO_STRONG due to the precise
      // spectral alignment of the 00/11 pattern.
      if (!this._blindS1MaxRatio || ratio > this._blindS1MaxRatio) {
        this._blindS1MaxRatio = ratio;
      }
      if (this._blindS1Count >= CONSECUTIVE_BLOCKS
          && this._blindS1MaxRatio >= RATIO_STRONG
          && !this._blindS1Seen) {
        // Latch "we saw S1". Independent of whether spandsp is ready yet.
        this._blindS1Seen = true;
        this._blindS1SeenStats = { peaks, ratio: this._blindS1MaxRatio };
        log.info(`${this._name} blind S1 detected (peaks=${peaks.toFixed(3)} max_ratio=${this._blindS1MaxRatio.toFixed(1)}) — will force 2400 bps upgrade when spandsp is ready`);
      }
    } else {
      this._blindS1Count = 0;
      this._blindS1MaxRatio = 0;
    }

    // Independent accept loop — if we've ever seen S1, try to inject it
    // into spandsp every block until it takes. spandsp needs to be in RX
    // state SCRAMBLED_ONES_AT_1200 (i.e. past the 67 ms SYMBOL_ACQUISITION
    // settle that follows its first valid carrier block). Depending on
    // timing between the caller-silence gate opening and the S1 burst,
    // this may take anywhere from 0 blocks (spandsp already ready when S1
    // arrives) to many blocks (S1 arrived during AA window, spandsp only
    // sees real caller signal much later). Either way we keep retrying.
    if (this._blindS1Seen && !this._blindS1Triggered) {
      const accepted = this._native.forceS1Accept();
      if (accepted) {
        this._blindS1Triggered = true;
        const { peaks: p, ratio: r } = this._blindS1SeenStats || { peaks: 0, ratio: 0 };
        log.info(`${this._name} forcing 2400 bps upgrade (peaks=${p.toFixed(3)} ratio=${r.toFixed(1)})`);
      }
    }
  }

  /** V.32 Signal AA (1800 Hz) detector + gate.
   *
   *  Runs a Goertzel filter at 1800 Hz over the block. Two criteria, either
   *  one sufficient to classify the block as "AA present":
   *
   *    1. ABSOLUTE magnitude: 1800 Hz RMS ≥ 0.02 (about -34 dBFS).
   *       Strong 1800 Hz is a clear AA signal regardless of whatever else
   *       is on the line. This matters during the V.32→V.22 transition
   *       when the caller briefly overlays its V.22 signal onto a still-
   *       fading AA — spandsp can misinterpret the overlay as "real V.22"
   *       and race through training on contaminated audio. Gating on
   *       absolute 1800 Hz magnitude keeps us silent through the overlay.
   *
   *    2. RELATIVE concentration: 1800 Hz / total ratio ≥ 0.05.
   *       Catches cases where total signal is weak but it's clearly AA.
   *
   *  Silence blocks (total RMS ≈ 0) are IGNORED for hysteresis purposes
   *  — they neither increment nor reset either counter. This is important
   *  because PCMU/μ-law transport sometimes produces all-zero blocks
   *  during RTP packet loss or quantization silence, and those shouldn't
   *  be interpreted as "AA stopped".
   *
   *  Hysteresis is asymmetric: engage gate after 3 consecutive present
   *  blocks (60 ms), release gate only after 8 consecutive absent blocks
   *  (160 ms). The longer release window prevents the gate from flickering
   *  off during the caller's V.22+AA overlay phase (observed duration
   *  ~1.6 s with 50% silence intervals, which naively would flip the gate
   *  off mid-overlay).
   */
  _gateIfV32AA(samples) {
    const n = samples.length;
    if (n === 0) return null;

    // Goertzel for 1800 Hz at 8 kHz sample rate.
    // omega = 2π·1800/8000 = 0.45π; coeff = 2·cos(omega) ≈ 0.312869
    const coeff = 2 * Math.cos(2 * Math.PI * 1800 / 8000);
    let s0 = 0, s1 = 0, s2 = 0;
    let totalEnergy = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      s0 = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
      totalEnergy += x * x;
    }
    const goertzelMag2 = s1 * s1 + s2 * s2 - coeff * s1 * s2;

    const totalRms = Math.sqrt(totalEnergy / n);

    // Silence guard: if the block is ~silent, don't update any state.
    // This keeps PCMU/RTP silence gaps from flipping the gate off during
    // the V.32→V.22 overlay phase.
    const SILENCE_THRESHOLD = 0.002;   // ~-54 dBFS; real modem signals are ≥ -20 dBFS
    if (totalRms < SILENCE_THRESHOLD) {
      // Keep returning silence if we were gating; otherwise pass-through.
      if (this._aaDetected) {
        if (!this._rxSilence || this._rxSilence.length !== n) {
          this._rxSilence = new Float32Array(n);
        }
        return this._rxSilence;
      }
      return null;
    }

    // For pure tone: goertzel_mag² ≈ (N·A/2)²; equivalent RMS = √2·√mag² / N
    const abs1800Rms = Math.sqrt(goertzelMag2) * Math.SQRT2 / n;
    const ratio = totalEnergy > 1e-8 ? goertzelMag2 / (n * totalEnergy) : 0;

    // Two criteria — either flags block as AA.
    const ABS_1800_THRESHOLD = 0.02;   // About -34 dBFS of pure 1800 Hz
    const RATIO_THRESHOLD    = 0.05;   // 1800 Hz dominates block
    const isAA = abs1800Rms >= ABS_1800_THRESHOLD || ratio >= RATIO_THRESHOLD;

    if (isAA) {
      this._aaPresentCount++;
      this._aaAbsentCount = 0;
    } else {
      this._aaAbsentCount++;
      this._aaPresentCount = 0;
    }

    const ENGAGE_BLOCKS = 3;   // 60 ms of AA to turn gate on
    const RELEASE_BLOCKS = 8;  // 160 ms of clear audio to turn gate off —
                               // long enough to cover the caller's V.32→V.22
                               // overlay phase and its subsequent 456 ms
                               // mandated silence, ensuring the gate stays
                               // engaged until the real V.22 handshake starts.

    if (!this._aaDetected && this._aaPresentCount >= ENGAGE_BLOCKS) {
      this._aaDetected = true;
      log.info(`${this._name} V.32 Signal AA (1800 Hz) detected on RX — gating input to spandsp to preserve USB1 TX`);
    } else if (this._aaDetected && this._aaAbsentCount >= RELEASE_BLOCKS) {
      this._aaDetected = false;
      log.info(`${this._name} V.32 Signal AA no longer present — resuming normal RX`);
    }

    if (this._aaDetected) {
      if (!this._rxSilence || this._rxSilence.length !== n) {
        this._rxSilence = new Float32Array(n);
      }
      return this._rxSilence;
    }
    return null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  stop() {
    if (this._closed) return;
    this._closed = true;
    if (this._listenTimer) {
      clearTimeout(this._listenTimer);
      this._listenTimer = null;
    }
    if (this._carrierStabilityTimer) {
      clearTimeout(this._carrierStabilityTimer);
      this._carrierStabilityTimer = null;
    }
    try { this._native.close(); } catch (_) {}
  }

  // ─── Accessors ───────────────────────────────────────────────────────────

  get name()              { return this._name; }
  get bps()               { return this._bps; }
  get carrierDetected()   { return this._carrierUp; }
}

// ─── Concrete classes ───────────────────────────────────────────────────────

class V22 extends V22Base {
  constructor(role) {
    super(role, 1200, 'V22');
  }
}

class V22bis extends V22Base {
  constructor(role) {
    super(role, 2400, 'V22bis');
  }
}

module.exports = { V22, V22bis };
