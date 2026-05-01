'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// cleanup-phase-2 banner (April 2026)
// ───────────────────────────────────────────────────────────────────────────
// This file was previously a thin JS wrapper around a vendored spandsp
// V.22bis data pump (compiled native addon under src/native/). In
// cleanup-phase-2 the entire spandsp tree was removed from the
// repository, taking the C/C++ toolchain prerequisite with it. This
// file is now the pure-JS reinstatement, restored from the historical
// V22.js.PUREJS reference copy that was kept in tree throughout the
// spandsp era.
//
// Status of the two classes exported below:
//
//   V22     (1200 bps DQPSK)  — the active, advertised native V.22
//                               implementation. Default protocol
//                               negotiation uses this.
//
//   V22bis  (2400 bps 16-QAM) — TESTING / NOT KNOWN WORKING. Preserved
//                               here verbatim from the pre-spandsp
//                               implementation. It was abandoned in
//                               favour of the spandsp wrapper because
//                               it was not reliably training against
//                               real hardware modems on the wire.
//                               The class is retained because (a) the
//                               receive-side machinery is most of a
//                               working V.22bis demodulator, (b) the
//                               cleanest path to native V.22bis is to
//                               fix what's here rather than start over,
//                               and (c) the Primitives module retains
//                               the building blocks (LMSEqualizer,
//                               CostasLoop, GardnerTiming, AGC,
//                               Scrambler) precisely so a future fix
//                               pass can lean on them.
//
//                               V22bis is NOT advertised by default in
//                               config.modem.native.protocolPreference
//                               or v8ModulationModes — operators must
//                               opt in to test it. A promote-or-delete
//                               decision is deferred to a future cleanup
//                               phase after operator testing.
//
// Below this banner the file is the original V22.js.PUREJS content
// preserved verbatim. No code was removed in cleanup-phase-2; only the
// banner was added.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V.22 (1200 bps DQPSK) and V.22bis (2400 bps 16-QAM) — ITU-T V.22bis (1988)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This file implements the TX side ("foundation") per the ITU-T V.22bis
 * specification. The RX side is kept simple here — the main goal of this
 * revision is to produce a spec-conformant outbound signal that a real
 * hardware modem can decode. RX refinement (LMS equalizer, Gardner timing
 * recovery, Costas loop) comes in a separate pass once TX interop is proven.
 *
 * Key references:
 *   - ITU-T V.22bis (1988), Fascicle VIII.1
 *   - TI SPRA484 "V.22 bis Modem on Fixed-Point TMS320C2xx DSPs"
 *
 * Line parameters
 * ───────────────
 *   Carrier frequencies:  1200 ± 0.5 Hz (call/originate/low channel)
 *                         2400 ± 1   Hz (answer/high channel)
 *   Symbol rate:          600 baud (both directions)
 *   Guard tone (high ch): 1800 ± 20 Hz at −6 ± 1 dB below data power
 *   Pulse shape:          square root of raised-cosine, β = 0.75
 *   Group delay:          ±150 µs over channel passband
 *
 * Scrambler (same polynomial both directions, per spec §5.1):
 *   G(x) = 1 ⊕ x⁻¹⁴ ⊕ x⁻¹⁷
 *   64-consecutive-ones detector inverts next scrambler input bit
 *
 * V.22 (1200 bps, dibit encoding, §2.5.2.2)
 *   2 bits per symbol. Dibit → phase quadrant change per Table 1/V.22bis.
 *   Signal point is always the "01" (V.22-compatible) position within
 *   the new quadrant — i.e. at coordinates (±3, ±1).
 *
 * V.22bis (2400 bps, quadbit encoding, §2.5.2.1)
 *   4 bits per symbol. First 2 bits (Q1,Q2) → phase quadrant change
 *   per Table 1/V.22bis. Last 2 bits (Q3,Q4) → one of 4 points within
 *   the new quadrant, per Figure 2/V.22bis.
 *
 * Constellation layout (Figure 2/V.22bis)
 *   Points in the 4×4 grid at I,Q ∈ {−3, −1, +1, +3}. Four points per
 *   quadrant selected by Q3,Q4:
 *
 *     Q3 Q4 | (|I|, |Q|)
 *     ------+-----------
 *     0  0  | (1, 1)   inner
 *     0  1  | (3, 1)   V.22-compatible point  ← this is what V.22 always uses
 *     1  0  | (1, 3)
 *     1  1  | (3, 3)   outer
 *
 *   Sign of I and Q is determined by the current quadrant after the
 *   differential phase change.
 *
 * TX signal level
 * ───────────────
 *   Target: −10 dBm on the line (TI SPRA484), which at our scale (peak 1.0
 *   = full-scale μ-law) corresponds to approximately 0.15 peak amplitude.
 *   Data power is computed over the RMS of the shaped I/Q signal —
 *   we scale so the constellation outer point (3,3) maps to approximately
 *   0.15 peak at the RF-modulated output (after pulse shaping).
 */

const { EventEmitter } = require('events');
const { TWO_PI, BiquadFilter } = require('../Primitives');

// Demodulator + shared DSP utilities live in V22Demodulator.js. We
// re-export the relevant symbols at the bottom of this file so existing
// consumers that import { QAMDemodulator, V22Scrambler, RRC, ... } from
// V22.js keep working unchanged.
const {
  QAMDemodulator,
  V22Scrambler,
  SR, BAUD, SPS, CARRIER_LOW, CARRIER_HIGH, GUARD_FREQ,
  PHASE_CHANGE, QUADRANT_POINT,
  RRC, RRC_BETA, RRC_SPAN, rrcImpulse, buildRrcTaps,
  RX_TRAINING,
} = require('./V22Demodulator');

const GUARD_DB     = -6;              // guard tone relative to data (§2.2)

// TX amplitude. The constellation grid uses integer coordinates (−3,−1,1,3).
// Peak target for the outermost constellation point (3,3) after pulse
// shaping. A real telecom V.22 transmit level is typically -13 to -10
// dBm0; spandsp's default is -14 dBm0 (set via v22bis_tx_power(s, -14)
// in v22bis_tx.c:916).
//
// Empirical level matching: spandsp at -14 dBm0 produces measured RMS
// 0.1397 in the int16 wav stream (peak/RMS ≈ 2.04, typical V.22 crest
// factor). With PEAK_TARGET = 0.25, our random-data RMS measures 0.1093
// — about 2.1 dB quieter than spandsp on the same wire. That difference
// is enough to cause edge-symbol slicing errors at the receiving modem,
// because hardware modem AGC fixes its slicer thresholds during
// training and applying them to a quieter steady-state signal pushes
// boundary symbols across the wrong threshold. This was the user-
// visible TX-side corruption seen on long calls.
//
// PEAK_TARGET = 0.32 raises our random-data RMS to ≈ 0.1397 — matching
// spandsp's observed level. Peak instantaneous output (with SRRC
// sidelobes and no guard tone) stays under 0.7 — well within ±1.0
// digital range, no clipping risk.
//
// History:
//   0.15 — original; -19 dBm0, several dB below typical, reduced SNR margin.
//   0.25 — phase-1; bumped to match documentation comment about -14 dBm0,
//          but the comment's math under-estimated the QAM-vs-sine RMS
//          ratio, leaving us still 2 dB quieter than spandsp.
//   0.32 — phase-4b; matches spandsp's measured output level on the
//          same wire (chosen empirically from real-modem captures).
const PEAK_TARGET  = 0.32;

// SRRC pulse-shape constants, lookup tables, V22Scrambler, and
// QAMDemodulator now live in V22Demodulator.js (split out in
// v22-fix-phase1). They are re-exported by this file for backwards
// compatibility — see imports above and module.exports below.

// ─── Symbol mapping ────────────────────────────────────────────────────────

/**
 * Map a dibit (2 bits) or quadbit (4 bits) to a constellation point,
 * updating `state.quadrant` per the differential phase encoding rule.
 *
 * @param {object}   state     {quadrant: 0..3} — updated in place
 * @param {number[]} bits      scrambled bits [Q1,Q2] for V.22 or [Q1,Q2,Q3,Q4] for V.22bis
 * @param {number}   bitsPerSymbol  2 (V.22) or 4 (V.22bis)
 * @returns {{i:number, q:number}}  Constellation point in un-normalized units
 *                                  (I,Q ∈ {±1, ±3})
 */
