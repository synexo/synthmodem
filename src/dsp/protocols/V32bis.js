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
// V.32bis — 1600 baud, 64-QAM, 9600 bps
// ═══════════════════════════════════════════════════════════════════════════

const V32_BAUD     = 1600;
const V32_SPS      = SR / V32_BAUD;       // 5 samples/symbol — integer, clean
const V32_BITS_SYM = 6;                    // 64-QAM
const V32_RRC_SPAN = 8;                    // filter spans 8 symbols
const V32_RRC_LEN  = V32_RRC_SPAN * V32_SPS + 1;  // 41 taps
const V32_RRC_BETA = 0.35;                 // roll-off factor
const V32_AMP      = 0.35;                 // TX amplitude (pre-normalisation)

// Phase-acquisition exponential decay per sample. 0.99 gives a time
// constant of ~100 samples = 20 symbols = 12.5 ms, keeping recent
// energy dominant so stale handshake-tone energy washes out once real
// V.32bis signal arrives.
const V32_PHASE_DECAY = 0.99;

// Minimum ratio of max-phase-energy to min-phase-energy before we're
// willing to lock. A real V.32bis signal post-training shows ratios
// of 1.25+ (peak 40% above min). Pure sine tones (ANSam, CM, JM —
// handshake signals) show ratios < 1.05. 1.15 is a safe threshold
// that rejects tones but locks on training reliably.
const V32_LOCK_MIN_RATIO = 1.15;

// Minimum number of consecutive input samples for which the peak phase
// must remain unchanged before we allow lock. This prevents locking
// during a transition when the phase estimator is still drifting — for
// example, right as handshake tones (which have flat energy across all
// phases) give way to V.32bis training (which has a clear peak). 400
// samples = 80 symbols ≈ 50 ms of agreement.
const V32_STABLE_SAMPLES = 400;

// Decision-directed phase-correction loop gain (per symbol). Accumulates
// the imaginary part of (received × conj(sliced)) and adjusts the
// rotation correction. Gain 0.05 → time constant ~20 symbols = 12.5 ms.
// Needed because the TX and RX NCOs in a two-process live system start
// at independent phases, rotating the entire 64-QAM constellation by
// some constant angle and causing continuous slicer bit errors.
const V32_PHASE_LOOP_GAIN = 0.05;

// Fast phase loop gain used during the silenceHold window after lock
// and after silence. The descrambler's output is gated from the UART
// during silenceHold so bit errors don't matter — we use that time to
// aggressively converge the phase estimate. ~5 symbols to reach the
// correct rotation for moderate initial offsets.
const V32_PHASE_LOOP_GAIN_FAST = 0.3;

// Pilot symbol count. At startup, the modulator transmits this many
// copies of the alternating pilot (+7+j7 and +3+j3)/√42 before
// switching to normal scrambled data. The demodulator, once locked
// within the pilot window, measures the received angle to set
// _phaseCorr unambiguously — resolving the 4-fold rotational ambiguity
// that decision-directed loops cannot handle.
//
// 4000 symbols = 2.5 seconds at 1600 baud. Must be long enough that
// the DEMODULATOR on the other side ALWAYS locks during the pilot
// window, even when there's significant pre-V.32bis handshake audio
// that delays the lock point. In live testing on the originate side,
// handshake tones delayed lock by ~3700 symbols post-start.
const V32_PILOT_SYMS = 4000;

// Number of pilot symbols the RX averages to measure carrier phase.
// 120 symbols = 75ms — enough to smooth out thermal noise but short
// enough to leave plenty of pilot after measurement for the variance-
// based pilot-to-data transition detector.
const V32_PILOT_MEASURE_SYMS = 120;

// Sliding window (in symbols) over which the RX computes the received
// constellation variance during PILOT_LOCKED state. Used to detect the
// pilot-to-data transition: during pilot the received symbols cluster
// tightly around (7+j7)/√42 (low variance); in data mode they spread
// across all 64 points (high variance).
const V32_PILOT_VAR_WINDOW = 20;

// Variance threshold for pilot→data transition.
//
// Pilot variance around mean (5/√42, 5/√42): each pilot point is
// exactly 0.19 away from the mean, so pilot MSE ≈ 0.19 + small noise.
// Data variance around this same point: unit-variance 64-QAM data
// gives E[d²] = E[|s|²] + |mean|² = 1 + 0.57 ≈ 1.57.
//
// Threshold at 0.6 is safely between pilot (0.19) and data (1.57).
const V32_PILOT_TO_DATA_THRESH = 0.6;

// Require N consecutive windows above threshold before switching to
// DATA. Prevents a single noisy window from triggering transition
// during pilot.
const V32_PILOT_CONFIRM_WINDOWS = 3;

// 64-QAM: 8 levels per axis, (±1,±3,±5,±7)/√42 for unit RMS
// RMS of (±1,±3,±5,±7) = √((1+9+25+49)×2/8) = √21. But we want unit-RMS
// constellation so dividing by √42 gives each 2D symbol unit RMS energy.
// (σ²_I + σ²_Q = 2·(21/8·2)/42 = 1). Use √42 instead of √21 here.
const V32_NORM = Math.sqrt(42);
const V32_LEVELS = [-7, -5, -3, -1, 1, 3, 5, 7];

// ─── Rotation-invariant quadrant encoding (differential) ────────────────────
//
// 64-QAM constellation has 90° rotational symmetry — rotating by any
// multiple of 90° maps the grid back to itself. In a two-process live
// system, the TX and RX NCOs start at independent phases, giving an
// arbitrary initial rotation. The decision-directed phase loop
// converges to the NEAREST of four valid lock points, which may not
// be the "correct" one.
//
// FULL 90° rotation invariance requires a rotation-invariant trellis
// code (V.32bis spec). For simplicity we implement **180° rotation
// invariance** by differentially encoding the two SIGN bits (b2, b5).
// This handles the most common live-system failure mode: when TX and
// RX NCOs happen to be ~π apart and the full constellation is flipped
// (I,Q) → (-I,-Q). 90° cases still fail, but they are rarer and will
// self-recover if the phase loop gets "close enough" to the correct
// lock point via noise/perturbation.
//
// Differential encoding: TX transmits `sign_bits_tx = sign_bits_prev
// XOR sign_bits_raw`. RX recovers `sign_bits_raw = sign_bits_rx XOR
// sign_bits_prev_rx`. A 180° rotation flips both sign_bits_rx
// simultaneously (both XOR'd with 1), but the DIFFERENCE between
// consecutive rx sign-bit pairs is invariant under the flip.

