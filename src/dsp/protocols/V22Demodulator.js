'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// V.22 / V.22bis demodulator
// ───────────────────────────────────────────────────────────────────────────
// Faithful port of spandsp's v22bis_rx.c (Steve Underwood, 2004), with
// algorithm structure, constants, and per-stage state machine preserved.
//
// Attribution / licensing
// -----------------------
// This file is a direct port of the V.22bis receive logic from the spandsp
// project (https://github.com/freeswitch/spandsp), originally written by
// Steve Underwood <steveu@coppice.org> and copyright (C) 2004 Steve
// Underwood. The original code is distributed under the GNU Lesser
// General Public License version 2.1.
//
// Algorithms ported here include the receive pulse-shaping/bandpass
// filter, the AGC formula, the Costas-style carrier tracking, the
// complex T/2 LMS equalizer, the Gardner symbol-synchronisation
// detector, and the multi-stage RX training state machine — all
// reproducing spandsp's behaviour with matching constants and
// time budgets. The bandpass-RRC filter coefficients are in
// V22RxRRC.js (also distributed as a derived port under the GPL).
//
// Accordingly, this file is distributed under the terms of the GPL.
//
// What is preserved from prior phases of the synthmodem rework
// ------------------------------------------------------------
// Where spandsp uses fixed-point math we use IEEE float (the float
// alternate-build path of spandsp is what we follow most closely; the
// arithmetic of int16 power-meter values is reproduced by scaling input
// floats by 32768 before squaring so that dbm0 thresholds work as
// written).
//
//   - The UART framer's stop-bit-resync improvement (phase 1). spandsp
//     itself does not have a UART layer — it emits raw bits through a
//     put_bit callback, which our async layer used to feed into a separate
//     UART class. We have a small UART framer integrated here so the
//     async data interface is `emit('data', Buffer)` like before.
//   - The carrier-presence gate concept. spandsp's `signal_present` flag
//     and our `enableCarrierGate` are equivalent — when carrier is off,
//     no bytes flow. We keep the constructor flag for diagnostic A/B.
//
// One deliberate deviation from spandsp's RX
// ------------------------------------------
//   - On a carrier-down edge, spandsp's v22bis_rx_restart zeros the rrc
//     filter buffer and resets the power meter to zero. In our specific
//     RX environment our own TX guard tone (1800 Hz) leaks into the RX
//     path and causes the carrier-presence threshold to flap during
//     early-call ramp-up. Zeroing the buffer/meter on every flap turns
//     each transient dip into a multi-millisecond re-acquisition cycle,
//     producing a self-sustaining ~85 Hz flap. We instead keep the
//     filter and power state across transient down-edges, resetting only
//     the higher-level training/equalizer/UART state. See
//     `_softCarrierDownReset` for the full rationale.
//
// What is new (replacing my phase-4 ad-hoc work):
//   - The full RX training state machine (SYMBOL_ACQUISITION through
//     NORMAL_OPERATION) per spandsp. Bytes only flow through `decode_baud`
//     in NORMAL_OPERATION. Pre-NORMAL stages descramble for state-machine
//     bookkeeping via `decode_baudx` but do not emit.
//   - The bandpass-RRC filter approach (27-tap, 12 phase-shifted coeff
//     sets) instead of mix-then-LPF. Tables in V22RxRRC.js.
//   - One-shot AGC during SYMBOL_ACQUISITION, locked thereafter.
//   - Costas-style carrier tracking (`track_carrier`) running every symbol
//     decision, with per-stage `carrier_track_p` / `carrier_track_i`.
//   - Complex T/2 LMS equalizer with 17 taps, `EQUALIZER_DELTA = 0.25`,
//     initial coefficient (3.0, 0.0) at PRE_LEN=8.
//   - Gardner timing recovery rotated to 45° (spandsp's `symbol_sync`),
//     two-step convergence (256 → 32 → 4 over the SYMBOL_ACQUISITION
//     stage), integrate-and-dump with threshold 16.
//
// Reference for line-by-line verification:
//   /home/claude/synthmodem-github/src/native/spandsp/src/v22bis_rx.c
//   /home/claude/synthmodem-github/src/native/spandsp/src/v22bis_rx_*.h
//   /home/claude/synthmodem-github/src/native/spandsp/src/spandsp/private/v22bis.h
// ═══════════════════════════════════════════════════════════════════════════

const { EventEmitter } = require('events');

const {
  SR, BAUD, SPS, CARRIER_LOW, CARRIER_HIGH, GUARD_FREQ,
  PHASE_CHANGE, QUADRANT_POINT,
  RRC_BETA, RRC_SPAN, rrcImpulse, buildRrcTaps, RRC,
  V22Scrambler,
} = require('./V22Common');

const {
  RX_PULSESHAPER_COEFF_SETS,
  RX_PULSESHAPER_FILTER_STEPS,
  RX_PULSESHAPER_1200_RE,
  RX_PULSESHAPER_1200_IM,
  RX_PULSESHAPER_2400_RE,
  RX_PULSESHAPER_2400_IM,
} = require('./V22RxRRC');

// ─── Constants ─────────────────────────────────────────────────────────────

// Scaling: spandsp processes int16 (full-scale 32767). Our pipeline is
// normalized float (full-scale ~1.0). To keep spandsp's dbm0 power-meter
// math working unchanged, we scale input samples by 32768 before squaring
// in the power meter. AGC then produces a small `agc_scaling` value as in
// spandsp; we apply it the same way.
const RX_AMP_SCALE = 32768;

// Equalizer
const EQUALIZER_LEN     = 17;
const EQUALIZER_PRE_LEN = 8;
const EQUALIZER_DELTA   = 0.25;          // spandsp v22bis_rx.c #97
const LMS_LEAK_RATE     = 0.9999;        // spandsp complex_vector_float.c #199

// Power meter
const POWER_METER_SHIFT = 5;             // spandsp v22bis_rx.c v22bis_rx_restart power_meter_init(s, 5)

// dbm0 thresholds (spandsp v22bis_rx_set_signal_cutoff with -45.5)
//   carrier_on  = -45.5 + 2.5 = -43 dBm0
//   carrier_off = -45.5 - 2.5 = -48 dBm0
//
// power_meter_level_dbm0(level) returns: db_to_power_ratio(level - DBM0_MAX_POWER) * 32767²
// where DBM0_MAX_POWER = 3.14 (spandsp telephony.h). Then it's multiplied by 0.232.
// For -43:  level - 3.14 = -46.14 dB → ratio = 10^(-46.14/10) = 2.434e-5
//           value = 2.434e-5 * 32767² * 0.232 = 6063
// For -48:  level - 3.14 = -51.14 dB → ratio = 7.694e-6
//           value = 7.694e-6 * 32767² * 0.232 = 1917
// We hard-code these computed values — they are constants once the
// spandsp call sequence is known.
const CARRIER_ON_POWER  = 6063;
const CARRIER_OFF_POWER = 1917;

