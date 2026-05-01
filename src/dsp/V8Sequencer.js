'use strict';

/**
 * V8Sequencer — ITU-T V.8 (05/99) negotiation sequencer.
 *
 * Faithful port of spandsp's `src/v8.c` (LGPL 2.1, Steve Underwood, 2004).
 * The byte-level builders and parsers live in V8.js; this module is the
 * sample-accurate state machine that drives ANSam / V.21 transmission and
 * timing.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Why a faithful port instead of "implement to spec"
 *
 * V.8 is small and the spec is short, but timing is exacting and every
 * implementation that "follows the spec" tends to differ in the gaps the
 * spec leaves open: how often to repeat CM, how to tolerate a partly-
 * decoded CM, how to bridge ANSam into JM, when exactly to flush the JM
 * queue on CJ. spandsp's v8.c is a battle-tested reference that has
 * interoperated with a wide range of real modems for two decades. By
 * porting it line-for-line we inherit the choices that matter without
 * having to re-discover them by capture analysis.
 *
 * The port is structured to mirror v8.c's flow exactly:
 *
 *   - State enum names match (V8_WAIT_1S, V8_CI_ON, V8_CI_OFF,
 *     V8_HEARD_ANSAM, V8_CM_ON, V8_CJ_ON, V8_CM_WAIT, V8_SIGC,
 *     V8_JM_ON, V8_SIGA, V8_PARKED).
 *   - `tx()` and `rx()` mirror v8.c's `v8_tx` and `v8_rx`, called once
 *     per audio block. Sample counts drive every transition.
 *   - CM/JM acceptance follows spandsp's "two byte-identical messages"
 *     rule (spec §7.4) — no merging across CMs.
 *   - On CJ, the V.21 TX queue is flushed immediately (queue_flush in
 *     v8.c). No half-sent JM trailing into the silence gap.
 *   - The 75 ms post-ANSam silence and 75 ms post-CJ silence are
 *     sample-counted, not setTimeout-driven.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * What this module does NOT do
 *
 *   - Echo cancellation. spandsp uses ANSam-PR (phase-reversed) when echo
 *     cancellation needs disabling on a PSTN path. We always emit
 *     phase-reversed ANSam (matching ANSAM_PR) since it's the safer
 *     superset for VoIP. Real modems treat AM-only and AM+PR identically.
 *   - V.91 / V.92 / T.66 octets. We decode and pass through if present
 *     but never advertise them.
 *   - The non-V.8 connect-tone fallback inside v8.c (handle_modem_-
 *     connect_tone). That's the originate-side path where we hear plain
 *     ANS and bail out of V.8. We emit `'non-v8'` instead and let the
 *     caller decide what to do.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Events emitted
 *
 *   'result'    Negotiation succeeded. Argument is a parms-like object:
 *                 { call_function, modulations, callFn, modes }
 *   'failed'    Negotiation failed.   Argument is a reason string:
 *                 'timeout-no-cm', 'timeout-no-cj', 'timeout-no-ansam',
 *                 'no-deal' (intersection empty)
 *   'non-v8'    Plain ANS detected (originate side only). The peer is not
 *               V.8 capable. Caller should fall back to V.25 automode.
 */

const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');
const log              = makeLogger('V8Sequencer');
const cfg              = require('../../config').modem.native;
const SR               = require('../../config').rtp.sampleRate;
const V8               = require('./V8');
const { FskModulator } = require('./protocols/FskCommon');
const { V21Demodulator } = require('./protocols/V21');
const { goertzel }     = require('./Primitives');

// ─── State machine constants (mirror v8.c enum v8_states_e) ─────────────────