function mapSymbol(state, bits, bitsPerSymbol) {
  const q1 = bits[0], q2 = bits[1];
  // Update quadrant per differential phase change. Quadrants are numbered
  // 0..3 counterclockwise starting at upper-right:
  //   0: (+I, +Q)   quadrant 1
  //   1: (−I, +Q)   quadrant 2
  //   2: (−I, −Q)   quadrant 3
  //   3: (+I, −Q)   quadrant 4
  // Phase changes in PHASE_CHANGE[] are added to the carrier reference,
  // so e.g. +90° advances by 1 quadrant counterclockwise.
  const phaseIdx  = (q1 << 1) | q2;
  const dQuadrant = Math.round(PHASE_CHANGE[phaseIdx] / (Math.PI / 2)) % 4;
  state.quadrant  = (state.quadrant + dQuadrant) % 4;

  // Pick the magnitude point within the new quadrant.
  let mag;
  if (bitsPerSymbol === 2) {
    // V.22: always the "01" V.22-compatible point (I=3, Q=1) magnitudes.
    mag = QUADRANT_POINT[1];
  } else {
    // V.22bis: Q3,Q4 select the point.
    const q3 = bits[2], q4 = bits[3];
    mag = QUADRANT_POINT[(q3 << 1) | q4];
  }

  // Apply sign based on quadrant. We produced (i, q) with both positive
  // (the quadrant-1 coordinates). To get the final (I, Q) in the actual
  // target quadrant we ROTATE by (quadrant * 90°):
  //   N=0: (+i, +q)           (quadrant 1)
  //   N=1: (-q, +i)            (quadrant 2) — rotated +90°
  //   N=2: (-i, -q)            (quadrant 3) — rotated +180°
  //   N=3: (+q, -i)            (quadrant 4) — rotated +270°
  //
  // This is required for V.22-compatible points like (3, 1) where the
  // |I| and |Q| magnitudes swap when rotated through odd-numbered
  // quadrants.
  let i = mag.i, q = mag.q;
  switch (state.quadrant) {
    case 1: { const ni = -q; const nq =  i; i = ni; q = nq; break; }
    case 2: { i = -i; q = -q; break; }
    case 3: { const ni =  q; const nq = -i; i = ni; q = nq; break; }
  }
  return { i, q };
}

// ─── Modulator ─────────────────────────────────────────────────────────────

/**
 * V.22 / V.22bis transmitter.
 *
 * The modulator produces audio by:
 *  1. Pulling bits from a queue (UART-framed user bytes + scrambled marking
 *     when the queue is empty)
 *  2. Mapping each dibit/quadbit to a constellation I/Q point
 *  3. Convolving the impulse-train of constellation points with the SRRC
 *     pulse shape, computed on the fly from the last RRC_SPAN symbols
 *  4. Mixing the baseband I,Q onto the carrier: s(t) = I·cos(2πfc t) − Q·sin(2πfc t)
 *  5. (Answer channel only) Adding the 1800 Hz guard tone at −6 dB
 *
 * Symbol timing uses a sub-sample-accurate accumulator (no rounding drift).
 * The long-term baud rate is exactly 600 Hz regardless of call length.
 */
class QAMModulator {
  /**
   * @param {object} opts
   * @param {number} opts.carrier         1200 or 2400 (Hz)
   * @param {number} opts.bitsPerSymbol   2 (V.22) or 4 (V.22bis)
   * @param {boolean} opts.guardTone      true = emit 1800 Hz guard tone
   */
  constructor({ carrier, bitsPerSymbol, guardTone }) {
    this._carrier        = carrier;
    this._bps            = bitsPerSymbol;
    this._guardToneOn    = !!guardTone;
    this._scrambler      = new V22Scrambler();
    this._bitQueue       = [];     // UART-framed bits awaiting transmission
    this._diffState      = { quadrant: 0 };

    // Handshake/training mode. setMode() controls these; default is
    // normal data operation (scramble user bytes from _bitQueue).
    this._scramblerBypass = false;
    this._forcedBitFn     = null;

    // Symbol ring buffer holding the most recent RRC_SPAN+1 symbols and
    // their sample-time of emission. Each entry: {i, q, startSample}.
    // The oldest symbol older than RRC_SPAN symbols is trimmed each tick.
    this._symbols        = [];

    // Sub-sample-accurate symbol timing. We emit a new symbol when the
    // running sample counter crosses a multiple of SPS. Over 3 symbols
    // this produces 14+13+13 = 40 samples at 8 kHz, i.e. exactly 600 baud.
    this._sampleCounter  = 0;
    this._nextSymbolAt   = 0;      // sample index of next symbol start

    // Carrier NCO phase (accumulates per-sample).
    this._carrierPhase   = 0;
    this._carrierInc     = TWO_PI * this._carrier / SR;

    // Guard tone NCO (used only on answer channel).
    this._guardPhase     = 0;
    this._guardInc       = TWO_PI * GUARD_FREQ / SR;

    // Scaling constants. The outer constellation point is (3,3), peak
    // shaped magnitude at the output is (3 * h_peak) where h_peak is the
    // SRRC peak tap. After RF-mixing (cos, sin) the peak sample is
    // √(I² + Q²) ≈ 3√2 · h_peak for outer points. We scale so this
    // equals PEAK_TARGET (0.15).
    //
    // Per V.22bis §2.2, when the 1800 Hz guard tone is enabled, data
    // signal level is ~1 dB lower in the high channel than in the low
    // channel, so that combined data+guard power stays close to target.
    // We apply that 1 dB reduction here to data amplitude.
    const dataLevelAdj   = this._guardToneOn ? Math.pow(10, -1/20) : 1;
    const rawOuterPeak   = 3 * Math.SQRT2 * RRC.gain;
    this._ampData        = (PEAK_TARGET * dataLevelAdj) / rawOuterPeak;
    // Guard tone is 6 dB below data POWER (per V.22bis §2.2, ±1 dB).
    // Empirically, the 16-QAM RF signal (post pulse shaping) has RMS
    // close to PEAK_TARGET × 0.45 when scrambled data is random. For
    // guard to be 6 dB below data power:
    //   guard_rms = data_rms / 2
    //   guard_sine_amp = guard_rms × √2
    const dataRmsEst     = PEAK_TARGET * dataLevelAdj * 0.45;
    this._ampGuard       = dataRmsEst * Math.pow(10, GUARD_DB / 20) * Math.SQRT2;
  }

  reset() {
    this._scrambler.reset();
    this._bitQueue       = [];
    this._diffState      = { quadrant: 0 };
    this._symbols        = [];
    this._sampleCounter  = 0;
    this._nextSymbolAt   = 0;
    this._carrierPhase   = 0;
    this._guardPhase     = 0;
    this._scramblerBypass = false;
    this._forcedBitFn     = null;
  }

  /**
   * Set handshake TX mode. Modes:
   *   'data'       — normal operation: queued user bytes, scrambled
   *   'unscr-ones' — unscrambled binary 1 (all bits = 1, scrambler bypassed)
   *   'dibit-00'   — unscrambled dibits all = 00 (only meaningful for V.22)
   *   'dibit-11'   — unscrambled dibits all = 11
   *   'alt-00-11'  — alternating dibits 00, 11, 00, 11 (unscrambled)
   *                  (this is the §6.3 "double-dibit 00/11" training signal)
   *   'scr-ones'   — scrambled binary 1 (input = 1 always, scrambler active)
   *
   * Changing mode flushes the pending-bit queue.
   */
  setMode(mode) {
    this._bitQueue = [];
    switch (mode) {
      case 'data':
        this._scramblerBypass = false;
        this._forcedBitFn     = null;
        break;
      case 'unscr-ones':
        this._scramblerBypass = true;
        this._forcedBitFn     = () => 1;
        break;
      case 'dibit-00':
        this._scramblerBypass = true;
        this._forcedBitFn     = () => 0;
        break;
      case 'dibit-11':
        this._scramblerBypass = true;
        this._forcedBitFn     = () => 1;
        break;
      case 'alt-00-11': {
        // Emit 0,0,1,1,0,0,1,1,... so as dibits this is 00,11,00,11,...
        let n = 0;
        this._scramblerBypass = true;
        this._forcedBitFn     = () => ((n++ >> 1) & 1);
        break;
      }
      case 'scr-ones':
        this._scramblerBypass = false;
        this._forcedBitFn     = () => 1;
        break;
      default:
        throw new Error('Unknown mode: ' + mode);
    }
  }

  /** Queue bytes for asynchronous 10-bit UART framing: start + 8LSB + 2×stop. */
  write(bytes) {
    for (const byte of bytes) {
      this._bitQueue.push(0);                              // start bit
      for (let b = 0; b < 8; b++) this._bitQueue.push((byte >> b) & 1);
      this._bitQueue.push(1);                              // stop bit
      this._bitQueue.push(1);                              // 2nd stop bit
    }
  }

  /** True when there are no pending bits (idle marking). */
  get idle() { return this._bitQueue.length === 0; }

  /**
   * Change the bits-per-symbol during operation. Used by V.22bis handshake
   * to start at 1200 bps (2 bits/symbol) and later switch to 2400 bps
   * (4 bits/symbol). Flushes pending bits to avoid mixed-framing.
   */
  setBitsPerSymbol(bps) {
    if (bps !== 2 && bps !== 4) throw new Error('bps must be 2 or 4');
    this._bps = bps;
    this._bitQueue = [];
  }

  get bitsPerSymbol() { return this._bps; }

  /** Consume one unscrambled bit from the queue, from _forcedBitFn, or 1 (idle mark). */
  _nextRawBit() {
    if (this._forcedBitFn) return this._forcedBitFn();
    return this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
  }

