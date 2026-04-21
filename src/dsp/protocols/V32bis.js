'use strict';

/**
 * V.23    — 1200/75 bps split-speed FSK (unchanged from original)
 * V.32bis — 9600 bps 64-QAM at 1600 baud (6 bits/symbol)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN NOTES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a full rewrite of the V.32bis DSP. The original implementation
 * mirrored V.22bis's square-pulse + biquad-LPF architecture, which has
 * ~30% symbol-to-symbol ISI. That's fine for 4 levels per axis (16-QAM)
 * but catastrophic for 8 levels (64-QAM), where inter-level spacing is
 * smaller than the ISI energy.
 *
 * Key changes from the original:
 *   1. Root-raised-cosine (RRC) matched filtering on BOTH sides.
 *      TX emits each symbol through an RRC filter; RX samples the
 *      received signal through an identical RRC filter. The combined
 *      response is a raised-cosine, which is zero at all sampling
 *      instants except t=0 — i.e. zero ISI at the correct sampling
 *      phase. This is the single biggest win; measured in-band SNR
 *      on a constant symbol is 34.7 dB, within 2 dB of the G.711
 *      μ-law codec's own SNR ceiling (~37 dB for modem-amplitude
 *      signals). 64-QAM needs 22 dB for reliable decoding, so we
 *      have 12+ dB headroom for future impairments.
 *
 *   2. Proper I/Q modulation pipeline: scramble → map to 6-bit QAM
 *      symbol → shape through RRC → mix to carrier. Boundary-clean
 *      across generate() calls (each generate call may end mid-
 *      symbol; state is preserved).
 *
 *   3. Fractional symbol-timing strobe with linear interpolation.
 *      Replaces the rigid "strobe every SPS samples" with a phase
 *      accumulator that can be gradually adjusted to track clock
 *      drift — see TIMING_RECOVERY in the demodulator.
 *
 * Design parameters:
 *   Sample rate:    8000 Hz (RTP G.711)
 *   Baud:           1600
 *   Samples/symbol: 5 (integer — clean timing)
 *   Bits/symbol:    6 (64-QAM)
 *   Effective rate: 9600 bps uncoded
 *   RRC roll-off:   0.35 (α=0.35, band occupied ≈ baud × 1.35 = 2160 Hz)
 *   RRC span:       8 symbols (40 taps at SPS=5)
 *   Carriers:       orig=1200 Hz, answer=2400 Hz (1200 Hz separation)
 *                   Signal bandwidth ≈ ±1080 Hz around carrier, so:
 *                     orig band:    120-2280 Hz
 *                     answer band: 1320-3480 Hz
 *                   Very slight overlap in the 1320-2280 Hz region.
 *                   The RRC's α=0.35 rolloff attenuates enough that
 *                   cross-carrier bleed is well below the G.711 noise
 *                   floor in practice — measured BER in full-duplex
 *                   loopback is zero.
 *
 * Why 1600 baud instead of V.32bis's canonical 2400 baud? At 8 kHz
 * sample rate, 2400 baud gives SPS = 3.33. That's too few samples per
 * symbol for effective matched filtering in software — the RRC filter
 * needs at least 4-5 samples/symbol to approximate its theoretical
 * response. Real 2400-baud V.32bis relies on trellis coding to buy
 * back the noise margin that weak filtering loses. We can add TCM
 * later; for now, 1600 baud × 6 bits = 9600 bps, which matches the
 * target speed and leaves plenty of SNR margin.
 *
 * Going to 12000 bps will want TCM (same 2400 baud but with coded
 * 4-bit-per-symbol constellation) or a higher uncoded constellation
 * (1600 baud × 8 bits = 12800 bps, 256-QAM). The RRC architecture
 * here supports either path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEFERRED (future work, required for real-hardware PSTN path):
 *   • Gardner/Müller-Müller timing recovery to track SPA2102 and
 *     real-modem clock drift (±50 to ±200 ppm). Currently _sampleStep
 *     is fixed at 1.0 — works indefinitely on localhost and LAN SIP
 *     where both sides share a clock, will drift off filter peak
 *     after tens of seconds with a real ATA in the loop. See
 *     TIMING_RECOVERY in V32bisDemodulator.
 *   • Costas carrier-recovery loop to track carrier frequency/phase
 *     offset. A real modem's carrier will be a few Hz off nominal.
 *   • LMS decision-directed equalizer with proper training sequence
 *     to compensate for PSTN line impairments (dispersive response,
 *     group-delay distortion).
 *   • Trellis-coded modulation (V.32bis canonical) for 3 dB coding
 *     gain, enabling 12-14.4 kbps reliably.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const {
  NCO, BiquadFilter, SinglePoleLPF, Scrambler, TWO_PI,
} = require('../Primitives');

const SR     = config.rtp.sampleRate;  // 8000 Hz
const SCPOLY = config.modem.scramblerPolynomial;
const V23CFG = config.modem.carriers.V23;

// ═══════════════════════════════════════════════════════════════════════════
// V.23 FSK (unchanged from original)
// ═══════════════════════════════════════════════════════════════════════════

class V23FSKModulator {
  constructor({ markFreq, spaceFreq, baud }) {
    this._mark = markFreq; this._space = spaceFreq;
    this._baud = baud; this._sps = SR / baud;
    this._bitQueue = []; this._samplesLeft = 0;
    this._curFreq = markFreq; this._phase = 0; this._amp = 0.4;
  }
  write(bytes) {
    for (const byte of bytes) {
      this._bitQueue.push(0);
      for (let b = 0; b < 8; b++) this._bitQueue.push((byte >> b) & 1);
      this._bitQueue.push(1);
    }
  }
  generate(n) {
    const out = new Float32Array(n);
    let pos = 0;
    while (pos < n) {
      if (this._samplesLeft <= 0) {
        const bit = this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
        this._curFreq     = bit === 1 ? this._mark : this._space;
        this._samplesLeft = Math.round(this._sps);
      }
      const chunk = Math.min(this._samplesLeft, n - pos);
      const inc   = TWO_PI * this._curFreq / SR;
      for (let i = 0; i < chunk; i++) {
        out[pos + i] = this._amp * Math.cos(this._phase);
        this._phase = (this._phase + inc) % TWO_PI;
      }
      this._samplesLeft -= chunk;
      pos += chunk;
    }
    return out;
  }
  get idle() { return this._bitQueue.length === 0; }
}

class V23FSKDemodulator extends EventEmitter {
  constructor({ markFreq, spaceFreq, baud }) {
    super();
    this._sps = SR / baud;
    const Q = 12;
    this._bpMark  = BiquadFilter.makeBandPass(markFreq,  Q, SR);
    this._bpSpace = BiquadFilter.makeBandPass(spaceFreq, Q, SR);
    const alpha = 1 - Math.exp(-TWO_PI * baud / SR);
    this._envM = new SinglePoleLPF(alpha);
    this._envS = new SinglePoleLPF(alpha);
    this._sampleCount = 0;
    this._samplesPerSym = Math.round(this._sps);
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
  }
  process(samples) {
    for (const x of samples) {
      const m = this._envM.process(Math.abs(this._bpMark.process(x)));
      const s = this._envS.process(Math.abs(this._bpSpace.process(x)));
      const bit = m > s ? 1 : 0;
      if (++this._sampleCount >= this._samplesPerSym) {
        this._onBit(bit);
        this._sampleCount = 0;
      }
    }
  }
  _onBit(bit) {
    switch (this._state) {
      case 'IDLE':
        if (bit === 0) { this._state = 'DATA'; this._dataBits = []; this._bitCount = 0; }
        break;
      case 'DATA':
        this._dataBits.push(bit);
        if (++this._bitCount === 8) this._state = 'STOP';
        break;
      case 'STOP':
        if (bit === 1) {
          let byte = 0;
          for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
          if (byte !== 0xFF) this.emit('data', Buffer.from([byte]));
        }
        this._state = 'IDLE';
        break;
    }
  }
}

class V23 extends EventEmitter {
  constructor(role) {
    super();
    const isAnswer = role === 'answer';
    this.modulator = new V23FSKModulator(isAnswer
      ? { markFreq: V23CFG.forwardMark,  spaceFreq: V23CFG.forwardSpace,  baud: 1200 }
      : { markFreq: V23CFG.backwardMark, spaceFreq: V23CFG.backwardSpace, baud: 75   });
    this.demodulator = new V23FSKDemodulator(isAnswer
      ? { markFreq: V23CFG.backwardMark, spaceFreq: V23CFG.backwardSpace, baud: 75   }
      : { markFreq: V23CFG.forwardMark,  spaceFreq: V23CFG.forwardSpace,  baud: 1200 });
    this.demodulator.on('data', buf => this.emit('data', buf));
  }
  write(data)           { this.modulator.write(data); }
  generateAudio(n)      { return this.modulator.generate(n); }
  receiveAudio(samples) { this.demodulator.process(samples); }
  get name()            { return 'V23'; }
  get bps()             { return 1200; }
}


// ═══════════════════════════════════════════════════════════════════════════
// V.32bis — native binding wrapper
// ═══════════════════════════════════════════════════════════════════════════
//
// This is a thin JS wrapper around the spandsp-backed V32bisNative class
// (see src/native/v32bis_spandsp_binding.cc). The underlying engine is
// spandsp's V.17 PHY, which provides the mature trellis-coded-QAM
// modulation/demodulation at 2400 baud with 4 rate fallbacks:
//
//   14400 bps → 128-QAM (6 data + 1 trellis parity bits/symbol)
//   12000 bps → 64-QAM  (5 data + 1 trellis parity bits/symbol)
//    9600 bps → 32-QAM  (4 data + 1 trellis parity bits/symbol)
//    7200 bps → 16-QAM  (3 data + 1 trellis parity bits/symbol)
//    4800 bps → 4-QAM  (2 data bits/symbol, no trellis)
//
// Design contrast with V.22bis wrapper:
//   • No V.32 AA gate — V.32bis's signal AA at 1800 Hz is exactly what
//     we expect to receive from a V.32bis caller; silencing it is
//     counter-productive.
//   • No caller-silence gate — V.17 RX's filtering doesn't trip on its
//     own TX echo the way V.22bis's 1200 Hz RX did.
//   • No blind-S1 detector — V.32bis has no S1; that was a V.22bis
//     edge case.
//   • Single bit-rate commitment at construction time. Multi-rate
//     negotiation (rate renegotiation during training) is not wired
//     up — if we need it, it'd go in Handshake.js's V.32bis state
//     machine. For now we trust the caller's AT+MS command to pin a
//     rate and construct V32bis with that rate.

const path                  = require('path');
let _nativeMod;
try {
  _nativeMod = require(path.join(__dirname, '..', '..', '..',
                                 'build', 'Release', 'synthmodem_v22.node'));
} catch (err) {
  throw new Error(
    'synthmodem_v22 native addon not built — run `npm install` in the ' +
    'project root. Underlying error: ' + err.message
  );
}

const { V32bisNative } = _nativeMod;
if (!V32bisNative) {
  throw new Error('synthmodem_v22 addon loaded but V32bisNative export missing');
}

const { makeLogger } = require('../../logger');
const _v32log = makeLogger('V32bis');

// Int16 ↔ Float32 conversion factor (spandsp uses signed 16-bit PCM).
const V32_I16_TO_FLOAT = 1 / 32768;

// Listen window after construction. If no CARRIER_UP or TRAINING_SUCCEEDED
// fires during this window, we emit 'ready' with remoteDetected=false so
// Handshake.js can declare handshake-failed. V.17 training is longer than
// V.22bis (up to ~1.2 s of segment 1/2/3/4 training), so we give it more
// runway than V.22bis's window.
const V32_LISTEN_WINDOW_MS = 12000;

// Time between first CARRIER_UP and our 'remote-detected' confirmation.
// V.17's CARRIER_UP fires on as little as a few symbols of energy, so
// we need hysteresis to reject brief spikes. 300 ms matches what worked
// for V.22bis.
const V32_CARRIER_STABLE_MS = 300;

class V32bis extends EventEmitter {
  constructor(role, bitRate) {
    super();

    this._role        = role;
    this._bitRate     = bitRate || 14400;
    this._name        = 'V32bis';
    this._bps         = this._bitRate;
    this._carrierUp   = false;
    this._remoteDetected = false;
    this._carrierStabilityTimer = null;
    this._rawUpCount   = 0;
    this._rawDownCount = 0;
    this._trained     = false;
    this._readyFired  = false;
    this._closed      = false;
    this._listenTimer = null;
    this._gracePeriodTimer = null;

    // Construct native.
    this._native = new V32bisNative(
      role === 'originate' ? 'originate' : 'answer',
      this._bitRate,
      (ev) => this._onNativeEvent(ev)
    );

    _v32log.info(`V32bis init: role=${role} bitRate=${this._bitRate}`);

    // Fire 'listening' so Handshake.js's listener receives it. Attached
    // after `new V32bis()` returns, so we defer to next tick.
    setImmediate(() => {
      if (!this._closed) this.emit('listening');
    });

    // Listen window. On expiry, give a final 2-second grace period for a
    // late CARRIER_UP before declaring failure. Observed live: CARRIER_UP
    // can arrive 200-300ms AFTER the listen window closes (V.17 continues
    // training attempts well past the window expiration). Waiting an extra
    // 2s catches that without significantly delaying genuine failure cases.
    this._listenTimer = setTimeout(() => {
      this._listenTimer = null;
      if (this._readyFired || this._closed) return;
      if (this._remoteDetected) {
        // Already confirmed stable carrier — we shouldn't be here (ready
        // should have fired), but handle defensively.
        _v32log.info('V32bis listen-window expired but remote already detected — accepting');
        this._fireReady(true);
        return;
      }
      _v32log.info(
        `V32bis listen-window expired (${V32_LISTEN_WINDOW_MS}ms) — ` +
        `raw events: UP=${this._rawUpCount} DOWN=${this._rawDownCount}, ` +
        `TRAINING_FAILED×${this._trainingFailedCount || 0}; ` +
        `starting 2s grace period for late carrier`
      );
      this._gracePeriodTimer = setTimeout(() => {
        this._gracePeriodTimer = null;
        if (this._readyFired || this._closed) return;
        if (this._remoteDetected) {
          _v32log.info('V32bis late carrier arrived during grace period — accepting connection');
          this._fireReady(true);
        } else {
          _v32log.warn('V32bis grace period elapsed with no remote carrier — declaring failure');
          this._fireReady(false);
        }
      }, 2000);
    }, V32_LISTEN_WINDOW_MS);
  }

  // ─── Native event handler ────────────────────────────────────────────────

  _onNativeEvent(ev) {
    if (this._closed) return;

    if (ev.type === 'data') {
      if (config.logging.logModemData) {
        _v32log.trace(`V32bis RX ${ev.bytes.length}B: ${ev.bytes.toString('hex')}`);
      }
      this.emit('data', ev.bytes);
      return;
    }

    if (ev.type !== 'status') return;

    switch (ev.name) {
      case 'CARRIER_UP': {
        this._rawUpCount++;
        if (!this._remoteDetected) {
          if (!this._carrierStabilityTimer) {
            this._carrierStabilityTimer = setTimeout(() => {
              this._carrierStabilityTimer = null;
              if (this._remoteDetected || this._closed) return;
              this._remoteDetected = true;
              _v32log.info('V32bis CARRIER_UP — remote carrier detected (stable)');
              this.emit('remote-detected', { rms: 1 });
              // If we're within the grace period (post listen-window),
              // accept immediately rather than waiting for grace timer.
              if (!this._readyFired && this._gracePeriodTimer) {
                clearTimeout(this._gracePeriodTimer);
                this._gracePeriodTimer = null;
                _v32log.info('V32bis accepting late carrier during grace period');
                this._fireReady(true);
              }
            }, V32_CARRIER_STABLE_MS);
          }
        }
        if (!this._carrierUp) {
          this._carrierUp = true;
          _v32log.trace('V32bis carrier flag up');
        }
        break;
      }

      case 'CARRIER_DOWN': {
        this._rawDownCount++;
        if (this._carrierStabilityTimer) {
          clearTimeout(this._carrierStabilityTimer);
          this._carrierStabilityTimer = null;
        }
        if (this._carrierUp) {
          this._carrierUp = false;
          _v32log.trace('V32bis carrier flag down');
        }
        break;
      }

      case 'TRAINING_SUCCEEDED': {
        if (!this._trained) {
          this._trained = true;
          if (this._carrierStabilityTimer) {
            clearTimeout(this._carrierStabilityTimer);
            this._carrierStabilityTimer = null;
          }
          // V.17's current_bit_rate getter in spandsp is hardcoded to
          // return 14400 (this is inside the WIP stub). Trust the
          // construction-time bitRate for now.
          if (!this._remoteDetected) {
            this._remoteDetected = true;
            this.emit('remote-detected', { rms: 1 });
          }
          _v32log.info(`V32bis TRAINING_SUCCEEDED — bps=${this._bps}`);
          this._fireReady(true);
        }
        break;
      }

      case 'TRAINING_FAILED': {
        // V.17's TRAINING_FAILED fires repeatedly (dozens of times) as each
        // training-phase attempt flunks. Don't spam the log or thrash the
        // grace timer. Just track that at least one TRAINING_FAILED was
        // seen; the listen-window expiry handler will honor the grace
        // period and wait for a late CARRIER_UP.
        this._trainingFailedCount = (this._trainingFailedCount || 0) + 1;
        if (this._trainingFailedCount === 1) {
          _v32log.debug('V32bis TRAINING_FAILED (first occurrence) — continuing to listen for late carrier');
        }
        break;
      }

      case 'TRAINING_IN_PROGRESS':
        _v32log.trace('V32bis TRAINING_IN_PROGRESS');
        break;

      default:
        _v32log.trace(`V32bis status ${ev.name} (code ${ev.code})`);
        break;
    }
  }

  _fireReady(remoteDetected) {
    if (this._readyFired) return;
    this._readyFired = true;
    if (this._listenTimer) {
      clearTimeout(this._listenTimer);
      this._listenTimer = null;
    }
    if (this._gracePeriodTimer) {
      clearTimeout(this._gracePeriodTimer);
      this._gracePeriodTimer = null;
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
      _v32log.trace(`V32bis TX ${data.length}B: ${data.toString('hex')}`);
    }
    this._native.writeData(data);
  }

  // ─── Audio ───────────────────────────────────────────────────────────────

  generateAudio(n) {
    const i16 = this._native.tx(n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = i16[i] * V32_I16_TO_FLOAT;
    return out;
  }

  receiveAudio(samples) {
    if (this._closed) return;
    const n = samples.length;
    // Float32 → Int16 for spandsp. V.17 expects the same ±32767 full scale
    // used by V.22bis.
    const i16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = Math.round(samples[i] * 32767);
      if (v > 32767)  v = 32767;
      if (v < -32768) v = -32768;
      i16[i] = v;
    }
    this._native.rx(i16);
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
    if (this._gracePeriodTimer) {
      clearTimeout(this._gracePeriodTimer);
      this._gracePeriodTimer = null;
    }
    try { this._native.close(); } catch (_) {}
  }

  // ─── Accessors ───────────────────────────────────────────────────────────

  get name()            { return this._name; }
  get bps()             { return this._bps; }
  get carrierDetected() { return this._carrierUp; }
}

module.exports = { V23, V32bis };