const ST = {
  WAIT_1S:       'WAIT_1S',          // originate: wait 1s before first CI
  CI_ON:         'CI_ON',             // originate: transmitting CI
  CI_OFF:        'CI_OFF',            // originate: silence between CI bursts
  HEARD_ANSAM:   'HEARD_ANSAM',       // originate: ANSam detected, Te wait
  CM_ON:         'CM_ON',             // originate: transmitting CM, listening for JM
  CJ_ON:         'CJ_ON',             // originate: transmitting CJ
  SIGC:          'SIGC',              // originate: 75ms silence post-CJ
  CM_WAIT:       'CM_WAIT',           // answer: ANSam + listening for CM
  JM_ON:         'JM_ON',             // answer: transmitting JM, listening for CJ
  SIGA:          'SIGA',              // answer: 75ms silence post-CJ
  PARKED:        'PARKED',            // terminal: result handler called
};

// ─── V.8 spec timings (V.8 §8) ──────────────────────────────────────────────

// V.8 §8.1: caller waits ≥1s of line silence before first CI (allows the
// answerer to come fully off-hook and the line to settle).
const WAIT_1S_MS = 1000;

// V.8 §7.1: between CI bursts, 0.4-2 s of silence. We use 500 ms to keep
// the duty cycle generous without being pathological.
const CI_OFF_MS = 500;

// V.8 §8.1: after detecting ANSam, caller waits Te before sending CM.
// Spec says "≥0.5 s, 1 s where echo canceller disabling is needed."
// Spandsp uses 1000 ms unconditionally. We follow.
const TE_MS = 1000;

// V.8 §7.4: after the last JM bit, the answer waits 75 ms before its
// modulation begins. Same after CJ on the originate side.
const POST_SIG_MS = 75;

// V.8 §8.1: caller's CI-retry limit — give up after ~10 retries (~10s).
// Spandsp uses 10. We follow.
const MAX_CI_COUNT = 10;

// V.8 §8.2: after starting ANSam, the answerer waits for CM. Spec
// gives no hard ceiling but spandsp uses 5s. We follow spandsp.
//
// History: this was briefly raised to 8s for VoIP-induced-delay
// margin, but with the addition of V.25 legacy automode probing
// (when V.8 fails — see Handshake._advanceProbe) we need every
// available millisecond inside the caller-side software's S7
// "wait for carrier" register, which is hardcoded to 30 s in most
// terminal programs (HyperTerminal, Procomm, etc.). Total budget
// after pickup: ~2 s ring/connect + ~4.5 s ANSam + 5 s V.8 wait +
// 5 s V.22bis probe + 3 s V.21 probe + 5 s Bell103 probe = ~24.5 s,
// leaving margin for the final CONNECT-string emission inside the
// 30 s window.
const CM_WAIT_TIMEOUT_MS = 5000;

// V.8 §7.4: after starting JM, the answerer waits for CJ. Spandsp
// uses 5s. We follow.
const JM_WAIT_TIMEOUT_MS = 5000;

// ─── Streaming ANSam generator (stateful) ───────────────────────────────────
//
// Spandsp uses modem_connect_tones_tx() which is a stateful sample-by-sample
// generator. We re-implement here as a streaming Float32 producer so the
// sequencer can synthesize exactly N samples per block and stop precisely
// when a state-machine sample-count expires.

const TWO_PI = 2 * Math.PI;
const ANS_FREQ = 2100;
const ANSAM_AM_FREQ = 15;
const ANSAM_REVERSAL_MS = 450;

class AnsamGenerator {
  constructor({ amplitude = 0.15, withPhaseReversals = true } = {}) {
    this._avgAmp     = amplitude / 1.2;
    this._carrierPhase = 0;
    this._amPhase    = 0;
    this._carrierInc = TWO_PI * ANS_FREQ / SR;
    this._amInc      = TWO_PI * ANSAM_AM_FREQ / SR;
    this._withPR     = withPhaseReversals;
    this._samplesPerReversal = Math.round(ANSAM_REVERSAL_MS * SR / 1000);
    this._samplesUntilReversal = this._samplesPerReversal;
  }