  /** Generate the next constellation symbol and append to ring buffer. */
  _generateNextSymbol(startSample) {
    const bits = new Array(this._bps);
    for (let b = 0; b < this._bps; b++) {
      const raw = this._nextRawBit();
      bits[b] = this._scramblerBypass ? raw : this._scrambler.scramble(raw);
    }
    const pt = mapSymbol(this._diffState, bits, this._bps);
    this._symbols.push({ i: pt.i, q: pt.q, startSample });
    // Trim old symbols that can no longer contribute to current output.
    const cutoff = startSample - RRC.span;
    while (this._symbols.length > 0 && this._symbols[0].startSample < cutoff) {
      this._symbols.shift();
    }
  }

  /**
   * Generate numSamples of TX audio. The symbol/RRC state is persistent
   * across calls, so a symbol boundary that falls between blocks is
   * handled transparently — the same SRRC-shaped output comes out
   * regardless of how the caller chunks the request.
   */
  generate(numSamples) {
    const out = new Float32Array(numSamples);

    for (let n = 0; n < numSamples; n++) {
      const absSample = this._sampleCounter;

      // Emit a new symbol if it's time. SPS is 13.333..., so the symbol
      // boundaries at sample positions 0, 13.33, 26.66, 40.00, 53.33, ...
      // align to integer samples as 0, 13, 27, 40, 53, 67, 80, ... —
      // exactly 14+13+13 = 40 every 3 symbols.
      while (absSample >= this._nextSymbolAt) {
        this._generateNextSymbol(this._nextSymbolAt);
        // Advance symbol boundary by SPS; integer-floor'ed per-symbol
        // but long-term exact.
        this._nextSymbolAt += SPS;
      }

      // Compute shaped I and Q at this sample by summing contributions
      // from all symbols within ±RRC_SPAN/2 symbol periods.
      let bbI = 0, bbQ = 0;
      for (let k = 0; k < this._symbols.length; k++) {
        const sym = this._symbols[k];
        // Time since the symbol's center in symbol periods. The SRRC
        // pulse has total span RRC_SPAN = 6 symbols centred on the
        // peak — 3 symbols of precursor (left half) and 3 symbols of
        // postcursor (right half). We peg the peak at
        //   startSample + (RRC_SPAN/2) * SPS
        // (i.e. 3 symbol periods AFTER the symbol is enqueued). That
        // way, when we compute the audio output at time startSample,
        // we're at tSym = -RRC_SPAN/2 — the very start of the pulse
        // precursor. If the peak were placed at startSample + SPS/2
        // (naïve "centre of the symbol's own period"), the precursor
        // would extend back to startSample - 2.5*SPS — a window of
        // past audio samples that were emitted BEFORE this symbol
        // was inserted and thus never received its precursor
        // contribution. That truncation produces a distorted pulse
        // whose zero crossings aren't where timing recovery expects
        // them. The fixed +RRC_SPAN/2 offset introduces (RRC_SPAN/2)
        // × SPS ≈ 4 ms of TX latency but gives the receiver a clean,
        // properly-shaped SRRC pulse to lock onto.
        const tSym = (absSample - (sym.startSample + (RRC_SPAN / 2) * SPS)) / SPS;
        if (Math.abs(tSym) > RRC_SPAN / 2) continue;
        const h = rrcImpulse(tSym, RRC_BETA);
        bbI += sym.i * h;
        bbQ += sym.q * h;
      }

      // Apply RF mixing: s(t) = I·cos(2πfc t) − Q·sin(2πfc t)
      const cs = Math.cos(this._carrierPhase);
      const sn = Math.sin(this._carrierPhase);
      let sample = this._ampData * (bbI * cs - bbQ * sn);

      // Add guard tone (high-channel only)
      if (this._guardToneOn) {
        sample += this._ampGuard * Math.cos(this._guardPhase);
        this._guardPhase += this._guardInc;
        if (this._guardPhase > TWO_PI) this._guardPhase -= TWO_PI;
      }

      this._carrierPhase += this._carrierInc;
      if (this._carrierPhase > TWO_PI) this._carrierPhase -= TWO_PI;

      out[n] = sample;
      this._sampleCounter++;
    }

    return out;
  }
}

// ─── Protocol wrappers ─────────────────────────────────────────────────────

/**
 * V.22 protocol adapter. 1200 bps, dibit-only (V.22-compatible
 * constellation point).
 *
 * Answer-side handshake per ITU-T V.22bis §6.3.1.2.2 (a,b,c):
 *   (a) Transmit unscrambled binary 1 at 1200 bit/s.
 *   (b) On detection of scrambled binary 1 or 0 in the low channel at
 *       1200 bit/s for 270 ± 40 ms: switch to transmitting scrambled
 *       binary 1 at 1200 bit/s.
 *   (c) After scrambled binary 1 has been transmitted for 765 ± 10 ms:
 *       ready to transmit/receive data.
 *
 * This is event-driven, NOT time-scripted. USB1 continues indefinitely
 * until (b) triggers. If the remote never shows up on the expected
 * carrier within a hard timeout (we use 8 s), the handshake fails and
 * we emit 'ready' with remoteDetected=false so the Handshake layer can
 * report handshake-failed.
 */

const V22_HS_PHASE = Object.freeze({
  INIT:     'init',
  USB1:     'usb1',    // transmit unscrambled 1s, wait for scrambled from remote
  SB1:      'sb1',     // transmit scrambled 1s for 765ms
  DATA:     'data',    // ready for data
});

// Per spec §6.3.1.2.2(b): scrambled 1/0 must be detected for 270 ± 40 ms
// in the remote's channel. "Detected" means we're really locked onto a
// V.22 signal at the expected carrier, not just picking up any energy.
//
// We use the demodulator's running symbol magnitude as our indicator:
// a real V.22 signal modulated at 1200 Hz carrier produces consistent
// symbol magnitudes (~0.05+ measured in real captures) after the
// matched filter; out-of-band junk (1800 Hz guard tone, line noise,
// echo) falls way below that through the matched filter centered on
// 1200 Hz.
//
// Threshold 0.02 leaves good margin: real signal ~0.05, junk well
// below 0.01.
const V22_REMOTE_MAG_THRESHOLD = 0.02;
// V22_REMOTE_DETECT_MS: continuous detection duration required before
// declaring remote detected. Spec §6.3.1.2.2(b) specifies 270 ± 40 ms,
// which is the minimum a spec-compliant V.22 modem must wait. We use
// 400 ms — an extra margin that gives robust rejection of V.32 Signal
// AA teardown transients. When the calling modem gives up on V.32 (at
// ~T+9s after no AC response) it goes silent then resumes at 1200 Hz
// V.22 mode; during the brief teardown window, spectral ratios can
// fluctuate. 400 ms ensures we only latch onto the modem's stable
// post-V.32-fallback V.22 signal.
const V22_REMOTE_DETECT_MS     = 400;
// V.22 SB1 transmit duration.
//
// ITU V.22bis §6.3.1.2.2(c) specifies 765 ± 10 ms as the minimum. In
// practice, real hardware modems may still be finalising their
// receiver equalizer and timing-recovery loop beyond that window. If
// we transition to DATA mode exactly at 765 ms and our upper layers
// (TelnetProxy) attach and push bytes, those bytes arrive while the
// modem's receiver is still converging — a "data too early" race
// that can cause the modem to abort the handshake without ever
// asserting Carrier Detect to its DTE.
//
// The line-level output of SB1 (scrambled binary 1 at 1200 bit/s)
// and DATA-with-empty-queue (idle marking through the scrambler)
// are IDENTICAL waveforms — the scrambler state is continuous across
// the setMode() boundary. So extending SB1 beyond spec minimum is
// transparent to the remote modem: it sees the same line signal it
// would see during idle DATA anyway. The only difference is that
// we hold off firing 'ready' (and thus TelnetProxy attachment) until
// the extra dwell time has elapsed.
//
// 2000 ms gives the modem ~1.2 seconds of safety margin beyond the
// 765 ms minimum.
const V22_SB1_TX_MS            = 2000;  // spec min 765ms; extended for safety
const V22_HANDSHAKE_TIMEOUT_MS = 8000;  // give up if remote never engages