// dbm0 / power-meter helpers (matching spandsp's telephony.h)
const DBM0_MAX_POWER          = 3.14;
const POWER_METER_FULL_SCALE  = 32767 * 32767;

function dbToPowerRatio(db) {
  return Math.pow(10, db / 10);
}
function powerMeterLevelDbm0(level) {
  let l = level - DBM0_MAX_POWER;
  if (l > 0) l = 0;
  return Math.floor(dbToPowerRatio(l) * POWER_METER_FULL_SCALE);
}

// AGC formula in spandsp (float build, line 918):
//   agc_scaling = 0.18f * 3.60f / root_power
//   where root_power = sqrt(power) = sqrt(int16² IIR) ≈ s_int16_rms
const AGC_SCALING_NUMERATOR = 0.18 * 3.60;

// Initial AGC scaling before signal arrives (spandsp v22bis_rx_restart
// line 1029: `s->rx.agc_scaling = 0.0005f * 0.025f`)
const AGC_INITIAL_SCALING = 0.0005 * 0.025;

// Carrier-tracking PI loop constants. Spandsp uses int32 phase units where
// 2^32 = one cycle, with track_p/track_i in those units. Our NCO uses
// floating-point phase in radians (0..2π). Convert by 2π/2^32 ≈ 1.4628e-9.
//
// spandsp v22bis_rx_restart (line 1048-1050):
//   carrier_track_i = (calling_party) ? 8000.0f : 40000.0f
//   carrier_track_p = 8000000.0f
// spandsp track_carrier updates carrier_phase += track_p*error in int32
// units. In our radians: carrier_phase += track_p * error * (2π/2^32).
// Pre-bake the conversion.
const PHASE_UNITS_TO_RADIANS = (2 * Math.PI) / 4294967296;  // 2π / 2^32
const CARRIER_TRACK_P                 = 8000000.0 * PHASE_UNITS_TO_RADIANS; // ≈ 0.01170
const CARRIER_TRACK_I_CALLER          =    8000.0 * PHASE_UNITS_TO_RADIANS; // ≈ 1.170e-5
const CARRIER_TRACK_I_ANSWERER        =   40000.0 * PHASE_UNITS_TO_RADIANS; // ≈ 5.852e-5
// spandsp also slows track_i to 8000 once NORMAL_OPERATION is reached (line 728).
const CARRIER_TRACK_I_NORMAL          =    8000.0 * PHASE_UNITS_TO_RADIANS;

// Pulse-shaper coefficient sets — spandsp uses 12 phase positions across
// one symbol. eq_put_step is decremented by COEFF_SETS each sample; when
// it crosses zero a half-baud worth of work happens. The reload value
// `40 * COEFF_SETS / (3 * 2)` = 80, which advances the equalizer by one
// half-symbol worth of fractional phase. Why 40/(3*2)? It's the number
// of input samples per half-baud expressed in coeff-set units:
//   (SR / BAUD / 2) * COEFF_SETS = (8000/600/2) * 12 = (20/3) * 12 = 80
// So with COEFF_SETS = 12 and the multiplier convention spandsp uses, it
// works out to integer 80 (i.e. 40*12/6).
const RX_EQ_STEP_PER_HALF_BAUD = (40 * RX_PULSESHAPER_COEFF_SETS) / (3 * 2); // = 80

// Gardner timing recovery
const GARDNER_THRESHOLD = 16;            // |integrate| ≥ 16 → kick the timing
// Step sizes (spandsp v22bis_rx_restart line 1040 + SYMBOL_ACQUISITION
// transitions in process_half_baud):
//   restart:                gardner_step = 256
//   training_count == 30:   gardner_step =  32
//   training_count >= 40:   gardner_step =   4
const GARDNER_STEP_INITIAL  = 256;
const GARDNER_STEP_COARSE   =  32;
const GARDNER_STEP_NORMAL   =   4;

// 45° rotation factor for symbol_sync's Gardner detector. Pre-baked from
// spandsp's `static const complexf_t x = {0.894427f, 0.44721f}` (line 396).
const ROT_45_RE = 0.894427;
const ROT_45_IM = 0.44721;

// Phase-step lookup (spandsp v22bis_rx.c line 137).
//   phase_steps[(nearest>>2) - last(nearest>>2)] = raw_bits
const PHASE_STEPS_RX = [1, 0, 2, 3];

// 16-way decision space-map for V.22bis 16-QAM (spandsp v22bis_rx.c line 127).
const SPACE_MAP_V22BIS = [
  [11, 9, 9, 6, 6, 7],
  [10, 8, 8, 4, 4, 5],
  [10, 8, 8, 4, 4, 5],
  [13,12,12, 0, 0, 2],
  [13,12,12, 0, 0, 2],
  [15,14,14, 1, 1, 3],
];

// V.22bis constellation. Spandsp's table (v22bis_tx.c line 384). Indices
// 0-15: high 2 bits = quadrant, low 2 bits = position-within-quadrant.
const V22BIS_CONSTELLATION = [
  { re:  1, im:  1 }, { re:  3, im:  1 }, { re:  1, im:  3 }, { re:  3, im:  3 },
  { re: -1, im:  1 }, { re: -1, im:  3 }, { re: -3, im:  1 }, { re: -3, im:  3 },
  { re: -1, im: -1 }, { re: -3, im: -1 }, { re: -1, im: -3 }, { re: -3, im: -3 },
  { re:  1, im: -1 }, { re:  1, im: -3 }, { re:  3, im: -1 }, { re:  3, im: -3 },
];

// RX training stage codes (spandsp private/v22bis.h)
const RX_TRAINING = {
  NORMAL_OPERATION:                     0,
  SYMBOL_ACQUISITION:                   1,
  LOG_PHASE:                            2,  // unused in spandsp main path
  UNSCRAMBLED_ONES:                     3,
  UNSCRAMBLED_ONES_SUSTAINING:          4,
  SCRAMBLED_ONES_AT_1200:               5,
  SCRAMBLED_ONES_AT_1200_SUSTAINING:    6,
  WAIT_FOR_SCRAMBLED_ONES_AT_2400:      7,
  PARKED:                               8,
};

// Convert milliseconds → V.22 symbols (600 baud). Mirrors spandsp's
// `ms_to_symbols(t)` macro (= t * 600 / 1000).
function msToSymbols(ms) { return Math.floor((ms * BAUD) / 1000); }