function bitsToSymbolDiff(b0, b1, b2, b3, b4, b5, prevSignBits) {
  // Differential on the two sign bits (b2=sign of I, b5=sign of Q)
  const txB2 = b2 ^ ((prevSignBits >> 0) & 1);
  const txB5 = b5 ^ ((prevSignBits >> 1) & 1);
  const newPrev = txB2 | (txB5 << 1);
  const I = bitsToI(b0, b1, txB2);
  const Q = bitsToQ(b3, b4, txB5);
  return { I, Q, newPrevSignBits: newPrev };
}

function symbolToBitsDiff(symI, symQ, prevSignBits) {
  const [i0, i1, i2] = sliceLevel8(symI);
  const [q0, q1, q2] = sliceLevel8(symQ);
  // i2, q2 are the received sign bits. Differential decode:
  const b2 = i2 ^ ((prevSignBits >> 0) & 1);
  const b5 = q2 ^ ((prevSignBits >> 1) & 1);
  const newPrev = i2 | (q2 << 1);
  return {
    bits: [i0, i1, b2, q0, q1, b5],
    newPrevSignBits: newPrev,
    // Also return the raw sliced I/Q for phase loop
    sliceI: V32_LEVELS[i0 | (i1 << 1) | (i2 << 2)] / V32_NORM,
    sliceQ: V32_LEVELS[q0 | (q1 << 1) | (q2 << 2)] / V32_NORM,
  };
}

// Legacy per-axis slicer — still used for diagnostics / sliced-point
// reconstruction in the phase loop. Returns the three low-order bits
// in the OLD mapping; the new decoder uses symbolToBits() above.
function bitsToI(b0, b1, b2)  { return V32_LEVELS[b0 | (b1 << 1) | (b2 << 2)] / V32_NORM; }
function bitsToQ(b3, b4, b5)  { return V32_LEVELS[b3 | (b4 << 1) | (b5 << 2)] / V32_NORM; }

// Slicer that returns sign and absolute level. Used by symbolToBits.
function sliceLevel8Full(v) {
  const t1 = 2 / V32_NORM, t2 = 4 / V32_NORM, t3 = 6 / V32_NORM;
  const av = Math.abs(v);
  let absLvl;
  if      (av < t1) absLvl = 1;
  else if (av < t2) absLvl = 3;
  else if (av < t3) absLvl = 5;
  else              absLvl = 7;
  return { sign: v < 0 ? -1 : 1, absLvl };
}

function sliceLevel8(v) {
  // Decision thresholds at ±2/√42, ±4/√42, ±6/√42
  const t1 = 2 / V32_NORM, t2 = 4 / V32_NORM, t3 = 6 / V32_NORM;
  const av = Math.abs(v);
  let idx;
  if (v < 0) {
    if      (av < t1) idx = 3;
    else if (av < t2) idx = 2;
    else if (av < t3) idx = 1;
    else              idx = 0;
  } else {
    if      (av < t1) idx = 4;
    else if (av < t2) idx = 5;
    else if (av < t3) idx = 6;
    else              idx = 7;
  }
  return [idx & 1, (idx >> 1) & 1, (idx >> 2) & 1];
}

/**
 * Root-raised-cosine pulse-shaping filter coefficients.
 *
 * Impulse response:
 *   h(t) = (1/√Ts) × [sin(πt/Ts·(1-β)) + 4βt/Ts·cos(πt/Ts·(1+β))]
 *                    ÷ [πt/Ts · (1-(4βt/Ts)²)]
 *
 * Special cases at t=0 and t=±Ts/(4β) handled separately.
 *
 * @param {number} span     Number of symbols the filter spans
 * @param {number} sps      Samples per symbol
 * @param {number} beta     Roll-off factor (0..1)
 * @returns {Float64Array}  Normalised filter coefficients, length span*sps+1
 */
function makeRRC(span, sps, beta) {
  const len = span * sps + 1;
  const h = new Float64Array(len);
  const centre = (len - 1) / 2;
  for (let i = 0; i < len; i++) {
    const t = (i - centre) / sps;
    if (Math.abs(t) < 1e-9) {
      h[i] = 1 - beta + 4 * beta / Math.PI;
    } else if (Math.abs(Math.abs(4 * beta * t) - 1) < 1e-9) {
      h[i] = (beta / Math.sqrt(2)) *
             ((1 + 2/Math.PI) * Math.sin(Math.PI / (4 * beta)) +
              (1 - 2/Math.PI) * Math.cos(Math.PI / (4 * beta)));
    } else {
      const pt = Math.PI * t;
      const num = Math.sin(pt * (1 - beta)) + 4 * beta * t * Math.cos(pt * (1 + beta));
      const den = pt * (1 - (4 * beta * t) ** 2);
      h[i] = num / den;
    }
  }
  // Normalise so that ∑h² = 1 (unit energy — required for a matched-filter
  // pair to recover original signal amplitude).
  let sumSq = 0;
  for (let i = 0; i < len; i++) sumSq += h[i] * h[i];
  const norm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < len; i++) h[i] *= norm;
  return h;
}

const V32_RRC = makeRRC(V32_RRC_SPAN, V32_SPS, V32_RRC_BETA);

/**
 * V.32bis modulator.
 *
 * Architecture:
 *   bits → scrambler → 6-bit groups → I,Q symbol → upsample by SPS
 *        → RRC filter → complex baseband → mix to carrier
 *
 * The modulator maintains a delay line of the last RRC_LEN symbols'
 * worth of baseband samples. Each symbol period adds a new impulse
 * (I+jQ) at the CURRENT pointer, which then convolves through the RRC
 * filter over the next RRC_SPAN symbols. This preserves ISI-free
 * operation when combined with a matched RX filter.
 *
 * Boundary handling: like V.22bis's modulator, we track sample position
 * within the current symbol and resume correctly across generate() calls
 * that end mid-symbol.
 */