class V22 extends EventEmitter {
  constructor(role) {
    super();
    this._role       = role;
    const isAnswer   = role === 'answer';
    const txCarrier  = isAnswer ? CARRIER_HIGH : CARRIER_LOW;
    const rxCarrier  = isAnswer ? CARRIER_LOW  : CARRIER_HIGH;
    this._rxCarrier  = rxCarrier;
    this.modulator   = new QAMModulator({
      carrier:       txCarrier,
      bitsPerSymbol: 2,
      // Guard tone at 1800 Hz is required by V.22bis §2.2 in the
      // high-channel TX (the answerer's TX, which is what we emit
      // here). It is a continuous CW signal that the calling modem's
      // RX uses as a stable AGC and timing reference, distinct from
      // the data carrier.
      //
      // Earlier this was set to `false` with a comment claiming it
      // was "optional" and "may confuse non-strict receivers" — that
      // analysis was wrong on multiple counts:
      //
      //   1. V.22bis spec REQUIRES the guard tone in the high
      //      channel. Optional under V.22 (non-bis), required for
      //      V.22bis interop.
      //   2. The 1800 Hz tone sits OUTSIDE the calling modem's
      //      data-band RX matched filter (centered at 1200 Hz with
      //      ±300 Hz sidebands at 600 baud). Spandsp's 1200 Hz RX
      //      RRC measured -36 dB rejection at 1800 Hz. The guard
      //      tone is by design well outside the data band.
      //   3. The guard tone's purpose is precisely to provide a
      //      continuous CW reference that the calling modem's
      //      AGC/PLL/equalizer can lock onto — particularly during
      //      long idle periods when the data carrier alone (QAM
      //      with random phase changes from the scrambler) gives
      //      the receiver insufficient reference.
      //
      // Symptom of having this disabled: long pure-marking idle
      // periods (e.g. CONNECT> prompt) produced visible terminal
      // garbage on the calling modem's terminal because its
      // descrambler/UART couldn't track stably without the guard-
      // tone reference. BBS data flows look fine because frequent
      // UART start bits provide localized resync points.
      //
      // The slmodemd-pjsip backend doesn't show this issue because
      // its (closed-source) DSP follows the spec and emits the
      // guard tone — that was the user-observation that nailed the
      // root cause.
      guardTone:     true,
    });
    this.demodulator = new QAMDemodulator({
      carrier:       rxCarrier,
      bitsPerSymbol: 2,
    });
    this.demodulator.on('data', buf => {
      if (this._phase === V22_HS_PHASE.DATA) this.emit('data', buf);
    });

    this._phase              = V22_HS_PHASE.INIT;
    this._phaseSamples       = 0;       // samples since current phase start
    this._totalSamples       = 0;       // samples since handshake start

    // Detection state
    this._remoteMagAboveSamp = 0;       // consecutive samples mag > threshold
    this._remoteDetected     = false;

    // Listener-notification state (for the 'listening' event when we
    // enter waiting-for-scrambled-response mode)
    this._emittedListening   = false;
  }

  _enterPhase(phase) {
    this._phase        = phase;
    this._phaseSamples = 0;
    switch (phase) {
      case V22_HS_PHASE.USB1:
        this.modulator.setMode('unscr-ones');
        // We're now transmitting USB1 and listening for remote's scrambled
        // signal. Signal "listening" to Handshake.js so it can log.
        if (!this._emittedListening) {
          this._emittedListening = true;
          this.emit('listening', { phase: 'usb1' });
        }
        break;
      case V22_HS_PHASE.SB1:
        this.modulator.setMode('scr-ones');
        break;
      case V22_HS_PHASE.DATA:
        this.modulator.setMode('data');
        this.emit('ready', {
          bps:            1200,
          remoteDetected: this._remoteDetected,
        });
        break;
    }
  }

  _advanceHandshake(n) {
    if (this._phase === V22_HS_PHASE.INIT) {
      this._enterPhase(V22_HS_PHASE.USB1);
      return;
    }
    if (this._phase === V22_HS_PHASE.DATA) return;

    this._phaseSamples += n;
    this._totalSamples += n;

    // Hard timeout: if remote never engages at all, abandon the handshake.
    const totalMs = this._totalSamples * 1000 / SR;
    if (!this._remoteDetected && totalMs >= V22_HANDSHAKE_TIMEOUT_MS) {
      // Enter DATA phase with remoteDetected=false so Handshake.js
      // reports handshake-failed instead of falsely claiming connected.
      this._enterPhase(V22_HS_PHASE.DATA);
      return;
    }

    if (this._phase === V22_HS_PHASE.USB1) {
      // §6.3.1.2.2(b): switch to SB1 once remote has been detected for
      // V22_REMOTE_DETECT_MS continuously.
      if (this._remoteDetected) {
        this._enterPhase(V22_HS_PHASE.SB1);
      }
      return;
    }

    if (this._phase === V22_HS_PHASE.SB1) {
      // §6.3.1.2.2(c): transmit scrambled binary 1 for 765 ± 10 ms.
      const sb1Samples = Math.round(V22_SB1_TX_MS * SR / 1000);
      if (this._phaseSamples >= sb1Samples) {
        this._enterPhase(V22_HS_PHASE.DATA);
      }
      return;
    }
  }

  _trackRxDetection(samples) {
    // Robust V.22 call-mode detector. Two independent tests must both
    // pass before we declare remote-detected:
    //
    //   (1) Symbol magnitude from the demodulator's matched filter at
    //       rxCarrier is above V22_REMOTE_MAG_THRESHOLD. Rules out
    //       silence and low-level noise.
    //
    //   (2) Spectral shape matches V.22 call-mode: energy in a narrow
    //       band around rxCarrier (1200 Hz for answer-side) exceeds
    //       energy at 1800 Hz by a factor of 3 or more. This rejects
    //       a specific false positive observed in real captures: the
    //       modem transmits a 1800 Hz tone before/during its V.22
    //       attempt. The matched filter at 1200 Hz is NOT sufficiently
    // Detection strategy:
    //
    //   1. Spectral-shape test (carrier / ghost ratio):
    //      the carrier-bin Goertzel must be at least 10× the 1800 Hz
    //      ghost-bin Goertzel. This is the critical filter against
    //      ITU-T V.32 Signal AA — a continuous 1800 Hz tone that
    //      modern modems emit as the FIRST signal in "automode"
    //      fallback when they hear a plain V.25 ANS tone (no V.8 AM
    //      modulation). The AA segment lasts ~3 seconds while the
    //      modem waits for V.32 response signal AC (600/3000 Hz). If
    //      we don't answer, the modem gives up V.32, goes silent
    //      briefly, and falls back to V.22 at 1200 Hz carrier.
    //      During the AA phase, ghost energy dominates by ~3:1; during
    //      real V.22 call-mode at 1200 Hz, carrier dominates by 10:1+.
    //      A 10× threshold cleanly separates these regimes.
    //
    //   2. Minimum continuous duration: 400 ms. The real V.22 signal
    //      is stable carrier + broadband modulation; the spectral
    //      ratio holds steady. During V.32 AA teardown transients
    //      the ratio can briefly touch 10:1 — the 400 ms window makes
    //      us require a sustained real signal, not transient leakage.
    //
    //   3. Symbol magnitude threshold (existing): carrier-bin content
    //      in the matched filter must be above the noise floor. This
    //      rules out pure silence and very weak lines.
    //
    // Note: an absolute carrier-energy floor (e.g. > 0.05) was
    // considered but rejected — the real V.22 signal on captures
    // measures only ~0.013-0.018 at the carrier bin (because it's
    // spread across the 600 Hz occupied band, not concentrated at
    // a single frequency). An 0.05 floor would reject legitimate
    // signal.
    const mag = this.demodulator.symbolMag;
    const detectSamples = Math.round(V22_REMOTE_DETECT_MS * SR / 1000);

    // Running Goertzel at rxCarrier and 1800 Hz
    this._goertzelRxCarrier(samples);
    this._goertzelGhost(samples);
    const carrierEnergy = this._carrierEnergy;
    const ghostEnergy   = this._ghostEnergy;

    // Spectral-shape test: carrier must dominate ghost by ≥3:1.
    //
    // On real captures:
    //   - Real V.22 call-mode signal: ratio 3-9 (avg ~5)
    //   - V.32 Signal AA (1800 Hz pure tone): ratio 0.2-0.5 (ghost dominates)
    //   - V.32 AA teardown transients: brief ratio spikes toward 1-2
    // A 3× threshold cleanly separates real V.22 from AA while still
    // admitting the lower-ratio moments of real signal. The extended
    // 400 ms continuous-detect window handles the brief teardown-
    // transient false positives.
    const spectralOK = carrierEnergy > 3 * (ghostEnergy + 0.001);
    const magOK      = mag > V22_REMOTE_MAG_THRESHOLD;

    // Periodic diagnostic trace (every 500ms) — helps us see the spectral
    // shape evolution during the V.32 AA phase vs real V.22 phase, so
    // we can understand why live detection differs from simulation.
    // Gated on V32_DEBUG env var; zero cost when off.
    if (process.env.V32_DEBUG && !this._remoteDetected) {
      this._diagSampleCount = (this._diagSampleCount || 0) + samples.length;
      if (this._diagSampleCount >= 4000) {   // every ~500ms
        this._diagSampleCount = 0;
        const totalMs = (this._totalSamples * 1000 / SR).toFixed(0);
        process.stderr.write(
          `[V22-SCAN ] t_V22local=${totalMs}ms ` +
          `mag=${mag.toFixed(4)} ` +
          `carrierE=${carrierEnergy.toFixed(4)} ` +
          `ghostE=${ghostEnergy.toFixed(4)} ` +
          `ratio=${(carrierEnergy / (ghostEnergy + 0.001)).toFixed(2)} ` +
          `magOK=${magOK} specOK=${spectralOK} ` +
          `above=${this._remoteMagAboveSamp || 0}\n`
        );
      }
    }

    if (magOK && spectralOK) {
      this._remoteMagAboveSamp += samples.length;
      if (!this._remoteDetected && this._remoteMagAboveSamp >= detectSamples) {
        this._remoteDetected = true;
        // Diagnostic dump at detection moment — helps diagnose live-vs-
        // simulation discrepancies. Writes to stderr (which is captured
        // to the V32_DEBUG log). Harmless in production; cheap to leave
        // in place.
        if (process.env.V32_DEBUG) {
          const totalMs = (this._totalSamples * 1000 / SR).toFixed(0);
          process.stderr.write(
            `[V22-DETECT] t_V22local=${totalMs}ms ` +
            `mag=${mag.toFixed(4)} ` +
            `carrierE=${carrierEnergy.toFixed(4)} ` +
            `ghostE=${ghostEnergy.toFixed(4)} ` +
            `ratio=${(carrierEnergy / (ghostEnergy + 0.001)).toFixed(2)}\n`
          );
        }
        this.emit('remote-detected', {
          rms:            mag,
          carrierEnergy:  carrierEnergy,
          ghostEnergy:    ghostEnergy,
        });
      }
    } else {
      // Require continuous above-threshold. Any break resets.
      this._remoteMagAboveSamp = 0;
    }
  }