  /** Produce numSamples of ANSam audio, advancing internal state. */
  generate(numSamples) {
    const out = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const env = this._avgAmp * (1 + 0.2 * Math.sin(this._amPhase));
      out[i] = env * Math.cos(this._carrierPhase);
      this._carrierPhase = (this._carrierPhase + this._carrierInc) % TWO_PI;
      this._amPhase      = (this._amPhase      + this._amInc)      % TWO_PI;
      if (this._withPR && --this._samplesUntilReversal <= 0) {
        this._carrierPhase = (this._carrierPhase + Math.PI) % TWO_PI;
        this._samplesUntilReversal = this._samplesPerReversal;
      }
    }
    return out;
  }
}

// ─── V.8 sequencer ──────────────────────────────────────────────────────────

class V8Sequencer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {'answer'|'originate'} opts.role
   * @param {Object} opts.parms       — capability advertisement
   * @param {string[]} opts.parms.modulations  — keys of V.8 modes object
   *                                             (e.g. ['v22bis','v23','v21'])
   * @param {number}  opts.parms.callFn   — V.8 §6.1 call function code
   *                                        (default 6 = V-series modem data)
   */
  constructor({ role, parms }) {
    super();
    this._role  = role;
    this._parms = parms || {};
    this._parms.callFn = this._parms.callFn != null ? this._parms.callFn : 6;
    this._parms.modulations = this._parms.modulations || ['V22bis', 'V22', 'V23', 'V21'];
    // Role tag for log lines so we can distinguish answer vs originate
    // when both run in a loopback bench.
    this._tag = role === 'answer' ? '[A]' : '[O]';

    // Sequencer state
    this._state = ST.PARKED;
    this._stateTimer = 0;        // sample countdown for the current state (0 = no timer)
    this._negTimer   = 0;        // overall negotiation watchdog (samples)
    this._ciCount    = 0;        // CI retry counter (originate only)

    // V.21 modulator + demodulator
    this._v21tx = null;
    this._v21rx = null;

    // ANSam streaming generator (answer side only)
    this._ansam       = null;
    // Sample countdown for ANSam transmission. >0 = emit ANSam.
    // After it reaches 0, we emit silence for POST_ANSAM samples.
    this._ansamSamplesLeft = 0;
    // Sample countdown for the silence following ANSam. >0 = emit silence.
    this._ansamPostSilenceSamplesLeft = 0;
    // Whether V.21 TX should produce audio in this block.
    this._fskTxOn = false;

    // CM/JM accumulator
    this._lastCmBytes = null;        // last received CM/JM byte sequence
    this._gotCmJm     = false;       // two identical CMs/JMs seen
    this._receivedFar = null;        // decoded modes from accepted CM/JM

    // CJ detector
    this._zeroByteCount = 0;
    this._gotCj         = false;

    // V.8 byte parser state (used for CM/JM/CI decoding)
    this._parser = {};

    // Locally-decided result (set at PARKED transition)
    this._result = null;

    // Listener for V.21 demodulator data events (so we can detach cleanly).
    this._onV21Data = null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  start() {
    if (this._role === 'answer') {
      this._startAnswer();
    } else {
      this._startOriginate();
    }
  }

  /**
   * Generate up to numSamples of TX audio. Returns Float32Array of exactly
   * that length. Mirrors v8.c's v8_tx().
   */
  generateAudio(n) {
    const out = new Float32Array(n);
    let pos = 0;

    // ANSam tone phase (answer side only).
    if (this._ansam && this._ansamSamplesLeft > 0) {
      const take = Math.min(this._ansamSamplesLeft, n - pos);
      const block = this._ansam.generate(take);
      out.set(block, pos);
      pos += take;
      this._ansamSamplesLeft -= take;
    }

    // 75ms post-ANSam silence (answer side only). Drives the silence
    // gap between ANSam-end and JM-start that real callers expect.
    if (this._ansamPostSilenceSamplesLeft > 0 && pos < n) {
      const take = Math.min(this._ansamPostSilenceSamplesLeft, n - pos);
      // out is already zero-initialized.
      pos += take;
      this._ansamPostSilenceSamplesLeft -= take;
    }

    // V.21 FSK output (CI/CM/CJ on originate, JM on answer).
    if (this._fskTxOn && this._v21tx && pos < n) {
      const before = this._v21tx._bits.length;
      const block = this._v21tx.generate(n - pos);
      out.set(block, pos);
      const after = this._v21tx._bits.length;
      if (this._state === ST.CJ_ON || this._state === ST.SIGC) {
        log.trace(`${this._tag} gen ${n - pos} samples bits ${before}→${after} state=${this._state}`);
      }
      pos = n;
    }

    // Otherwise the rest of the block is silence (already zeroed).
    return out;
  }

  /**
   * Process a block of received audio. Mirrors v8.c's v8_rx().
   * Drives the state machine forward by `samples.length` samples per call.
   */
  receiveAudio(samples) {
    const len = samples.length;

    // Run V.21 RX in any state where we expect to decode CI/CM/JM/CJ bytes.
    // States that need V.21 RX:
    //   answer:   CM_WAIT, JM_ON
    //   originate: CM_ON, CJ_ON
    if (this._v21rx && this._isRxActive()) {
      this._v21rx.process(samples);
    }

    // Drive answer-side ANSam logic: if we're in CM_WAIT and ANSam transmit
    // counter has expired, listen for CM. Spandsp keeps ANSam running
    // throughout CM_WAIT — we do too — but ANSam may also auto-terminate
    // at its full duration if no CM heard, transitioning to a timeout.
    // Here we just decrement the negotiation timer and check for expiry.
    if (this._negTimer > 0) {
      this._negTimer -= len;
      if (this._negTimer <= 0) {
        this._handleTimeout();
        return;
      }
    }

    // Pump JM continuously in JM_ON (answer side) and CM continuously
    // in CM_ON (originate side). Spandsp tops up the queue when it
    // falls below 10 bits; we do the same.
    if (this._state === ST.JM_ON || this._state === ST.CM_ON) {
      this._refillTxQueue();
    }

    // SIGA / SIGC: 75 ms silence countdown. When it expires, the
    // negotiation has succeeded (the chosen modulation is known).
    if (this._state === ST.SIGA || this._state === ST.SIGC) {
      this._stateTimer -= len;
      if (this._stateTimer <= 0) {
        this._fskTxOn = false;
        this._setState(ST.PARKED);
        this.emit('result', this._result);
        return;
      }
    }

    // HEARD_ANSAM: Te silence countdown. When it expires, originate
    // initializes V.21 TX on ch1 and starts pumping CM.
    if (this._state === ST.HEARD_ANSAM) {
      this._stateTimer -= len;
      if (this._stateTimer <= 0) {
        this._originateStartCm();
      }
    }

    // CJ_ON: wait until CJ bytes have been transmitted (queue drained),
    // then enter the 75ms post-CJ silence (SIGC).
    if (this._state === ST.CJ_ON) {
      if (this._v21tx && this._v21tx._bits.length === 0) {
        log.debug(`${this._tag} CJ TX queue drained → entering 75 ms post-CJ silence`);
        this._fskTxOn = false;
        this._stateTimer = Math.round(POST_SIG_MS * SR / 1000);
        this._setState(ST.SIGC);
      }
    }

    // CI_ON / CI_OFF cycling for the originate side (until ANSam heard).
    if (this._role === 'originate' &&
        (this._state === ST.CI_ON || this._state === ST.CI_OFF || this._state === ST.WAIT_1S)) {
      this._driveOriginateCi(samples);
    }
  }

  stop() {
    this._setState(ST.PARKED);
    if (this._v21rx && this._onV21Data) {
      this._v21rx.removeListener && this._v21rx.removeListener('data', this._onV21Data);
    }
    this._v21rx = null;
    this._v21tx = null;
    this._ansam = null;
  }

  // ─── Answer-side state machine ────────────────────────────────────────────

  _startAnswer() {
    log.debug(`${this._tag} Starting V.8 answer sequencer`);

    // Initialize V.21 demodulator on channel 1 (originator's TX channel,
    // i.e. our RX) — that's where CI/CM bytes will arrive.
    this._initV21Rx('answer');

    // Initialize ANSam generator. Per V.8 §3.1, ANSam is 2.5–4 s, with
    // 5 ± 1 s the formal upper bound. We use cfg.answerToneDurationMs
    // (default 3.3 s).
    this._ansam = new AnsamGenerator({ amplitude: 0.15, withPhaseReversals: true });
    this._ansamSamplesLeft = Math.round(cfg.answerToneDurationMs * SR / 1000);

    // ANSam plays first; V.21 TX is NOT initialized yet on the answer side.
    // (Spandsp does this too — fsk_tx is initialized on V.21 channel 2 only
    // at the CM_WAIT → JM_ON transition.)
    this._fskTxOn = false;

    // Set the negotiation timer. Spandsp uses 5s; we use 8s to be more
    // forgiving on noisy / VoIP paths.
    this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1000);

    this._setState(ST.CM_WAIT);
  }

  _onCmReceived(msg) {
    // Spandsp's cm_jm_decode requires two consecutive byte-identical CMs.
    // We replicate that. Bytes are reconstructed from the parser's
    // last-seen raw CM/JM byte stream.
    if (!msg.bytes) {
      log.warn(`${this._tag} CM message has no raw byte payload — skipping (parser bug)`);
      return;
    }

    if (this._lastCmBytes && Buffer.compare(this._lastCmBytes, msg.bytes) === 0) {
      // Two identical CMs → accept.
      this._gotCmJm = true;
      this._receivedFar = msg.modes;
      log.info(`${this._tag} V.8 CM accepted: modes=${this._summarize(msg.modes)} callFn=${msg.callFn}`);
      this._answerStartJm();
    } else {
      // First sighting (or differing from previous). Save and wait.
      this._lastCmBytes = Buffer.from(msg.bytes);
      log.debug(`${this._tag} V.8 CM #1 captured (${msg.bytes.length} bytes), awaiting confirm`);
    }
  }

  _answerStartJm() {
    // Spec §7.4: build JM advertising the intersection of our local
    // capability and the remote's. Empty intersection = "no deal" JM
    // (all-zero modes), which the caller treats as a cleardown.
    const localModes = this._buildLocalModes();
    const jmModes = {};
    const modeKeys = ['v34','v34hd','v32bis','v22bis','v17','v29hd','v27ter',
                      'v26ter','v26bis','v23','v23hd','v21','pcm'];
    for (const k of modeKeys) {
      jmModes[k] = !!(this._receivedFar[k] && localModes[k]);
    }

    const anyMode = modeKeys.some(k => jmModes[k]);
    if (!anyMode) {
      log.warn(`${this._tag} V.8 JM intersection empty — sending no-deal JM`);
    } else {
      log.info(`${this._tag} V.8 JM: sending ${this._summarize(jmModes)}`);
    }

    // Build JM bytes and stash them for repetition. Spandsp keeps
    // refilling the TX queue until CJ is detected.
    this._jmBytes = V8.buildJMBytes(jmModes);

    // Save negotiated modes for the eventual result.
    this._negotiatedModes = jmModes;

    // Initialize V.21 TX on channel 2 (answerer's high band). This is
    // the spandsp-faithful moment — V.21 TX is constructed FRESH at
    // this transition, not at start.
    this._initV21Tx('answer');

    // Seed the TX queue with one preamble + JM. _refillTxQueue() will
    // top up subsequent JMs as the queue drains.
    this._writeV8Frame(this._jmBytes);

    // Reset the watchdog for CJ wait.
    this._negTimer = Math.round(JM_WAIT_TIMEOUT_MS * SR / 1000);

    // Trigger the 75 ms post-ANSam silence by setting both ANSam-counter
    // to 0 (effectively now) and post-silence-counter to 75 ms. The
    // V.21 TX won't start producing audio until the silence completes —
    // we gate it via _fskTxOn AFTER the silence elapses, in receiveAudio.
    this._ansamSamplesLeft = 0;
    this._ansamPostSilenceSamplesLeft = Math.round(POST_SIG_MS * SR / 1000);
    this._fskTxOn = true;          // V.21 will run after the silence drains

    this._setState(ST.JM_ON);
  }

  _onCjReceived() {
    if (this._state !== ST.JM_ON) return;
    log.info(`${this._tag} V.8 CJ detected — flushing JM, entering 75 ms post-CJ silence`);

    // Spandsp: queue_flush(tx_queue) — drop any half-sent JM mid-byte.
    this._v21tx._bits = [];
    // Stop V.21 TX. The 75ms silence will be played out as zeroes.
    this._fskTxOn = false;

    this._stateTimer = Math.round(POST_SIG_MS * SR / 1000);
    this._setState(ST.SIGA);

    // Build the result that'll be emitted when SIGA expires.
    this._result = {
      role: 'answer',
      modes: this._negotiatedModes,
      callFn: this._parms.callFn,
      protocol: this._selectProtocol(this._negotiatedModes),
    };
  }

  // ─── Originate-side state machine ─────────────────────────────────────────

  _startOriginate() {
    log.debug(`${this._tag} Starting V.8 originate sequencer`);

    // V.21 RX on channel 2 (answerer's TX) — that's where JM will arrive.
    this._initV21Rx('originate');

    // 1s wait per spec before first CI burst.
    this._stateTimer = Math.round(WAIT_1S_MS * SR / 1000);
    this._setState(ST.WAIT_1S);

    // Initialize V.21 TX on channel 1 (originator's low band) — used
    // for CI now and for CM later.
    this._initV21Tx('originate');

    // Negotiation watchdog — overall.
    this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1000);
  }

  _driveOriginateCi(samples) {
    const len = samples.length;

    // First: detect ANSam. Use Goertzel at 2100 Hz.
    const ansPower = goertzel(samples, ANS_FREQ, SR);
    if (ansPower > 0.03) {
      this._ansDetectCount = (this._ansDetectCount || 0) + 1;
      if (this._ansDetectCount >= 3) {
        log.info(`${this._tag} V.8: ANSam detected, Te silence then CM`);
        this._fskTxOn = false;        // stop CI mid-burst is fine
        this._v21tx._bits = [];        // discard any unsent CI
        this._stateTimer = Math.round(TE_MS * SR / 1000);
        this._setState(ST.HEARD_ANSAM);
        return;
      }
    } else {
      this._ansDetectCount = 0;
    }

    // CI burst cycling.
    if (this._stateTimer > 0) {
      this._stateTimer -= len;
      if (this._stateTimer > 0) return;
    }

    if (this._state === ST.WAIT_1S) {
      // 1s silence elapsed. Send first CI burst.
      this._sendCiBurst();
      return;
    }
    if (this._state === ST.CI_ON) {
      // CI burst transmitted (queue empty). Enter CI_OFF.
      if (this._v21tx._bits.length === 0) {
        this._fskTxOn = false;
        this._stateTimer = Math.round(CI_OFF_MS * SR / 1000);
        this._setState(ST.CI_OFF);
      }
      return;
    }
    if (this._state === ST.CI_OFF) {
      // Off period elapsed. Try another CI burst (up to MAX_CI_COUNT).
      this._ciCount++;
      if (this._ciCount >= MAX_CI_COUNT) {
        log.warn(`${this._tag} V.8: gave up after ${this._ciCount} CI bursts (no ANSam)`);
        this._setState(ST.PARKED);
        this.emit('failed', 'timeout-no-ansam');
        return;
      }
      this._sendCiBurst();
      return;
    }
  }

  _sendCiBurst() {
    // 4 CI sequences back to back (spandsp uses 4; spec says ≥3).
    const ci = V8.buildCIBytes();
    this._writeV8Frame(Buffer.concat([ci, ci, ci, ci]));
    this._fskTxOn = true;
    this._stateTimer = 0;          // wait for queue to drain
    this._setState(ST.CI_ON);
  }

  _originateStartCm() {
    // After Te silence, build CM frame and start transmitting.
    // Re-init V.21 TX on ch1 to drop any residual CI bits.
    this._initV21Tx('originate');

    const localModes = this._buildLocalModes();
    log.info(`${this._tag} V.8 CM: sending ${this._summarize(localModes)}`);
    this._cmBytes = V8.buildCMBytes(localModes);
    this._writeV8Frame(this._cmBytes);
    this._fskTxOn = true;

    // Reset watchdog for JM wait.
    this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1000);
    this._setState(ST.CM_ON);
  }

  // _onJmReceived handles incoming JM from the answer side (originate role).
  _onJmReceived(msg) {
    if (this._state !== ST.CM_ON) return;
    if (!msg.bytes) return;

    // spandsp rule: two byte-identical JMs.
    if (this._lastCmBytes && Buffer.compare(this._lastCmBytes, msg.bytes) === 0) {
      this._gotCmJm = true;
      this._receivedFar = msg.modes;
      log.info(`${this._tag} V.8 JM accepted: modes=${this._summarize(msg.modes)}`);
      this._originateStartCj();
    } else {
      this._lastCmBytes = Buffer.from(msg.bytes);
    }
  }

  _originateStartCj() {
    // Pick our negotiated protocol from the JM intersection.
    const protocol = this._selectProtocol(this._receivedFar);
    if (!protocol) {
      log.warn(`${this._tag} V.8: empty JM intersection, no deal`);
      this._setState(ST.PARKED);
      this.emit('failed', 'no-deal');
      return;
    }

    // Send CJ (3 zero bytes) per V.8 §7. spandsp's v8.c does fsk_tx_restart()
    // here, which we mirror by re-initializing the V.21 modulator: that
    // gives a clean modulator state (mark idle, fresh phase / symbol-timing
    // accumulator) so the peer's demod sees a quiet idle period followed by
    // a clean start bit.
    //
    // We additionally prepend 10 mark bits before CJ. That is NOT in the V.8
    // spec — V.8 §5.2.2 says CJ is "three consecutive octets of binary 0"
    // with no preamble. But our `FskModulator`+`FskDemodulator` pair needs
    // ~30 ms of mark idle for the demod's bandpass-filter envelope state and
    // CD warmup counter to settle BEFORE the first start-bit edge, otherwise
    // the demod locks onto the start bit a few samples late and frames the
    // first byte as 0xE0 (the leftover CM-sync byte signature) instead of
    // 0x00. Spandsp's FSK demod doesn't have this sensitivity because its
    // bandpass filters are wider and its bit-recovery uses a different
    // decision metric. The preamble is invisible to peers (mark idle is
    // indistinguishable from "no transmission" to a UART-framing demod) so
    // it costs us nothing in interop terms.
    this._initV21Tx('originate');
    this._v21tx.writeBits(new Array(10).fill(1));
    const cj = V8.buildCJBytes();
    this._v21tx.write(cj);
    this._fskTxOn = true;

    // Save for the result emission at SIGC expiry.
    this._result = {
      role: 'originate',
      modes: this._receivedFar,
      callFn: this._parms.callFn,
      protocol,
    };
    this._setState(ST.CJ_ON);
    this._stateTimer = 0;          // wait for queue to drain
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _setState(s) {
    if (s !== this._state) {
      log.debug(`${this._tag} state ${this._state} → ${s}`);
      this._state = s;
    }
  }

  _isRxActive() {
    if (this._role === 'answer') {
      return this._state === ST.CM_WAIT || this._state === ST.JM_ON;
    }
    return this._state === ST.CM_ON || this._state === ST.CJ_ON;
  }

  _initV21Rx(role) {
    // V.21 RX. role is OUR role; we listen on the OPPOSITE channel
    // (V8.js convention: V21Demodulator(channel) takes our TX channel).
    this._v21rx = new V21Demodulator(role === 'answer' ? 2 : 1);

    this._onV21Data = (buf) => {
      log.trace(`${this._tag} V.21 RX bytes: ` + buf.toString('hex') + ' (state=' + this._state + ')');
      const msgs = V8.parseV8Bytes(this._parser, buf);
      for (const m of msgs) this._handleParsedMsg(m);
    };
    this._v21rx.on('data', this._onV21Data);
  }

  _initV21Tx(role) {
    // Per V.21 spec, originate uses ch1 (980/1180 Hz), answer uses ch2
    // (1650/1850 Hz). Build a fresh modulator so its phase, queue and
    // baud accumulator all start from zero.
    const { V21Modulator } = require('./protocols/V21');
    this._v21tx = new V21Modulator(role === 'answer' ? 2 : 1);
  }

  _writeV8Frame(bytes) {
    if (!this._v21tx) return;
    // 10-bit mark preamble per V.8 §5.
    const preamble = new Array(10).fill(1);
    if (typeof this._v21tx.writeBits === 'function') {
      this._v21tx.writeBits(preamble);
    }
    this._v21tx.write(bytes);
  }

  _refillTxQueue() {
    // spandsp's "if (queue_contents(tx_queue) < 10) send_cm_jm(s);"
    // Keep the V.21 TX queue topped up so the peer never sees a gap
    // between message repetitions. JM gets repeated continuously
    // until CJ is detected; CM until JM is detected.
    if (!this._v21tx) return;

    if (this._role === 'answer' && this._state === ST.JM_ON) {
      if (this._v21tx._bits.length < 10 && this._jmBytes) {
        this._writeV8Frame(this._jmBytes);
      }
    } else if (this._role === 'originate' && this._state === ST.CM_ON) {
      if (this._v21tx._bits.length < 10 && this._cmBytes) {
        this._writeV8Frame(this._cmBytes);
      }
    }
  }

  _handleParsedMsg(msg) {
    log.debug(`${this._tag} V.8 RX: ${msg.type}` +
              (msg.modes ? ' modes=' + this._summarize(msg.modes) : '') +
              (msg.callFn !== undefined ? ' callFn=' + msg.callFn : ''));

    if (this._role === 'answer') {
      if (msg.type === 'CM/JM' && (this._state === ST.CM_WAIT)) {
        this._onCmReceived(msg);
      } else if (msg.type === 'CJ' && this._state === ST.JM_ON) {
        this._onCjReceived();
      }
    } else {
      if (msg.type === 'CM/JM' && this._state === ST.CM_ON) {
        this._onJmReceived(msg);
      }
    }
  }

  _handleTimeout() {
    if (this._state === ST.PARKED) return;
    if (this._role === 'answer' && this._state === ST.CM_WAIT) {
      log.warn(`${this._tag} V.8: timeout waiting for CM`);
      this._setState(ST.PARKED);
      this.emit('failed', 'timeout-no-cm');
    } else if (this._role === 'answer' && this._state === ST.JM_ON) {
      log.warn(`${this._tag} V.8: timeout waiting for CJ`);
      this._setState(ST.PARKED);
      this.emit('failed', 'timeout-no-cj');
    } else if (this._role === 'originate' && this._state === ST.CM_ON) {
      log.warn(`${this._tag} V.8: timeout waiting for JM`);
      this._setState(ST.PARKED);
      this.emit('failed', 'timeout-no-jm');
    }
  }

  _buildLocalModes() {
    const advertised = this._parms.modulations;
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
      pcm:    false,
    };
  }

  _selectProtocol(modes) {
    if (!modes) return null;
    // Caller's preference order from config; the FIRST mode that's
    // both advertised by us AND in the JM wins.
    const preference = cfg.protocolPreference || ['V22bis', 'V22', 'V23', 'V21'];
    return V8.selectProtocol(modes, preference);
  }

  _summarize(modes) {
    if (!modes) return '{}';
    return '{' + Object.keys(modes).filter(k => modes[k] === true).join(',') + '}';
  }
}

module.exports = { V8Sequencer, ST, AnsamGenerator };