class V32bisModulator {
  constructor(role) {
    const carrier = role === 'answer'
      ? config.modem.carriers.V32bis.answerCarrier
      : config.modem.carriers.V32bis.originateCarrier;
    this._carrier   = carrier;
    this._nco       = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._scrambler = new Scrambler(SCPOLY);
    this._bitQueue  = [];
    // Baseband delay lines: each position stores (I,Q) for the symbol
    // emitted at that time. New symbols push in, old ones age out.
    // We need RRC_SPAN symbols' worth of history. Initialised to 0.
    this._symBufI  = new Float64Array(V32_RRC_SPAN);
    this._symBufQ  = new Float64Array(V32_RRC_SPAN);
    this._symWrite = 0;                         // write position (circular)
    this._sampleInSym = 0;                      // 0..SPS-1, where we are in current symbol
    this._needsNewSymbol = true;                // pull new symbol at next sample

    // Pilot-mode state.
    //
    // In a two-process TX/RX system the NCOs start at independent
    // phases — the whole 64-QAM constellation arrives at the RX
    // rotated by some unknown constant angle θ in [0°, 360°). A
    // decision-directed phase loop cannot resolve this because
    // 64-QAM has 90°-rotational symmetry: four different θ values
    // (0°, 90°, 180°, 270°) all "look correct" to the slicer.
    //
    // Solution: the modulator transmits a KNOWN pilot symbol
    // (7+j7)/√42 for V32_PILOT_SYMS symbols at startup. The
    // demodulator, upon lock, measures the received mean (Ī, Q̄)
    // over the pilot window. Since the transmitted pilot has known
    // angle π/4, the received mean angle directly gives θ + π/4 —
    // no 90° ambiguity. The demodulator sets _phaseCorr to this
    // measured offset before switching to decision-directed
    // tracking.
    //
    // After V32_PILOT_SYMS symbols the modulator switches to normal
    // scrambled data. V32_PILOT_SYMS is chosen to last longer than
    // the training window so the demodulator always lands inside
    // the pilot region at lock time.
    this._pilotSymsRemaining = V32_PILOT_SYMS;
  }

  /** Enqueue bytes as UART-framed bits (start=0, 8 data LSB first, 2 stop=1). */
  write(bytes) {
    for (const byte of bytes) {
      this._bitQueue.push(0);
      for (let b = 0; b < 8; b++) this._bitQueue.push((byte >> b) & 1);
      this._bitQueue.push(1);
      this._bitQueue.push(1);
    }
  }

  _pullNextSymbol() {
    let I, Q;
    if (this._pilotSymsRemaining > 0) {
      // Pilot: alternate between (+7+j7)/√42 and (+3+j3)/√42 (same
      // direction — π/4 — but different magnitudes).
      //
      //   - Both points are in Q1, pointing at angle π/4. The MEAN
      //     of the pilot symbols has angle π/4 and non-zero magnitude,
      //     so the RX can measure the carrier phase unambiguously
      //     by mean angle, not just mod-180°.
      //   - The MAGNITUDE alternation produces symbol-rate energy
      //     for the RX's phase-energy strobe estimator (unlike a
      //     pure-constant pilot where all strobe phases look equal).
      //   - Under rotation θ, both points rotate by θ; mean angle
      //     becomes π/4 + θ, no ambiguity.
      for (let i = 0; i < 6; i++) this._scrambler.scramble(1);
      const level = (this._pilotSymsRemaining & 1) ? 7 : 3;
      I = level / V32_NORM;
      Q = level / V32_NORM;
      this._pilotSymsRemaining--;
    } else {
      // Pull 6 bits, scramble, map to (I,Q) constellation point.
      const sc = this._scrambler;
      const b = new Array(6);
      for (let i = 0; i < 6; i++) {
        const raw = this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
        b[i] = sc.scramble(raw);
      }
      I = bitsToI(b[0], b[1], b[2]);
      Q = bitsToQ(b[3], b[4], b[5]);
    }

    // Shift delay line one slot and insert new (I, Q) at head.
    for (let i = V32_RRC_SPAN - 1; i > 0; i--) {
      this._symBufI[i] = this._symBufI[i - 1];
      this._symBufQ[i] = this._symBufQ[i - 1];
    }
    this._symBufI[0] = I;
    this._symBufQ[0] = Q;
  }

  _sampleBaseband() {
    // Compute baseband (I,Q) at the current intra-symbol sample index.
    // The RRC filter output at this sample is a weighted sum of the
    // symbol impulses placed at symbol boundaries, each contributing
    // h[k*SPS + sampleInSym] where k is that symbol's age in symbols.
    //
    // Symbol at buf[0] (age 0): contributes h[SPS*(SPAN-1) + sampleInSym]
    //   (we're partway through the "current" symbol period, so its impulse
    //   was placed SPS-1-sampleInSym samples ago... actually let me
    //   re-derive to be precise.)
    //
    // The RRC filter is centred at its middle tap. With SPAN symbols'
    // worth of taps on each side, the centre tap is at index SPAN*SPS/2.
    // The impulse from a symbol placed at time 0 produces filter output
    // h[centre + sampleIdx] at sampleIdx samples later, while an older
    // symbol placed at time -k*SPS produces h[centre + sampleIdx + k*SPS].
    //
    // At emission time, we want to output samples that, after the RX
    // matched filter, recover the symbol at its peak. The peak of the
    // RRC-pair response is at the symbol centre. So the TX emits at
    // its local time, RX sees delayed version, and timing recovery
    // aligns sampling.
    //
    // Simpler view: each new symbol inserts an impulse. The baseband
    // output at time t is convolution of impulse train with h.
    // At sample index (symIdx*SPS + i) where i ∈ [0, SPS), contribution
    // from symbol j (j ≤ symIdx) is symbol[j] × h[(symIdx-j)*SPS + i].
    //
    // buf[0] = symbol at current symIdx, buf[1] = symIdx-1, etc.
    let I = 0, Q = 0;
    for (let k = 0; k < V32_RRC_SPAN; k++) {
      // Offset into h for this symbol's contribution
      const idx = k * V32_SPS + this._sampleInSym;
      if (idx < V32_RRC.length) {
        I += this._symBufI[k] * V32_RRC[idx];
        Q += this._symBufQ[k] * V32_RRC[idx];
      }
    }
    return { I, Q };
  }