  /** Single-block Goertzel at rxCarrier (stateless — full block). */
  _goertzelRxCarrier(samples) {
    const f = this._rxCarrier;
    const k = 2 * Math.PI * f / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const nw = samples[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    const mag = Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / samples.length;
    // Smooth with running average
    this._carrierEnergy = (this._carrierEnergy || 0) * 0.8 + mag * 0.2;
  }

  /** Single-block Goertzel at 1800 Hz (ghost tone band). */
  _goertzelGhost(samples) {
    const k = 2 * Math.PI * 1800 / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const nw = samples[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    const mag = Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / samples.length;
    this._ghostEnergy = (this._ghostEnergy || 0) * 0.8 + mag * 0.2;
  }

  write(data)           { this.modulator.write(data); }
  generateAudio(n)      { this._advanceHandshake(n); return this.modulator.generate(n); }
  receiveAudio(samples) {
    // Feed the demodulator first so symbolMag updates before we check it.
    this.demodulator.process(samples);
    this._trackRxDetection(samples);
  }
  reset() {
    this.modulator.reset(); this.demodulator.reset();
    this._phase              = V22_HS_PHASE.INIT;
    this._phaseSamples       = 0;
    this._totalSamples       = 0;
    this._remoteMagAboveSamp = 0;
    this._remoteDetected     = false;
    this._emittedListening   = false;
  }
  get name()           { return 'V22'; }
  get bps()            { return 1200; }
  get phase()          { return this._phase; }
  get ready()          { return this._phase === V22_HS_PHASE.DATA; }
  get remoteDetected() { return this._remoteDetected; }
  get rxEnergy()       { return this.demodulator.symbolMag; }
}

// ─── V.22bis handshake ─────────────────────────────────────────────────────

/**
 * Handshake state machine per ITU-T V.22bis §6.3.1.1.
 *
 * Event-driven per the spec. The V.22bis answer modem transmits
 * unscrambled binary 1 (USB1) continuously, and only advances once
 * the remote is detected. The remote's response determines whether
 * we end up at 2400 bit/s (V.22bis) or fall back to 1200 bit/s (V.22).
 *
 * ANSWER side (§6.3.1.1.2):
 *   (a) Transmit USB1 at 1200 bit/s, indefinitely.
 *   (b) On detection of scrambled binary 1 or 0 in low channel for
 *       270 ± 40 ms: fall back to V.22 (§6.3.1.2.2), i.e. transmit
 *       scrambled binary 1 at 1200 bit/s for 765 ± 10 ms → DATA.
 *       On detection of unscrambled S1 (double-dibit 00/11) from the
 *       remote: transmit S1 ourselves for 100 ± 3 ms, then scrambled
 *       binary 1 at 1200 bit/s.
 *   (c) 600 ± 10 ms after circuit 112 on (i.e. 600 ms after we finish
 *       our S1 transmission): begin transmitting scrambled binary 1
 *       at 2400 bit/s.
 *   (d) After 200 ± 10 ms at 2400 bit/s: ready for data.
 *
 * CALL side (§6.3.1.1.1): not yet implemented. When we add it, the
 * call modem starts SILENT, listens for USB1 for 155 ± 10 ms, waits
 * 456 ± 10 ms, then begins its own S1. The current implementation
 * logs a warning and runs the answer flow — safe for our "answer-only"
 * usage, wrong for future call-side support.
 */

// V.22bis answer-side TX training stages, named to match spandsp's
// V22BIS_TX_TRAINING_STAGE_* enums one-for-one. Spandsp's RX state
// machine writes into TX state at S1-detection time; we follow the
// same model — the QAMDemodulator emits a 'negotiated-rate-change'
// event when it detects the caller's S1, and this class transitions
// TX from U11 → U0011 in response. The other transitions are TX-
// timer-driven.
//
// Per spec §6.3.1.1.2 and spandsp v22bis_tx.c:
//
//   INIT → INITIAL_TIMED_SILENCE (75 ms)
//        → U11 (unscrambled binary 1, until caller's S1 detected
//               OR until caller's scrambled-1 sustains long enough
//               that we know the caller is V.22-only; the demod
//               state machine arbitrates)
//        →   if 2400 negotiated → U0011 (S1) for 100 ms
//                              → TIMED_S11 (scrambled 1 @ 1200 baud,
//                                  preloaded so total elapsed is
//                                  756 ms from U0011 start)
//                              → S1111 (scrambled 1 @ 2400 baud,
//                                       200 ms)
//                              → NORMAL_OPERATION at 2400
//        →   if 1200 fallback → TIMED_S11 (scrambled 1 @ 1200, 765 ms)
//                            → NORMAL_OPERATION at 1200
//
// We keep the old `HS_PHASE` export name for backward compatibility
// with tests that might import it; the values now map to these
// spandsp-style stage names.
const HS_PHASE = Object.freeze({
  INIT:                    'init',
  INITIAL_TIMED_SILENCE:   'initial_timed_silence',
  U11:                     'u11',
  U0011:                   'u0011',                  // S1
  TIMED_S11:               'timed_s11',
  S1111:                   's1111',
  DATA:                    'data',
});

// Phase durations (ms). Spec values from V.22bis §6.3.1.1.2 / §6.3.1.2.2.
const HS_DURATION = {
  INITIAL_TIMED_SILENCE: 75,    // §6.3.1.1.2(a) / spandsp 75 ms
  U0011:                100,    // S1: 100 ± 3 ms
  // TIMED_S11 has TWO durations depending on whether we got here via
  // the 2400-path or the 1200-fallback path:
  TIMED_S11_2400:       656,    // 756 - 100 = 656; total elapsed time
                                // from U0011 start is 756 ms when this
                                // ends. (Spandsp uses
                                // `training_count = ms_to_symbols(756 - (600 - 100))`
                                // which preloads the 756 ms timer to land
                                // 656 ms after U0011 ends.)
  TIMED_S11_1200:       765,    // §6.3.1.2.2(c): 765 ± 10 ms
                                // for V.22 fallback. Used when the demod
                                // never sees S1 and times out into 1200
                                // committed.
  S1111:                200,    // 200 ± 10 ms
};

// V.22bis detection uses the same narrowband / spectral-shape approach
// as V.22. See V22 class for detailed rationale.
const V22BIS_REMOTE_MAG_THRESHOLD = 0.02;
// V22BIS_REMOTE_DETECT_MS: match V22_REMOTE_DETECT_MS (400 ms) — see
// its comment for rationale (V.32 Signal AA teardown transient
// rejection).
const V22BIS_REMOTE_DETECT_MS     = 400;
const V22BIS_HANDSHAKE_TIMEOUT_MS = 8000;

// Spectral S1 detector tuning. S1 (alternating 00/11 dibits at 600 baud
// on a 1200 Hz carrier) produces a very characteristic spectrum: strong
// peaks at the carrier ± baud/2 (i.e. 900 and 1500 Hz for the answerer's
// RX path) and valleys at the off-sideband bins (1050 and 1350 Hz).
// Scrambled-1 is approximately flat across the V.22 band; unscrambled-1
// (USB1) has a peak at carrier - baud/4 = 1050 Hz with no peak at 900/
// 1500. So a simple peaks-vs-valleys ratio test cleanly separates S1
// from both SB1 and USB1.
//
// Empirically on a real V.22bis caller dialing in via SIP/RTP:
//   S1 phase    : peaks/valleys ratio = 14-25 (very strong)
//   SB1 (random): peaks/valleys ratio = 0.1-1.5 (mostly < 2)
//   USB1        : peaks/valleys ratio < 1 (peak at 1050 dominates)
//
// We chunk RX into non-overlapping 20 ms windows, run Goertzels, and
// fire when N consecutive windows pass threshold. 4 consecutive
// windows = 80 ms minimum, comfortably inside the caller's 100 ms S1
// transmission window.
const V22BIS_S1_DETECTOR_WINDOW_MS    = 20;       // 160 samples @ 8 kHz
const V22BIS_S1_DETECTOR_RATIO        = 2.0;      // peaks > 2x valleys
const V22BIS_S1_DETECTOR_MIN_CARRIER  = 0.005;    // 1200 Hz must be present
const V22BIS_S1_DETECTOR_RUN_LEN      = 4;        // 4 consecutive 20 ms windows
                                                  //   = 80 ms minimum, fits in
                                                  //   S1's 100 ms window

/**
 * V.22bis answerer-side handshake and data-mode driver.
 *
 * ### Architecture
 *
 * Two state machines, modelled after spandsp's v22bis_tx.c /
 * v22bis_rx.c:
 *
 *   - **TX state machine** (this class) — drives the modulator
 *     through the answerer's training sequence: INITIAL_TIMED_SILENCE
 *     → U11 → U0011 (S1) → TIMED_S11 → S1111 → DATA at 2400. The
 *     fallback path (no S1 detected from caller) is U11 → TIMED_S11
 *     → DATA at 1200. Most TX transitions are timer-driven.
 *
 *   - **RX state machine** (in QAMDemodulator) — drives the
 *     demodulator through symbol acquisition, the 16-way slicer
 *     activation, and NORMAL_OPERATION. The 16-way switch is gated
 *     on `_negotiatedBitRate === 2400`, which we set when S1 is
 *     detected (see below).
 *
 * ### S1 detection: spectral, not symbol-based
 *
 * The pre-port code relied on the demodulator's symbol-stream-based
 * S1 detector (count phase-step XOR pattern repeats over consecutive
 * symbols). That's what spandsp does. But against real V.22bis
 * caller signals via SIP/RTP, this detector fails reliably: by the
 * time the demod's symbol acquisition finishes (~67 ms), only ~24
 * symbols of the caller's 100 ms S1 burst remain, and the equalizer
 * + carrier track haven't converged enough in those 24 symbols to
 * cleanly recover the alternating phase. The carrier-track loop in
 * particular tends to phantom-lock on S1's regular 90°/symbol
 * rotation, producing a stationary post-NCO baseband that defeats
 * the slicer's quadrant-delta detection.
 *
 * Instead, we use a **spectral test** on the raw input audio. S1's
 * regular alternation produces strong narrowband peaks at the carrier
 * ± baud/2 (900 and 1500 Hz for the answerer) with characteristic
 * valleys at the off-sideband bins (1050 and 1350 Hz). A simple
 * peaks-vs-valleys ratio test fires reliably during S1 and is silent
 * during USB1 / SB1 / data. See `_runS1Detector()` below for the
 * exact computation and `V22BIS_S1_DETECTOR_*` constants for tuning
 * notes.
 *
 * When the spectral detector fires, we:
 *   1. Push `_negotiatedBitRate = 2400` directly into the demodulator
 *      (so its training state machine takes the 2400 branch — the
 *      450 ms timer to switch on the 16-way slicer, then
 *      WAIT_FOR_SCRAMBLED_ONES_AT_2400, then NORMAL).
 *   2. Advance our own TX from U11 to U0011 (S1 response, 100 ms),
 *      then TIMED_S11 (656 ms scrambled-1 at 1200), then S1111
 *      (200 ms scrambled-1 at 2400 = 16-QAM), then DATA at 2400.
 *
 * Spandsp's RX state machine has the same effect — its symbol-based
 * S1 detector writes `_negotiatedBitRate = 2400` and pushes the TX
 * state machine into U0011. We achieve the same result via a
 * different (more robust) S1 detector.
 *
 * ### Why we still keep `_trackRxDetection` here
 *
 * `_trackRxDetection` checks "is anyone there?" via two narrowband
 * tests (carrier energy, ghost rejection). It's a coarse "yes, there
 * is some V.22-class signal on the line" gate that lets us declare a
 * connection failure ('handshake-failed' with reason 'no-remote-
 * carrier') if nothing is heard within the 8s timeout.
 *
 * ### Public interface (unchanged)
 *
 *   - generateAudio(n) → Float32Array
 *   - receiveAudio(samples)
 *   - write(bytes)            (only valid once 'ready' has fired)
 *   - 'data' event            (post-ready bytes from demodulator)
 *   - 'ready' event           ({ bps, remoteDetected })
 *   - 'remote-detected' event ({ rms, carrierEnergy, ghostEnergy })
 *   - 'listening' event       (transmit started, awaiting remote)
 *   - 's1-detected' event     ({ ratio, m900, m1500 })  (NEW)
 */
class V22bis extends EventEmitter {
  constructor(role) {
    super();
    this._role     = role;
    const isAnswer = role === 'answer';
    if (!isAnswer) {
      // The synthmodem product only ever runs as the answer side
      // (a real modem dials INTO us, we proxy a telnet connection).
      // The originate-side V.22bis flow exists in the spec but has
      // never been needed in production. The test client uses V.22
      // (1200) for self-loopback validation; if originate-side
      // V.22bis is ever needed it can be added here following
      // spandsp's v22bis_tx.c calling-side path
      // (INITIAL_SILENCE → U0011 conditional on RX U11 → ...).
      // For now, fall through to the answer-side flow with a
      // warning at startup time.
    }

    // V.22bis answer-side: TX on the high carrier (2400 Hz),
    // RX from the low carrier (1200 Hz).
    const txCarrier  = isAnswer ? CARRIER_HIGH : CARRIER_LOW;
    const rxCarrier  = isAnswer ? CARRIER_LOW  : CARRIER_HIGH;
    this._rxCarrier  = rxCarrier;

    this.modulator = new QAMModulator({
      carrier:       txCarrier,
      bitsPerSymbol: 2,                  // start at V.22 rate during handshake
      // Guard tone enabled — V.22bis spec §2.2 requires it in the
      // high-channel TX. See V22 class constructor (above) for the
      // full rationale; the gist is that it provides the calling
      // modem's RX with a continuous CW reference for AGC/timing
      // stability during long idle periods.
      guardTone:     true,
    });

    this.demodulator = new QAMDemodulator({
      carrier:       rxCarrier,
      bitsPerSymbol: 2,
      // CRITICAL: bitRate=2400 enables the demodulator's own S1
      // detector. Without this, the demod stays committed to 1200
      // even if the caller sends S1 — the V.22 class doesn't pass
      // this so it gets the default 1200 and behaves as plain V.22.
      bitRate:       2400,
    });

    // Subscribe to demodulator events. Three signals matter:
    //
    //   1. 'negotiated-rate-change' from the demod's symbol-based S1
    //      detector — kept as a redundant trigger for U11 → U0011,
    //      though in practice our spectral detector beats it to the
    //      punch in real-world tests (the demod's symbol-based
    //      detector tends to phantom-lock on S1's regular phase
    //      pattern; see the JSDoc above).
    //   2. 'training-done' from the demod's RX state machine —
    //      RX has reached NORMAL_OPERATION. Used in the V.22
    //      fallback path to know when to advance our TX from U11
    //      to TIMED_S11.
    //   3. 'data' → forward UART bytes once we ourselves have
    //      reached DATA phase (the demod gates byte emission on
    //      its own NORMAL_OPERATION but we double-gate to defend
    //      against a small race window between demod-NORMAL and
    //      our own TX state machine reaching DATA).
    this.demodulator.on('negotiated-rate-change', evt => {
      if (evt.bitRate === 2400 && this._phase === HS_PHASE.U11) {
        this._onS1Detected('demod');
      }
    });
    this.demodulator.on('training-done', evt => {
      // RX side has reached NORMAL_OPERATION. If we negotiated 1200
      // (V.22 fallback path) and we're still in U11, this is the
      // signal to advance to TIMED_S11.
      if (evt.bitRate === 1200 && this._phase === HS_PHASE.U11) {
        this._negotiatedBps = 1200;
        this._enterPhase(HS_PHASE.TIMED_S11);
      }
      // If we negotiated 2400, our TX timing controls the rest of the
      // sequence. The demod's NORMAL_OPERATION just confirms RX is
      // ready; we'll fire 'ready' when our own TX reaches DATA.
    });
    this.demodulator.on('data', buf => {
      // Forward bytes once we've declared DATA phase. See gate
      // discussion above.
      if (this._phase === HS_PHASE.DATA) this.emit('data', buf);
    });

    // TX state machine
    this._phase               = HS_PHASE.INIT;
    this._phaseSamples        = 0;        // samples elapsed in current phase
    this._totalSamples        = 0;        // samples since handshake start

    // Carrier presence (coarse "is anyone there?" detector)
    this._remoteMagAboveSamp  = 0;
    this._remoteDetected      = false;
    this._emittedListening    = false;

    // Negotiated data rate. Set by 'negotiated-rate-change' (2400)
    // or by the V.22 fallback timeout in TIMED_S11 entry (1200).
    this._negotiatedBps       = 1200;

    // Spectral S1 detector state. Accumulate samples into a 20 ms
    // window (160 samples at 8 kHz); when full, run Goertzels at the
    // four bins, evaluate peaks-vs-valleys ratio, count consecutive
    // windows above threshold. Fires _onS1Detected('spectral') after
    // V22BIS_S1_DETECTOR_RUN_LEN consecutive passing windows.
    //
    // Non-overlapping windows are sufficient here because we don't
    // need fine timing — we just need to recognize S1 within the
    // caller's 100 ms transmission. 4 consecutive 20 ms windows =
    // 80 ms total, comfortably inside the spec window.
    this._s1WinSize    = Math.round(V22BIS_S1_DETECTOR_WINDOW_MS * SR / 1000); // 160
    this._s1Buf        = new Float32Array(this._s1WinSize);
    this._s1BufFill    = 0;        // count of samples written into _s1Buf
    this._s1RunLen     = 0;        // consecutive windows above threshold
    this._s1Detected   = false;    // latched once detector fires
  }

  /**
   * Called when S1 has been detected (either by the demod's symbol-
   * based detector via 'negotiated-rate-change', or by our spectral
   * detector via _runS1Detector). Advances TX to U0011 and pushes
   * the demod into 2400 mode.
   *
   * @param {string} source 'demod' or 'spectral' — for logging.
   */
  _onS1Detected(source) {
    if (this._s1Detected) return;
    if (this._phase !== HS_PHASE.U11) return;
    this._s1Detected   = true;
    this._negotiatedBps = 2400;

    // Push the demodulator into 2400 mode. Several writes:
    //
    //   - _negotiatedBitRate = 2400 makes its training state machine
    //     take the 2400 branch (450 ms timer to switch on sixteen-way,
    //     then WAIT_FOR_SCRAMBLED_ONES_AT_2400, then NORMAL).
    //   - _patternRepeats = 0 clears any stale symbol-based-detector
    //     accumulation.
    //   - If the demod is currently in SCRAMBLED_ONES_AT_1200_SUSTAINING
    //     (which can happen if our spectral detector fires very late,
    //     after the demod's 270 ms SCRAMBLED_ONES_AT_1200 timer has
    //     already pushed it into SUSTAINING), snap it back to
    //     SCRAMBLED_ONES_AT_1200 with training_count=0 so the 2400
    //     branch's 450 ms timer can fire. SUSTAINING itself doesn't
    //     check _negotiatedBitRate; it would otherwise just wait out
    //     its 1035 ms and exit to NORMAL at 1200, defeating us.
    this.demodulator._negotiatedBitRate = 2400;
    this.demodulator._patternRepeats    = 0;
    if (this.demodulator._training === RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING) {
      this.demodulator._training      = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
      this.demodulator._trainingCount = 0;
    }

    // S1 detection is unambiguous proof that a remote V.22bis modem is
    // present — far stronger evidence than the coarse carrier-energy /
    // ghost-rejection heuristic in _trackRxDetection. Mark the remote
    // as detected and emit the event so the upstream Handshake.js
    // accepts our eventual 'ready' as a successful handshake.
    //
    // Without this, there's a race: our spectral detector fires at
    // ~780 ms after V22bis training start, but _trackRxDetection's
    // 400 ms hysteresis on carrier presence may not have crossed yet
    // (especially during the early-call window where the SIP gateway's
    // own AEC is still training and the caller's data carrier is
    // partially obscured by guard-tone echo). Our TX state machine
    // then completes its 1.5-second sequence and fires 'ready' with
    // remoteDetected=false, which Handshake.js interprets as
    // "no remote carrier" and fails the handshake.
    if (!this._remoteDetected) {
      this._remoteDetected = true;
      this.emit('remote-detected', {
        rms:           this.demodulator.symbolMag,
        carrierEnergy: this._carrierEnergy || 0,
        ghostEnergy:   this._ghostEnergy   || 0,
        viaS1:         true,
      });
    }

    this.emit('s1-detected', { source });
    this._enterPhase(HS_PHASE.U0011);
  }

  _enterPhase(phase) {
    this._phase        = phase;
    this._phaseSamples = 0;
    switch (phase) {
      case HS_PHASE.INITIAL_TIMED_SILENCE:
        // 75 ms of silence per spec §6.3.1.1.2(a). Set the modulator
        // to emit zero output. We use 'unscr-ones' as a placeholder
        // because there's no 'silence' mode — the absent guard tone
        // would still be audible. Spec actually says "no signal" so
        // we'll just not call generate() — handled in generateAudio()
        // below by checking the phase directly.
        this.modulator.setBitsPerSymbol(2);
        this.modulator.setMode('unscr-ones');
        break;
      case HS_PHASE.U11:
        this.modulator.setBitsPerSymbol(2);
        this.modulator.setMode('unscr-ones');
        if (!this._emittedListening) {
          this._emittedListening = true;
          this.emit('listening', { phase: 'u11' });
        }
        break;
      case HS_PHASE.U0011:
        // S1 — alternating 00/11 dibits at 1200 baud, 100 ms.
        this.modulator.setBitsPerSymbol(2);
        this.modulator.setMode('alt-00-11');
        break;
      case HS_PHASE.TIMED_S11:
        // Scrambled binary 1 at 1200 baud. Duration depends on which
        // path we got here from:
        //   2400 path: TIMED_S11_2400 = 656 ms (ends 756 ms after
        //              U0011 started)
        //   1200 path: TIMED_S11_1200 = 765 ms
        this.modulator.setBitsPerSymbol(2);
        this.modulator.setMode('scr-ones');
        break;
      case HS_PHASE.S1111:
        // Scrambled binary 1 at 2400 baud (16-QAM), 200 ms. Switch
        // the modulator to 4 bits/symbol. The demodulator should
        // already have switched to 16-way slicing on its own (driven
        // by its training state machine, 450 ms after entering
        // SCRAMBLED_ONES_AT_1200 in 2400 mode).
        this.modulator.setBitsPerSymbol(4);
        this.modulator.setMode('scr-ones');
        break;
      case HS_PHASE.DATA:
        this.modulator.setBitsPerSymbol(this._negotiatedBps === 2400 ? 4 : 2);
        this.modulator.setMode('data');
        this.emit('ready', {
          bps:            this._negotiatedBps,
          remoteDetected: this._remoteDetected,
        });
        break;
    }
  }

  _advanceHandshake(n) {
    if (this._phase === HS_PHASE.INIT) {
      this._enterPhase(HS_PHASE.INITIAL_TIMED_SILENCE);
      return;
    }
    if (this._phase === HS_PHASE.DATA) return;

    this._phaseSamples += n;
    this._totalSamples += n;

    // Hard timeout: if remote never engages at all, abandon the
    // handshake. The 'no-remote-carrier' path lets Handshake.js
    // report a clean handshake-failed instead of falsely declaring
    // connected.
    const totalMs = this._totalSamples * 1000 / SR;
    if (!this._remoteDetected && totalMs >= V22BIS_HANDSHAKE_TIMEOUT_MS) {
      this._negotiatedBps = 1200;
      this._enterPhase(HS_PHASE.DATA);
      return;
    }

    switch (this._phase) {
      case HS_PHASE.INITIAL_TIMED_SILENCE: {
        const durSamples = Math.round(HS_DURATION.INITIAL_TIMED_SILENCE * SR / 1000);
        if (this._phaseSamples >= durSamples) {
          this._enterPhase(HS_PHASE.U11);
        }
        return;
      }
      case HS_PHASE.U11:
        // Exit is event-driven by the demodulator:
        //   - 'negotiated-rate-change' to 2400 → U0011
        //   - 'training-done' at 1200 → TIMED_S11 (V.22 fallback)
        // Nothing to do per-block here.
        return;
      case HS_PHASE.U0011: {
        // S1 transmission: 100 ms.
        const durSamples = Math.round(HS_DURATION.U0011 * SR / 1000);
        if (this._phaseSamples >= durSamples) {
          this._enterPhase(HS_PHASE.TIMED_S11);
        }
        return;
      }
      case HS_PHASE.TIMED_S11: {
        const durMs = (this._negotiatedBps === 2400)
          ? HS_DURATION.TIMED_S11_2400
          : HS_DURATION.TIMED_S11_1200;
        const durSamples = Math.round(durMs * SR / 1000);
        if (this._phaseSamples >= durSamples) {
          if (this._negotiatedBps === 2400) {
            this._enterPhase(HS_PHASE.S1111);
          } else {
            this._enterPhase(HS_PHASE.DATA);
          }
        }
        return;
      }
      case HS_PHASE.S1111: {
        const durSamples = Math.round(HS_DURATION.S1111 * SR / 1000);
        if (this._phaseSamples >= durSamples) {
          this._enterPhase(HS_PHASE.DATA);
        }
        return;
      }
    }
  }

  _trackRxDetection(samples) {
    // Coarse "is anyone there?" check via narrowband + spectral-
    // shape tests. Same logic as the V22 class — see there for the
    // V.32 Signal AA rejection rationale.
    const mag = this.demodulator.symbolMag;
    const detectSamples = Math.round(V22BIS_REMOTE_DETECT_MS * SR / 1000);

    this._goertzelRxCarrier(samples);
    this._goertzelGhost(samples);
    this._goertzelFskMark(samples);
    const carrierEnergy = this._carrierEnergy || 0;
    const ghostEnergy   = this._ghostEnergy   || 0;
    const fskEnergy     = this._fskMarkEnergy || 0;

    const spectralOK = carrierEnergy > 3 * (ghostEnergy + 0.001);
    const magOK      = mag > V22BIS_REMOTE_MAG_THRESHOLD;

    // Anti-Bell-103 rejection: when V.22bis is used as a legacy automode
    // probe, a Bell103 caller transmits a pure 1270 Hz mark continuously.
    // The 50 Hz Goertzel bin resolution at 1200 Hz leaks ~30-50 % of
    // energy from 1270 Hz into the carrier bin, which is enough to pass
    // the existing 3:1 spectral-shape test. Capture analysis (see
    // captures_Bell103_300_withV8 and captures_V22_1200_withV8):
    //
    //   Source                | g(1200) | g(1270) | g(1270)/g(1200)
    //   ----------------------+---------+---------+----------------
    //   Bell103 mark idle     | ~0.000  | 0.054   | infinite
    //   V.22 carrier (QAM)    | 0.003-  | 0.005-  | 0.3 - 3.3
    //                         | 0.011   | 0.014   | (avg ~1.0)
    //
    // The discriminator is the RATIO of 1270 to 1200 energy — Bell103
    // is a pure tone with NO 1200 Hz energy, while real V.22 has nearly
    // equal energy at both because QAM modulation spreads its spectrum
    // across ±300 Hz around the 1200 Hz carrier. A "1270 must not be
    // dramatically louder than 1200" test (ratio ≤ 4) cleanly rejects
    // Bell103 while admitting V.22 even at its worst.
    //
    // Note: an earlier version used the inverse test — `carrierEnergy >
    // 1.5 * fskEnergy` — which spuriously rejected real V.22 carrier
    // because V.22 has substantial 1270 Hz content. Captures
    // 2026-04-30T16:49 (V.22-with-V.8) and …16:46 (Bell103-with-V.8)
    // documented both directions of that bug.
    const notBell103 = fskEnergy <= 4 * carrierEnergy + 0.002;

    if (magOK && spectralOK && notBell103) {
      this._remoteMagAboveSamp += samples.length;
      if (!this._remoteDetected && this._remoteMagAboveSamp >= detectSamples) {
        this._remoteDetected = true;
        this.emit('remote-detected', {
          rms:           mag,
          carrierEnergy: carrierEnergy,
          ghostEnergy:   ghostEnergy,
          fskEnergy:     fskEnergy,
        });
      }
    } else {
      this._remoteMagAboveSamp = 0;
    }
  }

  _goertzelRxCarrier(samples) {
    const f = this._rxCarrier;
    const k = 2 * Math.PI * f / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const nw = samples[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    const mag = Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / samples.length;
    this._carrierEnergy = (this._carrierEnergy || 0) * 0.8 + mag * 0.2;
  }

  _goertzelGhost(samples) {
    const k = 2 * Math.PI * 1800 / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const nw = samples[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    const mag = Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / samples.length;
    this._ghostEnergy = (this._ghostEnergy || 0) * 0.8 + mag * 0.2;
  }

  /**
   * Goertzel at 1270 Hz (Bell103 caller mark). When V.22bis is used as
   * a legacy automode probe and the actual caller is a Bell103 modem,
   * the caller's 1270 Hz mark idle leaks into our 1200 Hz carrier bin
   * (the bin is centered at 1200 with ~50 Hz resolution at typical
   * block sizes). An explicit 1270 Hz Goertzel lets us measure the
   * leak source and reject the false detection in _trackRxDetection.
   * We also implicitly cover V.21 (1180 Hz space, 75 Hz away from
   * 1200) — the 1270 Hz Goertzel response at 1180 Hz is small but
   * non-zero, and any real V.21 caller would also leak into 1200 too
   * so the symmetry holds; in practice the spectral-shape test
   * already rejects V.21 at the magnitude level.
   */
  _goertzelFskMark(samples) {
    const k = 2 * Math.PI * 1270 / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const nw = samples[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    const mag = Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / samples.length;
    this._fskMarkEnergy = (this._fskMarkEnergy || 0) * 0.8 + mag * 0.2;
  }

  /**
   * Spectral S1 detector. Accumulates RX samples into non-overlapping
   * 20 ms windows; for each completed window, runs Goertzels at the
   * four bins of interest and computes the peaks-vs-valleys ratio.
   * Counts consecutive windows above threshold and fires
   * _onS1Detected('spectral') when the run length reaches
   * V22BIS_S1_DETECTOR_RUN_LEN.
   *
   * Active only during HS_PHASE.U11 — once we've moved past U11 (either
   * via S1 detection or via 1200 fallback) the detector is disabled.
   */
  _runS1Detector(samples) {
    if (this._phase !== HS_PHASE.U11) return;
    if (this._s1Detected) return;

    for (let i = 0; i < samples.length; i++) {
      this._s1Buf[this._s1BufFill++] = samples[i];

      if (this._s1BufFill >= this._s1WinSize) {
        // Window full — evaluate.
        const rxC = this._rxCarrier;
        const m900  = this._goertzelOnS1Buf(rxC - 300);  // 900 Hz for ans
        const m1500 = this._goertzelOnS1Buf(rxC + 300);  // 1500 Hz
        const m1050 = this._goertzelOnS1Buf(rxC - 150);  // 1050 Hz
        const m1350 = this._goertzelOnS1Buf(rxC + 150);  // 1350 Hz
        const mCar  = this._goertzelOnS1Buf(rxC);         // 1200 Hz

        const peaks   = (m900  + m1500) / 2;
        const valleys = (m1050 + m1350) / 2;
        const ratio   = peaks / (valleys + 0.001);

        if (ratio > V22BIS_S1_DETECTOR_RATIO &&
            mCar  > V22BIS_S1_DETECTOR_MIN_CARRIER) {
          this._s1RunLen++;
          if (this._s1RunLen >= V22BIS_S1_DETECTOR_RUN_LEN) {
            this._s1BufFill = 0;
            this._onS1Detected('spectral');
            return;
          }
        } else {
          this._s1RunLen = 0;
        }
        this._s1BufFill = 0;
      }
    }
  }

  /**
   * Goertzel evaluated over the full _s1Buf (length = _s1WinSize).
   * The buffer is filled linearly (not circular) so iteration is from
   * index 0 to _s1WinSize - 1.
   */
  _goertzelOnS1Buf(freq) {
    const k = 2 * Math.PI * freq / SR;
    const c = 2 * Math.cos(k);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < this._s1WinSize; i++) {
      const nw = this._s1Buf[i] + c * s1 - s2;
      s2 = s1; s1 = nw;
    }
    return Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / this._s1WinSize;
  }

  write(data) { this.modulator.write(data); }

  generateAudio(n) {
    this._advanceHandshake(n);
    // INITIAL_TIMED_SILENCE: emit zero output (no carrier, no guard
    // tone). Spec §6.3.1.1.2(a) "no signal".
    if (this._phase === HS_PHASE.INITIAL_TIMED_SILENCE) {
      // Drain the modulator's internal symbol clock by generating
      // and discarding — keeps phase/baud accumulators consistent
      // with elapsed time so the post-silence carrier comes up at
      // a deterministic phase. Multiply output by zero.
      const out = this.modulator.generate(n);
      out.fill(0);
      return out;
    }
    return this.modulator.generate(n);
  }

  receiveAudio(samples) {
    // Feed demodulator first so symbolMag updates before detection.
    this.demodulator.process(samples);
    this._trackRxDetection(samples);
    this._runS1Detector(samples);
  }

  reset() {
    this.modulator.reset();
    this.demodulator.reset();
    this._phase              = HS_PHASE.INIT;
    this._phaseSamples       = 0;
    this._totalSamples       = 0;
    this._remoteMagAboveSamp = 0;
    this._remoteDetected     = false;
    this._emittedListening   = false;
    this._negotiatedBps      = 1200;
    this._carrierEnergy      = 0;
    this._ghostEnergy        = 0;
    // S1 detector
    this._s1Buf.fill(0);
    this._s1BufFill          = 0;
    this._s1RunLen           = 0;
    this._s1Detected         = false;
  }

  get name()           { return 'V22bis'; }
  get bps()            { return this._negotiatedBps; }
  get phase()          { return this._phase; }
  get ready()          { return this._phase === HS_PHASE.DATA; }
  get remoteDetected() { return this._remoteDetected; }
  get rxEnergy()       { return this.demodulator.symbolMag; }
}

module.exports = {
  V22, V22bis,
  QAMModulator, QAMDemodulator,
  V22Scrambler,
  HS_PHASE, HS_DURATION,
  // Useful constants and helpers for tests and other modules:
  CARRIER_LOW, CARRIER_HIGH, BAUD, SPS, PEAK_TARGET, GUARD_FREQ,
  PHASE_CHANGE, QUADRANT_POINT,
  rrcImpulse, buildRrcTaps, RRC,
  mapSymbol,
};