// ─── PowerMeter ────────────────────────────────────────────────────────────

class PowerMeter {
  constructor(shift = POWER_METER_SHIFT) {
    this.shift = shift;
    this.reading = 0;
  }
  reset() { this.reading = 0; }
  /** Update with one int16-equivalent sample. Returns running power. */
  update(amp) {
    this.reading += ((amp * amp) - this.reading) >> this.shift;
    return this.reading;
  }
}

// ─── QAMDemodulator ────────────────────────────────────────────────────────
//
// Outer loop: per-sample work (carrier tracking, RRC filter, power meter).
// Inner loop: every half-baud (when eq_put_step crosses 0), compute the
// AGC-scaled and frequency-shifted complex sample, push it into the
// equalizer buffer; on alternate insertions, run the full symbol pipeline
// (Gardner sync, equalizer get, slicer, training state machine).
// ═══════════════════════════════════════════════════════════════════════════

class QAMDemodulator extends EventEmitter {
  constructor({
    carrier,
    bitsPerSymbol = 2,
    bitRate = 1200,           // 1200 (V.22) or 2400 (V.22bis); affects S1 detection.
                              // When 2400, the demod actively listens for an S1
                              // pattern from the remote and can promote
                              // _negotiatedBitRate to 2400 internally. When 1200,
                              // S1 detection is suppressed and the demod stays
                              // committed to 1200 — the right behaviour for plain
                              // V.22.
    enableCarrierGate = true,
    debugSink = null,
  }) {
    super();

    if (carrier !== CARRIER_LOW && carrier !== CARRIER_HIGH) {
      throw new Error(`Invalid V.22 carrier: ${carrier} (expected ${CARRIER_LOW} or ${CARRIER_HIGH})`);
    }
    if (bitRate !== 1200 && bitRate !== 2400) {
      throw new Error(`Invalid V.22 bitRate: ${bitRate} (expected 1200 or 2400)`);
    }

    this._carrier = carrier;
    this._bps     = bitsPerSymbol;
    // Calling-party RX listens on the high carrier (2400); answerer on
    // low (1200). Spandsp uses `s->calling_party` to switch RRC tables
    // and carrier_track_i; we map from carrier frequency.
    this._callingParty = (carrier === CARRIER_HIGH);

    this._enableCarrierGate = enableCarrierGate;
    this._debugSink = debugSink;

    // Emit a bit through the descrambler + UART framer.
    this._descrambler = new V22Scrambler();

    // Signal-present hysteresis (carrier_on_power / carrier_off_power)
    this._signalPresent = false;
    this._gatedBytes    = 0;

    // Pick the RRC tables for this carrier
    if (this._callingParty) {
      this._rxRrcRe = RX_PULSESHAPER_2400_RE;
      this._rxRrcIm = RX_PULSESHAPER_2400_IM;
    } else {
      this._rxRrcRe = RX_PULSESHAPER_1200_RE;
      this._rxRrcIm = RX_PULSESHAPER_1200_IM;
    }

    // RRC filter circular buffer (raw input × RX_AMP_SCALE)
    this._rrcBuf      = new Float32Array(RX_PULSESHAPER_FILTER_STEPS);
    this._rrcStep     = 0;

    // Power meter
    this._powerMeter  = new PowerMeter();

    // Equalizer
    this._eqCoeffRe   = new Float32Array(EQUALIZER_LEN);
    this._eqCoeffIm   = new Float32Array(EQUALIZER_LEN);
    this._eqBufRe     = new Float32Array(EQUALIZER_LEN);
    this._eqBufIm     = new Float32Array(EQUALIZER_LEN);
    this._eqStep      = 0;
    this._eqPutStep   = 20 - 1;
    this._eqDelta     = EQUALIZER_DELTA / EQUALIZER_LEN;

    // Carrier NCO (DDS replacement). Phase in radians.
    this._carrierPhase     = 0;
    // Initial rate puts the local oscillator at the expected carrier.
    // Spandsp uses HIGH for caller, LOW for answerer.
    this._carrierBaseRate  = (2 * Math.PI * carrier) / SR;
    this._carrierPhaseRate = this._carrierBaseRate;

    // Carrier-tracking PI gains
    this._carrierTrackP    = CARRIER_TRACK_P;
    this._carrierTrackI    = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;

    // AGC
    this._agcScaling       = AGC_INITIAL_SCALING;

    // Gardner state
    this._gardnerIntegrate = 0;
    this._gardnerStep      = GARDNER_STEP_INITIAL;
    this._totalBaudTimingCorrection = 0;

    // Per-baud-pair phase tracker
    this._baudPhase        = 0;

    // Training state machine
    this._training         = RX_TRAINING.SYMBOL_ACQUISITION;
    this._trainingCount    = 0;
    this._patternRepeats   = 0;
    this._lastRawBits      = 0;
    this._constellationState = 0;
    this._sixteenWayDecisions = false;
    this._negotiatedBitRate   = 1200;
    this._bitRate          = bitRate;

    // UART framer state
    this._uartState  = 'IDLE';
    this._uartBits   = [];
    this._uartCount  = 0;

    // Diagnostic counters
    this._totalSamples = 0;
    this._symbolsSeen  = 0;

    // Smoothed magnitude of the post-RRC, pre-AGC complex filter output
    // (in normalized-input units, i.e. divided back by RX_AMP_SCALE).
    // Exposed as `symbolMag` for the V22 protocol module's carrier-
    // detection logic, which is independent of this demodulator's own
    // training state machine. Threshold V22_REMOTE_MAG_THRESHOLD = 0.02
    // in V22.js is calibrated to this scale.
    this._symbolMagSmoothed = 0;

    // Initial equalizer coefficients
    this._equalizerCoefficientReset();
  }

  // Diagnostic accessors
  get signalPresent() { return this._signalPresent; }
  get gatedBytes()    { return this._gatedBytes; }
  get trainingStage() { return this._training; }
  get totalSamples()  { return this._totalSamples; }
  /** Smoothed RMS-ish magnitude of the post-RRC complex carrier signal,
   *  in normalized-audio units. Calibrated to match the prior demodulator's
   *  `symbolMag` scale (~0.05-0.15 on real V.22 signal); the V22 protocol
   *  module's carrier-detection threshold (V22_REMOTE_MAG_THRESHOLD = 0.02)
   *  is set against this scale. Independent of the demodulator's own
   *  carrier-presence gate and training state machine — it gives the V22
   *  protocol layer a separate handshake-time signal-quality estimate. */
  get symbolMag()     { return this._symbolMagSmoothed; }