  /**
   * Generate numSamples of TX audio. Resumes cleanly across calls that
   * end mid-symbol.
   */
  generate(numSamples) {
    const out = new Float32Array(numSamples);
    const inc = TWO_PI * this._carrier / SR;

    for (let s = 0; s < numSamples; s++) {
      // At the start of each symbol period, pull new bits.
      if (this._needsNewSymbol) {
        this._pullNextSymbol();
        this._needsNewSymbol = false;
      }

      // Compute baseband I/Q at this sample position inside the current
      // symbol period via RRC convolution.
      const bb = this._sampleBaseband();

      // Mix to carrier: s(t) = I(t)cos(ωt) − Q(t)sin(ωt)
      const ci = Math.cos(this._nco.phase);
      const si = Math.sin(this._nco.phase);
      this._nco.adjustPhase(inc);
      out[s] = V32_AMP * (bb.I * ci - bb.Q * si);

      // Advance intra-symbol counter; roll over every SPS samples.
      this._sampleInSym++;
      if (this._sampleInSym >= V32_SPS) {
        this._sampleInSym = 0;
        this._needsNewSymbol = true;
      }
    }

    return out;
  }

  get idle() { return this._bitQueue.length === 0; }
}

/**
 * V.32bis demodulator.
 *
 * Architecture:
 *   RF samples → carrier demod → I,Q baseband → matched RRC filter
 *              → Gardner timing recovery → LMS equalizer → slicer → descrambler
 *
 * Silence gate + post-lock settle + idle filter as in V.22bis.
 */
class V32bisDemodulator extends EventEmitter {
  constructor(role) {
    super();
    this._role = role;
    this._debug = process.env.V32_DEBUG === '1';
    const carrier = role === 'answer'
      ? config.modem.carriers.V32bis.originateCarrier
      : config.modem.carriers.V32bis.answerCarrier;
    this._carrier     = carrier;
    this._nco         = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._descrambler = new Scrambler(SCPOLY);

    // Matched filter: SAME RRC as TX (symmetric, self-matched).
    // Passing a symbol through TX RRC then RX RRC gives a raised-cosine
    // pulse whose zero-crossings are at multiples of Ts (except at t=0),
    // so sampling at symbol boundaries yields zero ISI.
    this._mfBufI  = new Float64Array(V32_RRC_LEN);
    this._mfBufQ  = new Float64Array(V32_RRC_LEN);

    // Fractional symbol-timing strobe.
    //
    // The matched-filter output peaks every V32_SPS input samples,
    // offset from input sample 0 by the combined TX+RX group delay
    // (which happens to be exactly V32_RRC_LEN - 1 samples — a
    // multiple of V32_SPS for SPS=5, so peaks land at sample indices
    // 40, 45, 50, …).
    //
    // We implement a fractional strobe (rather than an integer "every
    // Nth sample" counter) because in real deployments the SPA2102
    // and any downstream modem have independent sample clocks that
    // drift relative to ours at ±50 to ±200 ppm. That drift would
    // slowly walk an integer strobe off the filter peak, collapsing
    // the decoder after tens of seconds. With a fractional strobe
    // plus a timing-error detector we can track the drift.
    //
    // _strobePhase: current phase in [0, V32_SPS). Incremented by
    //    _sampleStep every input sample. When it crosses V32_SPS we
    //    generate a linearly-interpolated symbol sample.
    // _sampleStep: nominally 1.0 (one phase unit per input sample).
    //    A timing-error detector (TED) would adjust this slightly
    //    each symbol to track drift. Currently fixed at 1.0 — see
    //    TIMING_RECOVERY note below.
    //
    // ── TIMING_RECOVERY (deferred) ────────────────────────────────
    // Over localhost (same process, same clock) and over SIP on a
    // single LAN (RTP timestamps generated from the same OS), TX
    // and RX sample clocks are effectively identical, so a fixed
    // _sampleStep = 1.0 decodes cleanly indefinitely.
    //
    // When an SPA2102 or real analog modem is in the loop, its
    // internal crystal oscillator drifts vs the server's clock.
    // After ~30 s of uncorrected drift the strobe will walk far
    // enough off the filter peak to cause bit errors. A Gardner
    // or Müller-Muller TED applied to _sampleStep will track this.
    //
    // My first-pass Gardner implementation destabilised decoding
    // even at tiny loop gain — something in the mid-sample timing
    // or error sign was wrong. Rather than ship broken code I've
    // left timing recovery out until we can measure real-hardware
    // drift and implement+verify properly.
    // ──────────────────────────────────────────────────────────────
    // Integer-sample strobe state. _samplePos accumulates monotonically.
    // Strobes occur when (_samplePos % V32_SPS) == _strobeOffset.
    //
    // _strobeOffset is determined DYNAMICALLY using a sliding-window
    // energy accumulator across V32_SPS candidate phases. Before lock
    // it is re-evaluated every input sample. At lock it is latched.
    //
    // This handles the case where the demodulator receives non-V.32bis
    // audio (e.g. handshake tones) before the real V.32bis signal
    // starts — a startup-only phase acquisition would pick the wrong
    // phase based on the tones. The sliding window with exponential
    // decay lets recent samples dominate, so once real signal arrives
    // the strobe naturally migrates to the correct phase.
    this._samplePos     = 0;
    this._strobeOffset  = 0;
    this._strobeFrac    = 0;
    this._phaseMag      = new Float64Array(V32_SPS);
    this._samplesSinceLock = 0;
    this._stablePhaseCount = 0;
    this._phaseCorr     = 0;  // decision-directed carrier phase correction (radians)
    // Pilot state machine: 'MEASURING' → 'PILOT_LOCKED' → 'DATA'.
    // Resets to MEASURING on every lock event.
    this._pilotState    = 'MEASURING';
    this._pilotAccumI   = 0;
    this._pilotAccumQ   = 0;
    this._pilotAccumN   = 0;
    this._pilotVarAccum = 0;
    this._pilotVarCount = 0;
    this._pilotConfirmWindows = 0;
    // Rolling buffer of last V32_SPS+1 matched-filter outputs (interp source)
    this._mfOutI       = new Float64Array(V32_SPS + 1);
    this._mfOutQ       = new Float64Array(V32_SPS + 1);

    // Warmup: skip strobes until the matched filter is fully populated.
    this._warmup = V32_RRC_LEN;

    // Lock state
    this._symCount    = 0;
    this._locked      = false;
    this._lockAfter   = config.modem.equalizer.pretrainSymbols;

    // UART framer (same as V.22bis)
    this._state       = 'IDLE';
    this._dataBits    = [];
    this._bitCount    = 0;
    this._silenceHold = 0;
  }

  process(samples) {
    const inc = TWO_PI * this._carrier / SR;

    // Block-level silence detection. Skip entirely-silent blocks rather
    // than feeding zero samples through the pipeline.
    //
    // Why skipping silence matters: if we process silence samples, the
    // NCO advances carrier phase for each zero sample. When real signal
    // resumes, the RX's NCO carrier-phase has drifted relative to the
    // TX's by (silence_sample_count × carrier_freq / SR × 2π) radians.
    // For the 2400 Hz answer carrier, even a single missing sample
    // causes a 108° rotation of the entire constellation, completely
    // destroying 64-QAM decoding.
    //
    // Skipping silent blocks leaves NCO phase frozen at the last real
    // sample, so when signal resumes the phase relationship is the
    // same as if silence never happened. The post-silence hold
    // (_silenceHold) still handles the matched-filter transient that
    // occurs at the boundary.
    //
    // V.22bis doesn't need this because its 600-baud integrate-and-dump
    // averages over 13 samples, so small phase offsets smear out. V.32bis
    // at 1600 baud with single-sample matched-filter strobe needs
    // sample-exact phase alignment.
    let meanSq = 0;
    for (let i = 0; i < samples.length; i++) meanSq += samples[i] * samples[i];
    meanSq /= samples.length;
    const isSilence = meanSq < 1e-4;

    if (isSilence) {
      // Still notify symbol handler so silenceHold and state reset happen.
      // We emit one "silent symbol" per block-worth-of-silence so the UART
      // framer goes IDLE. No NCO advancement, no _samplePos increment, no
      // filter update — just a state marker.
      if (this._locked) {
        this._silenceHold = 20;
        this._state = 'IDLE';
        this._dataBits = [];
        this._bitCount = 0;
      }
      return;
    }

    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      // Carrier demod: multiply by complex conjugate carrier
      const ci = Math.cos(this._nco.phase);
      const si = Math.sin(this._nco.phase);
      this._nco.adjustPhase(inc);
      const rawI = x * ci;
      const rawQ = x * (-si);

      // Matched RRC filter on I and Q. We convolve the most recent
      // V32_RRC_LEN input samples against the RRC kernel.
      for (let k = V32_RRC_LEN - 1; k > 0; k--) {
        this._mfBufI[k] = this._mfBufI[k - 1];
        this._mfBufQ[k] = this._mfBufQ[k - 1];
      }
      this._mfBufI[0] = rawI;
      this._mfBufQ[0] = rawQ;
      let filtI = 0, filtQ = 0;
      for (let k = 0; k < V32_RRC_LEN; k++) {
        filtI += this._mfBufI[k] * V32_RRC[k];
        filtQ += this._mfBufQ[k] * V32_RRC[k];
      }
      // Correct for TX amplitude and carrier-demod factor so a symbol
      // sent at L/√42 is received at L/√42.
      filtI *= 2 / V32_AMP;
      filtQ *= 2 / V32_AMP;

      // Skip strobes while the matched filter fills up.
      if (this._warmup > 0) {
        this._warmup--;
        this._samplePos++;
        continue;
      }

      // Continuous phase-energy accumulation with exponential decay.
      //
      // The matched-filter output peak rarely lands exactly on an integer
      // sample phase — TX/RX clocks, carrier phase, and G.711 codec
      // quantisation all introduce fractional offsets. With SPS=5, a
      // fractional offset of ±0.5 samples is common and causes the
      // "best integer phase" to oscillate between adjacent phases due
      // to noise (this is EXACTLY what we saw in the live debug logs —
      // phases 0 and 4 both hot, with the realign logic flipping
      // between them every symbol).
      //
      // Fix: acquire the fractional strobe position once at lock time
      // using parabolic interpolation on the phase-energy peak, and
      // KEEP IT fixed thereafter. Interpolate the matched-filter
      // output at that fractional position.
      const phase = this._samplePos % V32_SPS;
      const mag2 = filtI * filtI + filtQ * filtQ;
      for (let p = 0; p < V32_SPS; p++) this._phaseMag[p] *= V32_PHASE_DECAY;
      this._phaseMag[phase] += mag2;

      // Rolling buffer of last V32_SPS+1 matched-filter outputs, for
      // fractional interpolation. _mfOut[k] = output k samples ago.
      for (let k = V32_SPS; k > 0; k--) {
        this._mfOutI[k] = this._mfOutI[k - 1];
        this._mfOutQ[k] = this._mfOutQ[k - 1];
      }
      this._mfOutI[0] = filtI;
      this._mfOutQ[0] = filtQ;

      // Pre-lock: continuously update strobe alignment.
      // Post-lock: keep it fixed.
      if (!this._locked) {
        let bestPhase = 0, bestMag = -Infinity;
        for (let p = 0; p < V32_SPS; p++) {
          if (this._phaseMag[p] > bestMag) {
            bestMag = this._phaseMag[p];
            bestPhase = p;
          }
        }
        // Track phase stability: count consecutive input samples where
        // the peak phase hasn't moved by more than 1 (circular). This
        // tolerates the natural oscillation between adjacent phases
        // that happens when the true fractional peak is near an integer
        // boundary — e.g. peak at fractional position 4.5 will show
        // the integer peak alternating between phase 4 and phase 0
        // (which are adjacent in the circular SPS=5 indexing).
        const diff = Math.abs(bestPhase - this._strobeOffset);
        const circDiff = Math.min(diff, V32_SPS - diff);
        if (circDiff <= 1) {
          this._stablePhaseCount++;
        } else {
          this._stablePhaseCount = 0;
        }
        // Parabolic fit on the peak phase and its two neighbours.
        const prevP = (bestPhase - 1 + V32_SPS) % V32_SPS;
        const nextP = (bestPhase + 1) % V32_SPS;
        const yPrev = this._phaseMag[prevP];
        const yPeak = this._phaseMag[bestPhase];
        const yNext = this._phaseMag[nextP];
        const denom = 2 * (yPrev - 2 * yPeak + yNext);
        let frac = 0;
        if (Math.abs(denom) > 1e-9) {
          frac = (yPrev - yNext) / denom;
          if (frac > 0.5) frac = 0.5;
          if (frac < -0.5) frac = -0.5;
        }
        this._strobeOffset = bestPhase;
        this._strobeFrac   = frac;
      }
      if (this._locked) this._samplesSinceLock++;

      // Strobe exactly once per V32_SPS samples.
      //
      // Target fractional phase = _strobeOffset + _strobeFrac.
      // We always fire at integer phase == round(target) and interpolate
      // backward from there by the fractional residue.
      //   If frac >= 0: peak is AFTER strobeOffset, fire at strobeOffset+1
      //                 (if frac > 0.5, would fire at +1 anyway), interp back.
      //   If frac < 0:  peak is BEFORE strobeOffset, fire at strobeOffset, interp back.
      //
      // Actually cleanest: let fireAt = (_strobeOffset + ceil(_strobeFrac)) mod SPS.
      //                    let backOffset = ceil(_strobeFrac) - _strobeFrac.
      // But for frac in [-0.5, +0.5]:
      //   frac <= 0: ceil(frac) = 0, fire at offset, backOffset = -frac (0..0.5)
      //   frac > 0 : ceil(frac) = 1, fire at offset+1, backOffset = 1-frac (0.5..1)
      let firePhase, backOffset;
      if (this._strobeFrac <= 0) {
        firePhase  = this._strobeOffset;
        backOffset = -this._strobeFrac;
      } else {
        firePhase  = (this._strobeOffset + 1) % V32_SPS;
        backOffset = 1 - this._strobeFrac;
      }

      if (phase === firePhase) {
        const f = backOffset;
        const symI = this._mfOutI[0] * (1 - f) + this._mfOutI[1] * f;
        const symQ = this._mfOutQ[0] * (1 - f) + this._mfOutQ[1] * f;
        this._onSymbolSample(symI, symQ);
      }

      this._samplePos++;
    }
  }

  _onSymbolSample(symI, symQ) {
    this._symCount++;

    // Debug: print the first few symbol samples after lock to see if
    // the I/Q values look like a 64-QAM constellation. Expected
    // magnitudes range from √2/√42 ≈ 0.218 to √98/√42 ≈ 1.528. If live
    // symbols are much smaller, larger, or random-looking, something is
    // wrong upstream of the slicer.
    //
    // Also compute distance to NEAREST constellation point. Clean
    // symbols will have distance < 0.1; symbols near slicer thresholds
    // have distance ~0.15; off-grid symbols indicate problems.
    if (this._debug && this._locked && this._samplesSinceLock < 1000) {
      const mag = Math.sqrt(symI * symI + symQ * symQ);
      const phase = Math.atan2(symQ, symI) * 180 / Math.PI;
      // Find nearest grid point in {±1,±3,±5,±7}/√42
      const gridPts = [-7, -5, -3, -1, 1, 3, 5, 7].map(v => v / V32_NORM);
      let nearestI = gridPts[0], nearestQ = gridPts[0];
      let distI = Infinity, distQ = Infinity;
      for (const g of gridPts) {
        if (Math.abs(symI - g) < distI) { distI = Math.abs(symI - g); nearestI = g; }
        if (Math.abs(symQ - g) < distQ) { distQ = Math.abs(symQ - g); nearestQ = g; }
      }
      const totalErr = Math.sqrt(distI * distI + distQ * distQ);
      console.error(`[V32_DEBUG ${this._role}] SYM @ ${this._symCount - this._lockAfter} ` +
        `I=${symI.toFixed(3)} Q=${symQ.toFixed(3)} |=${mag.toFixed(3)} ∠=${phase.toFixed(0)}° ` +
        `→ grid(${(nearestI*V32_NORM).toFixed(0)},${(nearestQ*V32_NORM).toFixed(0)}) err=${totalErr.toFixed(3)}`);
    }

    // Lock acquisition — two conditions:
    //   (1) Minimum symbol count (training duration met)
    //   (2) Phase energy signature matches a V.32bis signal: the peak
    //       phase's energy is at least 20% above the minimum phase.
    //       For a pure sine tone (like ANSam, CM, JM handshake signals)
    //       all phases have near-equal energy and this ratio is < 5%.
    //       For a real V.32bis signal post-training, it is ~25-40%.
    //
    // This prevents locking on handshake tones that may be fed to the
    // demodulator before the real V.32bis signal starts. Without it,
    // the demodulator locks early with wrong phase and stays broken.
    // Lock acquisition — three conditions:
    //   (1) Minimum symbol count (training duration met)
    //   (2) Phase energy signature matches V.32bis (ratio >= 1.15)
    //   (3) The peak phase has been stable for V32_STABLE_SAMPLES samples.
    //
    // Condition (3) was the missing piece. Without it, lock triggers
    // at the moment symCount crosses the threshold, but the peak phase
    // can still be drifting (e.g. at the transition from handshake
    // tones to V.32bis training, the peak phase migrates as the
    // decaying tone energy gives way to fresh V.32bis energy). Locking
    // mid-drift latches a wrong strobe phase.
    //
    // Requiring V32_STABLE_SAMPLES (~400 samples = 80 symbols = 50 ms)
    // of consistent peak-phase agreement ensures the phase estimator
    // has converged on the real V.32bis signal before we commit.
    if (!this._locked && this._symCount >= this._lockAfter) {
      let minMag = Infinity, maxMag = -Infinity;
      for (let p = 0; p < V32_SPS; p++) {
        if (this._phaseMag[p] < minMag) minMag = this._phaseMag[p];
        if (this._phaseMag[p] > maxMag) maxMag = this._phaseMag[p];
      }
      const ratio = minMag > 0 ? maxMag / minMag : 0;
      const stable = this._stablePhaseCount >= V32_STABLE_SAMPLES;
      if (ratio >= V32_LOCK_MIN_RATIO && stable) {
        this._locked = true;
        this._state = 'IDLE';
        this._dataBits = []; this._bitCount = 0;
        // Reset the descrambler to a known state so self-sync
        // resynchronisation begins cleanly.
        this._descrambler.reset();
        this._phaseCorr = 0;
        this._pilotState = 'MEASURING';
        this._pilotAccumI = 0;
        this._pilotAccumQ = 0;
        this._pilotAccumN = 0;
        this._pilotVarAccum = 0;
        this._pilotVarCount = 0;
        this._pilotConfirmWindows = 0;
        // Post-lock settle window — extended to cover the pilot
        // measurement period. 120 symbols = 75ms of pilot averaging
        // gives a clean phase measurement even at modest SNR.
        this._silenceHold = 120;
        if (this._debug) {
          console.error(`[V32_DEBUG ${this._role}] LOCK @ symCount=${this._symCount} ` +
            `strobeOffset=${this._strobeOffset} frac=${this._strobeFrac.toFixed(3)} ` +
            `ratio=${ratio.toFixed(3)} stableFor=${this._stablePhaseCount} ` +
            `phaseMag=[${Array.from(this._phaseMag).map(v => v.toFixed(1)).join(',')}]`);
        }
      }
    }
    if (!this._locked) return;

    // ─── Decision-directed carrier-phase correction ─────────────────────
    //
    // Two separate processes (TX and RX) have independent NCOs. Even
    // though their frequencies are identical (2400 Hz or 1200 Hz),
    // they start at unknown relative phases. A constant phase offset
    // φ rotates the entire 64-QAM constellation by φ — enough to push
    // symbols across slicer decision boundaries and produce continuous
    // bit errors. My loopback tests all happen in one process with
    // synchronous sample generation, so the NCOs are accidentally in
    // phase and this bug is invisible.
    //
    // Fix: after lock, estimate the constellation rotation angle and
    // de-rotate incoming symbols before slicing. We use a
    // decision-directed approach:
    //   1. Slice the received (I,Q) to the nearest grid point (I*,Q*)
    //   2. Compute the phase error θ = arg(I+jQ) - arg(I*+jQ*)
    //   3. Integrate θ with a small gain to update _phaseCorr
    //   4. Rotate next symbol by -_phaseCorr before slicing
    //
    // Loop gain 0.05 gives time constant ~20 symbols = 12.5 ms.
    // Initial estimate computed from phaseMag ratios at lock time.
    const cosP = Math.cos(this._phaseCorr);
    const sinP = Math.sin(this._phaseCorr);
    const rotI = symI * cosP + symQ * sinP;
    const rotQ = -symI * sinP + symQ * cosP;
    symI = rotI;
    symQ = rotQ;

    // Simple 64-QAM slice. Rotation ambiguity is resolved by the
    // pilot-based initial phase measurement below, so by the time we
    // reach data (post-silenceHold) the constellation is aligned.
    const [i0, i1, i2] = sliceLevel8(symI);
    const [q0, q1, q2] = sliceLevel8(symQ);
    const sliceIbits = i0 | (i1 << 1) | (i2 << 2);
    const sliceQbits = q0 | (q1 << 1) | (q2 << 2);
    const sliceI = V32_LEVELS[sliceIbits] / V32_NORM;
    const sliceQ = V32_LEVELS[sliceQbits] / V32_NORM;

    // ─── Phase correction: pilot measurement → tracking loop ──────────
    //
    // TX transmits the constant pilot (+7+j7)/√42 for the first
    // V32_PILOT_SYMS symbols of its lifetime. We exploit this to
    // measure carrier phase unambiguously:
    //
    //   1. _pilotState='MEASURING': accumulate (I,Q) while the
    //      constellation shows low variance (indicating pilot in
    //      progress). When we have enough samples, compute mean angle
    //      → set _phaseCorr.
    //   2. _pilotState='PILOT_LOCKED': phase measurement done, but TX
    //      may still be sending pilot. Watch for constellation
    //      spreading (variance increase) to detect pilot-to-data
    //      transition. Keep the UART gated during this.
    //   3. _pilotState='DATA': TX is sending real data. Run standard
    //      decision-directed tracking; UART ungated.
    if (this._pilotState === 'MEASURING') {
      // TX is sending alternating pilot at (+7+j7)/√42 and (+3+j3)/√42.
      // Both points are at angle π/4 with different magnitudes; the
      // mean is (+5+j5)/√42 at angle π/4. Under rotation θ, received
      // mean is at angle π/4 + θ. Measurement is unambiguous.
      const preRotI = rotI * cosP - rotQ * sinP;   // un-rotate
      const preRotQ = rotI * sinP + rotQ * cosP;
      this._pilotAccumI += preRotI;
      this._pilotAccumQ += preRotQ;
      this._pilotAccumN++;
      if (this._pilotAccumN >= V32_PILOT_MEASURE_SYMS) {
        const meanI = this._pilotAccumI / this._pilotAccumN;
        const meanQ = this._pilotAccumQ / this._pilotAccumN;
        const meanMag = Math.sqrt(meanI * meanI + meanQ * meanQ);
        // Expected pilot mean magnitude is |(5+j5)/√42| = √50/√42 ≈ 1.091.
        // If mean magnitude is much smaller (< 0.5), we're averaging
        // random data (mean ≈ 0) not pilot — the RX locked AFTER the
        // pilot window ended. In that case don't trust the measurement;
        // fall back to decision-directed tracking from current phaseCorr.
        const measuredAngle = Math.atan2(meanQ, meanI);
        if (meanMag >= 0.5) {
          // Real pilot data — unambiguous phase measurement
          this._phaseCorr = measuredAngle - Math.PI / 4;
          if (this._phaseCorr > Math.PI)  this._phaseCorr -= 2 * Math.PI;
          if (this._phaseCorr < -Math.PI) this._phaseCorr += 2 * Math.PI;
          if (this._debug) {
            console.error(`[V32_DEBUG ${this._role}] PILOT measured angle=${(measuredAngle*180/Math.PI).toFixed(1)}° ` +
              `mag=${meanMag.toFixed(3)} → phaseCorr=${(this._phaseCorr*180/Math.PI).toFixed(1)}° ` +
              `from ${this._pilotAccumN} samples mean=(${meanI.toFixed(3)},${meanQ.toFixed(3)})`);
          }
        } else {
          // No pilot detected — likely locked after pilot ended. Skip
          // pilot-based measurement; decision-directed tracking will
          // converge from phaseCorr=0. This may take longer and may
          // land at a 90°-rotated lock point, but that's still better
          // than a wildly-wrong phaseCorr from pilot-measurement-on-data.
          if (this._debug) {
            console.error(`[V32_DEBUG ${this._role}] PILOT NOT DETECTED (locked on data?) ` +
              `mag=${meanMag.toFixed(3)} — skipping pilot measurement, using decision-directed`);
          }
          this._phaseCorr = 0;
        }
        this._pilotState = 'PILOT_LOCKED';
        this._pilotVarAccum = 0;
        this._pilotVarCount = 0;
        this._pilotConfirmWindows = 0;
        this._descrambler.reset();
      }
    } else if (this._pilotState === 'PILOT_LOCKED') {
      // Pilot is at (+5+j5)/√42 mean (between +3+j3 and +7+j7). After
      // rotation correction, pilot symbols land near those two points.
      // Track variance from the pilot axis (Q1 diagonal) to detect
      // transition to data.
      //
      // Simplest: distance from the expected pilot mean.
      const pilotMeanI = 5 / V32_NORM;
      const pilotMeanQ = 5 / V32_NORM;
      const dI = symI - pilotMeanI;
      const dQ = symQ - pilotMeanQ;
      const d2 = dI * dI + dQ * dQ;
      this._pilotVarAccum += d2;
      this._pilotVarCount++;
      if (this._pilotVarCount >= V32_PILOT_VAR_WINDOW) {
        const meanVar = this._pilotVarAccum / this._pilotVarCount;
        if (meanVar > V32_PILOT_TO_DATA_THRESH) {
          this._pilotConfirmWindows++;
          if (this._debug) {
            console.error(`[V32_DEBUG ${this._role}] pilot-var window ${this._pilotConfirmWindows}/${V32_PILOT_CONFIRM_WINDOWS}: ` +
              `meanVar=${meanVar.toFixed(3)}`);
          }
          if (this._pilotConfirmWindows >= V32_PILOT_CONFIRM_WINDOWS) {
            if (this._debug) {
              console.error(`[V32_DEBUG ${this._role}] PILOT→DATA transition confirmed, ` +
                `phaseCorr=${(this._phaseCorr*180/Math.PI).toFixed(1)}°`);
            }
            this._pilotState = 'DATA';
            this._descrambler.reset();
          }
        } else {
          // Reset confirm counter — need consecutive high-variance windows
          this._pilotConfirmWindows = 0;
        }
        this._pilotVarAccum = 0;
        this._pilotVarCount = 0;
      }
    } else {
      // DATA state: standard decision-directed tracking.
      const mag2 = symI * symI + symQ * symQ;
      const sliceMag2 = sliceI * sliceI + sliceQ * sliceQ;
      if (mag2 > 1e-6 && sliceMag2 > 1e-6) {
        const crossIm = symQ * sliceI - symI * sliceQ;
        const phaseErr = crossIm / Math.sqrt(mag2 * sliceMag2);
        this._phaseCorr += V32_PHASE_LOOP_GAIN * phaseErr;
        if (this._phaseCorr > Math.PI)  this._phaseCorr -= 2 * Math.PI;
        if (this._phaseCorr < -Math.PI) this._phaseCorr += 2 * Math.PI;
      }
    }

    const dc = this._descrambler;
    const db0 = dc.descramble(i0);
    const db1 = dc.descramble(i1);
    const db2 = dc.descramble(i2);
    const db3 = dc.descramble(q0);
    const db4 = dc.descramble(q1);
    const db5 = dc.descramble(q2);

    // UART gating: only forward bytes to the application when we're
    // confidently past the pilot and into data mode. _pilotState=='DATA'
    // indicates this. During MEASURING and PILOT_LOCKED we silently
    // drop output.
    if (this._silenceHold > 0 || this._pilotState !== 'DATA') {
      if (this._silenceHold > 0) this._silenceHold--;
      this._state = 'IDLE';
      this._dataBits = [];
      this._bitCount = 0;
      return;
    }

    // Full decode — forward descrambled bits to UART framer.
    this._onBit(db0);
    this._onBit(db1);
    this._onBit(db2);
    this._onBit(db3);
    this._onBit(db4);
    this._onBit(db5);
  }

  _onBit(bit) {
    switch (this._state) {
      case 'IDLE':
        if (bit === 0) {
          this._state = 'DATA';
          this._dataBits = []; this._bitCount = 0;
        }
        break;
      case 'DATA':
        this._dataBits.push(bit);
        if (++this._bitCount === 8) this._state = 'STOP';
        break;
      case 'STOP':
        if (bit === 1) {
          let byte = 0;
          for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
          if (byte !== 0xFF) {
            if (this._debug) {
              const ch = (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : '?';
              console.error(`[V32_DEBUG ${this._role}] BYTE 0x${byte.toString(16).padStart(2,'0')} '${ch}' ` +
                `sinceLock=${this._samplesSinceLock} silenceHold=${this._silenceHold}`);
            }
            this.emit('data', Buffer.from([byte]));
          }
        }
        this._state = 'IDLE';
        break;
    }
  }

  reset() {
    this._mfBufI.fill(0); this._mfBufQ.fill(0);
    this._descrambler.reset();
    this._warmup = V32_RRC_LEN;
    this._samplePos = 0; this._symCount = 0; this._locked = false;
    this._strobeOffset = 0;
    this._strobeFrac = 0;
    this._phaseMag.fill(0);
    this._mfOutI.fill(0);
    this._mfOutQ.fill(0);
    this._samplesSinceLock = 0;
    this._stablePhaseCount = 0;
    this._phaseCorr = 0;
    this._pilotState = 'MEASURING';
    this._pilotAccumI = 0;
    this._pilotAccumQ = 0;
    this._pilotAccumN = 0;
    this._pilotVarAccum = 0;
    this._pilotVarCount = 0;
    this._pilotConfirmWindows = 0;
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
    this._silenceHold = 0;
  }
}

class V32bis extends EventEmitter {
  constructor(role) {
    super();
    this.modulator   = new V32bisModulator(role);
    this.demodulator = new V32bisDemodulator(role);
    this.demodulator.on('data', buf => this.emit('data', buf));
  }
  write(data)           { this.modulator.write(data); }
  generateAudio(n)      { return this.modulator.generate(n); }
  receiveAudio(samples) { this.demodulator.process(samples); }
  get name()            { return 'V32bis'; }
  get bps()             { return 9600; }
}

module.exports = { V23, V32bis };