  /** Hard reset. Equivalent of spandsp's v22bis_rx_restart. */
  reset() {
    this._descrambler.reset();
    this._signalPresent = false;
    this._gatedBytes    = 0;
    this._rrcBuf.fill(0);
    this._rrcStep       = 0;
    this._powerMeter.reset();
    this._eqStep        = 0;
    this._eqPutStep     = 20 - 1;
    this._carrierPhase  = 0;
    this._carrierPhaseRate = this._carrierBaseRate;
    this._carrierTrackI = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;
    this._agcScaling    = AGC_INITIAL_SCALING;
    this._gardnerIntegrate = 0;
    this._gardnerStep   = GARDNER_STEP_INITIAL;
    this._totalBaudTimingCorrection = 0;
    this._baudPhase     = 0;
    this._training      = RX_TRAINING.SYMBOL_ACQUISITION;
    this._trainingCount = 0;
    this._patternRepeats = 0;
    this._lastRawBits   = 0;
    this._constellationState = 0;
    this._sixteenWayDecisions = false;
    this._negotiatedBitRate = 1200;
    this._uartState     = 'IDLE';
    this._uartBits      = [];
    this._uartCount     = 0;
    this._symbolMagSmoothed = 0;
    this._equalizerCoefficientReset();
  }

  /** Reset only the equalizer coefficients (used on retrain).
   *  Mirror of spandsp's v22bis_equalizer_coefficient_reset. */
  _equalizerCoefficientReset() {
    for (let i = 0; i < EQUALIZER_LEN; i++) {
      this._eqCoeffRe[i] = 0;
      this._eqCoeffIm[i] = 0;
    }
    // Initial coefficient (3.0, 0.0) at PRE_LEN. Spandsp v22bis_rx.c line 198.
    this._eqCoeffRe[EQUALIZER_PRE_LEN] = 3.0;
    this._eqDelta = EQUALIZER_DELTA / EQUALIZER_LEN;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Equalizer get / tune
  //
  // The buffer is a circular dot-product: for each tap k, the buffer
  // position is (eqStep + k) % EQUALIZER_LEN. spandsp's
  // cvec_circular_dot_prodf does the same.
  //
  // For tune, the LMS update is:
  //   coeff[k] += eq_delta * conj(buf[k]) * err
  // where err = target - z. spandsp's cvec_circular_lmsf.
  // ─────────────────────────────────────────────────────────────────────

  _equalizerGet() {
    let zRe = 0, zIm = 0;
    let p = this._eqStep;
    for (let k = 0; k < EQUALIZER_LEN; k++) {
      const bRe = this._eqBufRe[p], bIm = this._eqBufIm[p];
      const cRe = this._eqCoeffRe[k], cIm = this._eqCoeffIm[k];
      // (bRe + j*bIm) * (cRe + j*cIm) = (bRe*cRe - bIm*cIm) + j*(bRe*cIm + bIm*cRe)
      zRe += bRe * cRe - bIm * cIm;
      zIm += bRe * cIm + bIm * cRe;
      if (++p >= EQUALIZER_LEN) p = 0;
    }
    return { re: zRe, im: zIm };
  }

  _tuneEqualizer(zRe, zIm, tRe, tIm) {
    const eRe = (tRe - zRe) * this._eqDelta;
    const eIm = (tIm - zIm) * this._eqDelta;
    let p = this._eqStep;
    // LMS update with leak. spandsp's cvec_lmsf (complex_vector_float.c:201)
    // applies a per-step leak factor of 0.9999 to all coefficients to
    // prevent unbounded drift in the absence of strong driving error. Without
    // the leak our equalizer drifts during long noisy training periods (e.g.
    // when the slicer is making decisions on a partially-converged
    // constellation, the residual error is small but consistently biased,
    // and integrated noise grows the coefficients unbounded over thousands
    // of symbols).
    for (let k = 0; k < EQUALIZER_LEN; k++) {
      const bRe = this._eqBufRe[p], bIm = this._eqBufIm[p];
      // coeff = leak*coeff + conj(buf) * err
      //       = leak*coeff + (bRe - j*bIm) * (eRe + j*eIm)
      //       = leak*coeff + (bRe*eRe + bIm*eIm) + j*(bRe*eIm - bIm*eRe)
      this._eqCoeffRe[k] = this._eqCoeffRe[k] * LMS_LEAK_RATE + (bRe * eRe + bIm * eIm);
      this._eqCoeffIm[k] = this._eqCoeffIm[k] * LMS_LEAK_RATE + (bRe * eIm - bIm * eRe);
      if (++p >= EQUALIZER_LEN) p = 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Carrier tracking PI loop. spandsp track_carrier (lines 266-304).
  //   error = z.im * target.re - z.re * target.im
  //   carrier_phase_rate += track_i * error
  //   carrier_phase      += track_p * error
  // ─────────────────────────────────────────────────────────────────────

  _trackCarrier(zRe, zIm, tRe, tIm) {
    const error = zIm * tRe - zRe * tIm;
    this._carrierPhaseRate += this._carrierTrackI * error;
    this._carrierPhase     += this._carrierTrackP * error;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Symbol synchronization (Gardner). spandsp symbol_sync (lines 381-457).
  //   Look at the 3 most recent equalizer-buffer entries (newest, mid,
  //   oldest). For 4-way decisions, rotate by 45° to maximize Gardner
  //   sensitivity. Compute Gardner error metric and integrate.
  //   When |integrate| ≥ THRESHOLD, kick eq_put_step.
  // ─────────────────────────────────────────────────────────────────────

  _symbolSync() {
    // Get indices of the 3 most recent buffer entries.
    //   aa[0] = eqStep - 1 (newest)
    //   aa[1] = eqStep - 2 (mid)
    //   aa[2] = eqStep - 3 (oldest)
    let aa = [0, 0, 0];
    let j = this._eqStep;
    for (let i = 0; i < 3; i++) {
      if (--j < 0) j = EQUALIZER_LEN - 1;
      aa[i] = j;
    }
    const newRe = this._eqBufRe[aa[0]], newIm = this._eqBufIm[aa[0]];
    const midRe = this._eqBufRe[aa[1]], midIm = this._eqBufIm[aa[1]];
    const oldRe = this._eqBufRe[aa[2]], oldIm = this._eqBufIm[aa[2]];

    // spandsp's Gardner detector (v22bis_rx.c lines 415-419 / 435-436):
    //   p = (eq_buf[aa[2]].re - eq_buf[aa[0]].re) * eq_buf[aa[1]].re
    //     = (oldest - newest) * mid
    //   q = (oldest - newest) * mid     [imag]
    // Our previous code was (newest - oldest) — sign inverted, which made
    // the timing loop integrate in the wrong direction. With the wrong
    // sign the equalizer never converges on a clean constellation: each
    // half-baud sample drifts away from the symbol center instead of
    // toward it.
    let p, q;
    if (this._sixteenWayDecisions) {
      p = (oldRe - newRe) * midRe;
      q = (oldIm - newIm) * midIm;
    } else {
      // Rotate to 45° (via complex multiply by ROT_45). spandsp does this
      // for 4-way decisions (lines 423-437) to maximise Gardner sensitivity.
      const aRe = oldRe * ROT_45_RE - oldIm * ROT_45_IM;  // a = oldest rotated
      const aIm = oldRe * ROT_45_IM + oldIm * ROT_45_RE;
      const bRe = midRe * ROT_45_RE - midIm * ROT_45_IM;  // b = mid rotated
      const bIm = midRe * ROT_45_IM + midIm * ROT_45_RE;
      const cRe = newRe * ROT_45_RE - newIm * ROT_45_IM;  // c = newest rotated
      const cIm = newRe * ROT_45_IM + newIm * ROT_45_RE;
      p = (aRe - cRe) * bRe;     // (oldest - newest) * mid
      q = (aIm - cIm) * bIm;
    }
    this._gardnerIntegrate += (p + q > 0) ? this._gardnerStep : -this._gardnerStep;
    if (Math.abs(this._gardnerIntegrate) >= GARDNER_THRESHOLD) {
      const kick = (this._gardnerIntegrate / GARDNER_THRESHOLD) | 0;
      this._eqPutStep += kick;
      this._totalBaudTimingCorrection += kick;
      this._gardnerIntegrate = 0;
      if (this._debugSink) {
        this._debugSink({
          type: 'gardner_kick',
          t: this._totalSamples / SR,
          kick,
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Slicer + descrambler. Two flavours, matching spandsp:
  //   decode_baud:  emits bits via put_bit (i.e. user-facing). Used in
  //                 NORMAL_OPERATION only.
  //   decode_baudx: returns bitstream as a 4-bit int, no put_bit.
  //                 Used in training stages for state-machine bookkeeping.
  // ─────────────────────────────────────────────────────────────────────

  _decodeBaud(nearest) {
    const rawBits = PHASE_STEPS_RX[((nearest >> 2) - (this._constellationState >> 2)) & 3];
    this._constellationState = nearest;
    // The first two bits are the quadrant (always emitted).
    this._putBit(this._descrambler.descramble((rawBits >> 1) & 1));
    this._putBit(this._descrambler.descramble(rawBits & 1));
    if (this._sixteenWayDecisions) {
      this._putBit(this._descrambler.descramble((nearest >> 1) & 1));
      this._putBit(this._descrambler.descramble(nearest & 1));
    }
    return rawBits;
  }

  _decodeBaudx(nearest) {
    const rawBits = PHASE_STEPS_RX[((nearest >> 2) - (this._constellationState >> 2)) & 3];
    this._constellationState = nearest;
    let outBits = this._descrambler.descramble((rawBits >> 1) & 1);
    outBits = (outBits << 1) | this._descrambler.descramble(rawBits & 1);
    if (this._sixteenWayDecisions) {
      outBits = (outBits << 1) | this._descrambler.descramble((nearest >> 1) & 1);
      outBits = (outBits << 1) | this._descrambler.descramble(nearest & 1);
    }
    return { rawBits, outBits };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-half-baud processing. spandsp process_half_baud (lines 459-824).
  // Called once per T/2 (every other call inserts into eqBuf only; the
  // second of each pair triggers full symbol decision and state machine).
  // ─────────────────────────────────────────────────────────────────────

  _processHalfBaud(sampleRe, sampleIm) {
    // Insert into circular equalizer buffer.
    this._eqBufRe[this._eqStep] = sampleRe;
    this._eqBufIm[this._eqStep] = sampleIm;
    if (++this._eqStep >= EQUALIZER_LEN) this._eqStep = 0;

    // On alternate (mid-baud) insertions, do nothing further.
    this._baudPhase ^= 1;
    if (this._baudPhase) return;

    // We have a whole-baud T point. Run Gardner, then equalizer get, then
    // slicer + state machine.
    this._symbolSync();

    const z = this._equalizerGet();

    // Capture pre-state-machine values so we can emit transition events
    // after the state machine has run. This lets the V22bis sequencer
    // observe RX-driven state changes (S1 detection → 2400 negotiation,
    // RX entering NORMAL_OPERATION) without polling.
    const prevTraining        = this._training;
    const prevNegotiated      = this._negotiatedBitRate;
    const prevSixteenWay      = this._sixteenWayDecisions;

    // Slicer
    let nearest;
    if (this._sixteenWayDecisions) {
      let re = (z.re + 3.0) | 0;
      let im = (z.im + 3.0) | 0;
      if (re > 5) re = 5; else if (re < 0) re = 0;
      if (im > 5) im = 5; else if (im < 0) im = 0;
      nearest = SPACE_MAP_V22BIS[re][im];
    } else {
      // Rotate to 45° for trivial slicing (spandsp lines 525-540).
      const zzRe = z.re * ROT_45_RE - z.im * ROT_45_IM;
      const zzIm = z.re * ROT_45_IM + z.im * ROT_45_RE;
      nearest = 0x01;
      if (zzRe < 0) nearest |= 0x04;
      if (zzIm < 0) { nearest ^= 0x04; nearest |= 0x08; }
    }

    let target = V22BIS_CONSTELLATION[nearest];
    let rawBits = 0;
    let bitstream = 0;

    this._symbolsSeen++;

    // ─── Training state machine ───────────────────────────────────────
    switch (this._training) {

      case RX_TRAINING.NORMAL_OPERATION: {
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        this._tuneEqualizer(z.re, z.im, target.re, target.im);
        rawBits = PHASE_STEPS_RX[((nearest >> 2) - (this._constellationState >> 2)) & 3];
        // S1 retrain pattern detector (spandsp lines 555-577). 50+ bauds of
        // dibit 00/11 alternation => retrain. We don't currently support
        // retrain mid-call; just log if seen.
        if ((this._lastRawBits ^ rawBits) === 0x3) {
          this._patternRepeats++;
        } else {
          if (this._patternRepeats >= 50 && (this._lastRawBits === 0x3 || this._lastRawBits === 0x0)) {
            // Retrain requested. spandsp resets to SCRAMBLED_ONES_AT_1200.
            // We do too — and reset the equalizer.
            this._patternRepeats = 0;
            this._trainingCount = 0;
            this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
            this._equalizerCoefficientReset();
            if (this._debugSink) {
              this._debugSink({ type: 'retrain', t: this._totalSamples / SR });
            }
          }
          this._patternRepeats = 0;
        }
        this._decodeBaud(nearest);
        break;
      }

      case RX_TRAINING.SYMBOL_ACQUISITION: {
        // Allow time for the Gardner algorithm to settle the symbol timing.
        // spandsp lines 581-606.
        target = { re: z.re, im: z.im };  // spandsp: target = &z (no error)
        if (++this._trainingCount >= 40) {
          this._gardnerStep = GARDNER_STEP_NORMAL;
          this._patternRepeats = 0;
          this._training = this._callingParty
            ? RX_TRAINING.UNSCRAMBLED_ONES
            : RX_TRAINING.SCRAMBLED_ONES_AT_1200;
          // spandsp resets negotiated_bit_rate = 1200 here ("be pessimistic
          // and see what the handshake brings"). We follow suit ONLY if the
          // V.22bis answerer-side sequencer hasn't already promoted us to
          // 2400 via its spectral S1 detector. Without this guard, a
          // spectral S1 detection that fires DURING SYMBOL_ACQUISITION (its
          // 80 ms window can complete before the demod's 67 ms acquisition
          // does) gets clobbered when the demod exits, leaving the demod
          // back on the 1200 path while V22bis TX is on 2400. See
          // V22.V22bis._onS1Detected for the producer side.
          if (this._negotiatedBitRate !== 2400) {
            this._negotiatedBitRate = 1200;
          }
        } else if (this._trainingCount === 30) {
          this._gardnerStep = GARDNER_STEP_COARSE;
        }
        break;
      }

      case RX_TRAINING.UNSCRAMBLED_ONES: {
        // Calling modem only. We expect the answerer's USB1 (unscrambled
        // ones at 1200 bit/s) to be received here. spandsp lines 607-654.
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        rawBits = PHASE_STEPS_RX[((nearest >> 2) - (this._constellationState >> 2)) & 3];
        this._constellationState = nearest;
        if (rawBits !== this._lastRawBits) this._patternRepeats = 0;
        else this._patternRepeats++;
        if (++this._trainingCount === msToSymbols(155 + 456)) {
          // After 155+456 ms, see if the last 456 ms was clean unscrambled
          // 11 or 00 pattern.
          if (rawBits === this._lastRawBits
              && (rawBits === 0x3 || rawBits === 0x0)
              && this._patternRepeats >= msToSymbols(456)) {
            // Looks like answerer is sending clean unscrambled ones/zeros.
            // (We would set TX to U0011 here if implementing 2400 bit/s
            // request; we don't, so just continue as 1200 bit/s.)
          }
          this._patternRepeats = 0;
          this._trainingCount = 0;
          this._training = RX_TRAINING.UNSCRAMBLED_ONES_SUSTAINING;
        }
        break;
      }

      case RX_TRAINING.UNSCRAMBLED_ONES_SUSTAINING: {
        // Calling modem only. Wait for end of unscrambled ones; transition
        // when the pattern changes. spandsp lines 655-672.
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        rawBits = PHASE_STEPS_RX[((nearest >> 2) - (this._constellationState >> 2)) & 3];
        this._constellationState = nearest;
        if (rawBits !== this._lastRawBits) {
          this._trainingCount = 0;
          this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
          this._patternRepeats = 0;
        }
        break;
      }

      case RX_TRAINING.SCRAMBLED_ONES_AT_1200: {
        // Both modems pass through here. Wait for the scrambled-1s
        // training pattern and either detect S1 (request 2400) or time
        // out into NORMAL_OPERATION (calling) / SUSTAINING (answering).
        // spandsp lines 673-777.
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        this._tuneEqualizer(z.re, z.im, target.re, target.im);
        const decoded = this._decodeBaudx(nearest);
        rawBits   = decoded.rawBits;
        bitstream = decoded.outBits;
        this._trainingCount++;
        if (this._negotiatedBitRate === 1200) {
          // Search for S1 — alternating 00/11 dibits ⇒ raw_bits XOR last
          // = 0x3 each transition.
          if ((this._lastRawBits ^ rawBits) === 0x3) {
            this._patternRepeats++;
          } else {
            if (this._patternRepeats >= 15
                && (this._lastRawBits === 0x3 || this._lastRawBits === 0x0)) {
              // S1 detected. 2400 bit/s requested by the other side.
              if (this._bitRate === 2400) {
                if (!this._callingParty) {
                  // We would set TX to U0011 here if we drive TX from RX
                  // events. We don't from here; the protocol layer above
                  // handles negotiation. Just record the negotiation.
                }
                this._negotiatedBitRate = 2400;
              }
            }
            this._patternRepeats = 0;
          }
          if (this._trainingCount >= msToSymbols(270)) {
            // Timed out — committed to 1200 bit/s.
            if (this._callingParty) {
              this._training = RX_TRAINING.NORMAL_OPERATION;
              this._carrierTrackI = CARRIER_TRACK_I_NORMAL;
            } else {
              this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING;
              this._trainingCount = 0;
            }
          }
        } else {
          // Negotiated 2400 bit/s — wait for the 16-way decision phase.
          if (this._callingParty) {
            if (this._trainingCount >= msToSymbols(100 + 450)) {
              this._sixteenWayDecisions = true;
              this._training = RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400;
              this._patternRepeats = 0;
              this._carrierTrackI = CARRIER_TRACK_I_NORMAL;
            }
          } else {
            if (this._trainingCount >= msToSymbols(450)) {
              this._sixteenWayDecisions = true;
              this._training = RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400;
              this._patternRepeats = 0;
            }
          }
        }
        break;
      }

      case RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING: {
        // Answerer-only sustain stage. spandsp lines 778-790.
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        this._tuneEqualizer(z.re, z.im, target.re, target.im);
        this._decodeBaudx(nearest);
        if (++this._trainingCount > msToSymbols(270 + 765)) {
          this._training = RX_TRAINING.NORMAL_OPERATION;
        }
        break;
      }

      case RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400: {
        // 16-way decisions; wait for 32 sustained 1s ⇒ NORMAL_OPERATION.
        // spandsp lines 791-810.
        target = V22BIS_CONSTELLATION[nearest];
        this._trackCarrier(z.re, z.im, target.re, target.im);
        this._tuneEqualizer(z.re, z.im, target.re, target.im);
        bitstream = this._decodeBaudx(nearest).outBits;
        if (bitstream === 0xF) {
          if (++this._patternRepeats >= 9) {
            this._training = RX_TRAINING.NORMAL_OPERATION;
          }
        } else {
          this._patternRepeats = 0;
        }
        break;
      }

      case RX_TRAINING.PARKED:
      default:
        // Failed to train. Wait for carrier drop.
        break;
    }

    this._lastRawBits = rawBits;

    // Emit transition events for the V22bis sequencer (no-op for
    // V.22 which doesn't subscribe). Three signals matter:
    //
    //   1. negotiated-rate-change: the demod has detected S1 and
    //      committed to 2400 (or some other transition that changes
    //      _negotiatedBitRate). The TX sequencer wants this so it
    //      can begin its U0011 → TIMED_S11 → S1111 progression.
    //   2. sixteen-way-on: demod has switched to 16-QAM slicing.
    //      Informational; the TX sequencer uses the rate-change and
    //      the entry to NORMAL_OPERATION to decide TX timing.
    //   3. training-done: demod has entered NORMAL_OPERATION. The
    //      TX sequencer waits for its own TX timer in TIMED_S11 /
    //      S1111 before emitting 'ready', but a NORMAL_OPERATION
    //      event from the demod tells us bytes are about to flow.
    if (this._negotiatedBitRate !== prevNegotiated) {
      this.emit('negotiated-rate-change', {
        bitRate: this._negotiatedBitRate,
      });
    }
    if (this._sixteenWayDecisions !== prevSixteenWay) {
      this.emit('sixteen-way-change', {
        sixteenWay: this._sixteenWayDecisions,
      });
    }
    if (this._training !== prevTraining
        && this._training === RX_TRAINING.NORMAL_OPERATION) {
      this.emit('training-done', {
        bitRate: this._negotiatedBitRate,
      });
    }

    if (this._debugSink) {
      this._debugSink({
        type: 'symbol',
        t: this._totalSamples / SR,
        I: z.re, Q: z.im,
        nearest,
        training: this._training,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Outer per-sample loop. spandsp v22bis_rx (lines 827-980).
  // ─────────────────────────────────────────────────────────────────────

  process(samples) {
    if (!samples || samples.length === 0) return;

    // RRC center index (carrier-aligned, no phase shift) for power-meter
    // tap calculation. spandsp uses `[6]` (the middle of the 12 sets).
    const centerCoeffSet = 6;
    const rrcReCenter = this._rxRrcRe[centerCoeffSet];

    for (let i = 0; i < samples.length; i++) {
      this._totalSamples++;

      // Push input sample (scaled to int16-equivalent so power-meter math
      // matches spandsp's dbm0 thresholds).
      const ampScaled = samples[i] * RX_AMP_SCALE;
      this._rrcBuf[this._rrcStep] = ampScaled;
      if (++this._rrcStep >= RX_PULSESHAPER_FILTER_STEPS) this._rrcStep = 0;

      // Compute I-channel filter for power tracking, using middle coeff
      // set (no phase shift).
      let ii = 0;
      {
        let p = this._rrcStep;
        for (let k = 0; k < RX_PULSESHAPER_FILTER_STEPS; k++) {
          ii += this._rrcBuf[p] * rrcReCenter[k];
          if (++p >= RX_PULSESHAPER_FILTER_STEPS) p = 0;
        }
      }

      const power = this._powerMeter.update(ii);

      // Update symbolMag — a normalized-units estimate of the RMS magnitude
      // of the carrier in the receive band. Independent of the carrier-
      // presence gate so the V22 protocol layer's separate handshake
      // detection logic (which uses Goertzel + this magnitude) keeps
      // working through the early-call carrier-flap window. sqrt(power) is
      // already the IIR-smoothed RMS of the filtered signal at int16 scale;
      // divide back by RX_AMP_SCALE to match the prior demodulator's
      // normalized-input convention (where V22_REMOTE_MAG_THRESHOLD = 0.02
      // is calibrated against this scale).
      this._symbolMagSmoothed = Math.sqrt(power) / RX_AMP_SCALE;

      // Carrier-presence hysteresis with edge events.
      if (this._signalPresent) {
        if (power < CARRIER_OFF_POWER) {
          // Carrier dropped — restart. (spandsp calls v22bis_restart, then
          // continues; we do the same.)
          this._softCarrierDownReset();
          continue;
        }
      } else {
        if (power < CARRIER_ON_POWER) continue;
        this._signalPresent = true;
        this.emit('carrierUp');
        if (this._debugSink) {
          this._debugSink({ type: 'carrier_edge', t: this._totalSamples / SR, edge: 'up' });
        }
      }

      if (this._training === RX_TRAINING.PARKED) continue;

      // Drive symbol-strobe pacing from eq_put_step. Decrement by
      // COEFF_SETS each sample; when it crosses 0 we run a half-baud's
      // worth of work.
      this._eqPutStep -= RX_PULSESHAPER_COEFF_SETS;
      if (this._eqPutStep <= 0) {
        // SYMBOL_ACQUISITION owns the AGC; once we leave that stage the
        // gain is locked.
        if (this._training === RX_TRAINING.SYMBOL_ACQUISITION) {
          let rootPower = Math.sqrt(power);
          if (rootPower < 1) rootPower = 1;
          this._agcScaling = AGC_SCALING_NUMERATOR / rootPower;
        }

        // Compute filter outputs at the current fractional phase position.
        let step = -this._eqPutStep;
        if (step > RX_PULSESHAPER_COEFF_SETS - 1) step = RX_PULSESHAPER_COEFF_SETS - 1;
        const reCoeff = this._rxRrcRe[step];
        const imCoeff = this._rxRrcIm[step];
        let fii = 0, fqq = 0;
        let p = this._rrcStep;
        for (let k = 0; k < RX_PULSESHAPER_FILTER_STEPS; k++) {
          const x = this._rrcBuf[p];
          fii += x * reCoeff[k];
          fqq += x * imCoeff[k];
          if (++p >= RX_PULSESHAPER_FILTER_STEPS) p = 0;
        }
        // Apply AGC.
        const sampleRe = fii * this._agcScaling;
        const sampleIm = fqq * this._agcScaling;

        // Mix to baseband by multiplying by exp(-jωt) where ω is the
        // local NCO. spandsp computes:
        //   z = dds_lookup_complexf(carrier_phase)  // = cos+j*sin
        //   zz.re = sample.re*z.re - sample.im*z.im      ← real part of  s*z
        //   zz.im = -sample.re*z.im - sample.im*z.re     ← imag of -conj(s*z)?
        //
        // Re-deriving: spandsp's intent is multiply-by-conj(carrier) i.e.
        // mix down. With z = e^(jθ) this is s · e^(-jθ) =
        //   (sRe + jsIm)(cos θ - j sin θ) =
        //     (sRe cos + sIm sin) + j(sIm cos - sRe sin)
        // But spandsp's expression with the negative imaginary signs is
        // equivalent if their `dds_lookup_complexf(phase)` returns
        // (cos, sin) of the phase but they apply a sign flip elsewhere.
        // We replicate spandsp's exact formula bit-for-bit.
        const cs = Math.cos(this._carrierPhase);
        const sn = Math.sin(this._carrierPhase);
        const zzRe =  sampleRe * cs - sampleIm * sn;
        const zzIm = -sampleRe * sn - sampleIm * cs;

        // Reload eq_put_step.
        this._eqPutStep += RX_EQ_STEP_PER_HALF_BAUD;

        this._processHalfBaud(zzRe, zzIm);
      }

      // Advance carrier NCO for next sample.
      this._carrierPhase += this._carrierPhaseRate;
      if (this._carrierPhase >= 2 * Math.PI) {
        this._carrierPhase -= 2 * Math.PI;
      } else if (this._carrierPhase < 0) {
        this._carrierPhase += 2 * Math.PI;
      }
    }
  }

  // Soft-reset on carrier-drop edge.
  //
  // Spandsp's v22bis_rx_restart zeros the rrc filter buffer and power
  // meter on every signal-loss event. That works on clean phone lines,
  // where signal-loss is genuine end-of-call. In our environment, our
  // own TX guard tone (1800 Hz) leaks into the RX path with energy
  // ~400× the actual caller's 1200 Hz signal during early ramp-up.
  // The 1200 Hz bandpass filter rejects 1800 Hz at -36 to -44 dB,
  // but small leak-through pulses cross the carrier-on threshold and
  // dip below it cyclically. If we zero the buffer + power meter on
  // every dip, we then need ~27 samples to refill and re-acquire,
  // creating a self-sustaining ~85 Hz flap during early-call ramp-up.
  //
  // Deliberate deviation from spandsp: keep the rrc buffer and power
  // meter intact across transient down-edges. Reset only the higher-
  // level state (training, equalizer, descrambler, UART). On a real
  // end-of-call, the buffer drains naturally over the next ~27 samples
  // as new (silent) input flushes the old signal samples. On a
  // transient dip, the buffer stays primed and the power meter
  // doesn't need to re-ramp from zero.
  //
  // This is the only architectural deviation from spandsp's RX. The
  // motivation is documented; behavior on clean phone lines (no
  // guard-tone leakage) is unchanged because the gate doesn't flap
  // there in the first place.
  _softCarrierDownReset() {
    if (this._signalPresent) {
      this.emit('carrierDown');
      if (this._debugSink) {
        this._debugSink({ type: 'carrier_edge', t: this._totalSamples / SR, edge: 'down' });
      }
    }
    this._signalPresent = false;
    this._descrambler.reset();
    // Intentionally do NOT zero rrc filter buffer or power meter — see
    // comment above. The remaining state resets match spandsp.
    this._eqStep = 0;
    this._eqPutStep = 20 - 1;
    this._carrierPhase = 0;
    this._carrierPhaseRate = this._carrierBaseRate;
    this._carrierTrackI = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;
    this._agcScaling = AGC_INITIAL_SCALING;
    this._gardnerIntegrate = 0;
    this._gardnerStep = GARDNER_STEP_INITIAL;
    this._totalBaudTimingCorrection = 0;
    this._baudPhase = 0;
    this._training = RX_TRAINING.SYMBOL_ACQUISITION;
    this._trainingCount = 0;
    this._patternRepeats = 0;
    this._lastRawBits = 0;
    this._constellationState = 0;
    this._sixteenWayDecisions = false;
    this._negotiatedBitRate = 1200;
    this._uartState = 'IDLE';
    this._uartBits = [];
    this._uartCount = 0;
    // Don't reset _symbolMagSmoothed either — it tracks the input signal
    // independent of the demod's training state; resetting it would
    // create the same flap on the symbolMag side that we just removed
    // from the power-meter side.
    this._equalizerCoefficientReset();
  }

  // ─────────────────────────────────────────────────────────────────────
  // UART framer + byte gate.
  //
  // Bits arrive via _putBit (called from _decodeBaud). 1 start bit (0),
  // 8 data bits (LSB first), 1 stop bit (1). We preserve the phase-1
  // resync improvement: emit the byte regardless of stop-bit value,
  // rather than dropping the whole byte on a single stop-bit error.
  //
  // Byte emission gate: only emit while signal_present AND not in
  // training (i.e. NORMAL_OPERATION). The latter is guaranteed by the
  // decode_baud-only-in-NORMAL_OPERATION discipline above, but we keep
  // a defensive check here too.
  // ─────────────────────────────────────────────────────────────────────

  _putBit(bit) {
    if (this._uartState === 'IDLE') {
      if (bit === 0) {
        this._uartState = 'DATA';
        this._uartBits  = [];
        this._uartCount = 0;
      }
    } else if (this._uartState === 'DATA') {
      this._uartBits.push(bit);
      if (++this._uartCount === 8) this._uartState = 'STOP';
    } else if (this._uartState === 'STOP') {
      // v22-fix-phase1: emit regardless of stop-bit value. A single bit
      // error in the stop bit shouldn't destroy the whole byte; emitting
      // the (possibly slightly corrupted) byte yields better visible text
      // than dropping it entirely. spandsp doesn't have this layer at
      // all — its consumers handle UART framing.
      let byte = 0;
      for (let k = 0; k < 8; k++) byte |= this._uartBits[k] << k;

      const blockedByCarrier = this._enableCarrierGate && !this._signalPresent;
      const blockedByTraining = this._training !== RX_TRAINING.NORMAL_OPERATION;
      if (blockedByCarrier || blockedByTraining) {
        this._gatedBytes++;
      } else {
        this.emit('data', Buffer.from([byte]));
      }
      this._uartState = 'IDLE';
    }
  }
}

module.exports = {
  QAMDemodulator,
  V22Scrambler,
  // Spec / shared constants — re-exported for backward-compat with V22.js
  // and tools that imported them from V22Demodulator.js previously.
  SR, BAUD, SPS, CARRIER_LOW, CARRIER_HIGH, GUARD_FREQ,
  PHASE_CHANGE, QUADRANT_POINT,
  RRC, RRC_BETA, RRC_SPAN, rrcImpulse, buildRrcTaps,
  // RX-specific exports for diagnostics
  RX_TRAINING,
};
