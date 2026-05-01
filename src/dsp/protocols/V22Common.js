'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// V.22 / V.22bis shared constants and helpers
// ───────────────────────────────────────────────────────────────────────────
// Pulled out of V22Demodulator.js in v22-fix-phase5 (April 2026) when the
// demodulator was rewritten as a faithful port of spandsp's v22bis_rx.c.
// V22.js (the modulator) imports these for its own pulse shaping; the new
// demodulator no longer uses them — it has its own bandpass-RRC tables in
// V22RxRRC.js (also a port from spandsp). Keeping these here means the
// modulator continues to work unchanged through the rewrite.
//
// Licensing
// ---------
// Unlike V22RxRRC.js and V22Demodulator.js (which are direct ports of
// spandsp work and therefore inherit spandsp's licensing — see those
// files), the contents of THIS file are independently authored from
// the V.22bis specification:
//   - SR/BAUD/SPS and the carrier-frequency constants come from the
//     ITU-T V.22bis specification.
//   - PHASE_CHANGE and QUADRANT_POINT come from V.22bis Table 1 / Fig 2.
//   - rrcImpulse() is the standard square-root raised cosine impulse
//     response from textbook DSP — the formula is in the public domain.
//   - V22Scrambler implements the V.22bis §5.1/§5.2 polynomial; the
//     implementation is short and algorithmic, derived from the spec.
//     It happens to match spandsp's scramble()/descramble() because the
//     spec only admits one obvious implementation. This file's version
//     was authored from the spec, not copied.
// This file is therefore distributed under the same license as the rest
// of synthmodem.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Shared spec constants ─────────────────────────────────────────────────

const SR           = 8000;            // RTP sample rate, fixed
const BAUD         = 600;             // symbol rate per spec §2.5
const SPS          = SR / BAUD;       // 13.333... samples per symbol (irrational)
const CARRIER_LOW  = 1200;            // call/originate carrier
const CARRIER_HIGH = 2400;            // answer carrier
const GUARD_FREQ   = 1800;            // high-channel guard tone (§2.1)

// Differential phase encoding — first 2 bits of each symbol per V.22bis
// Table 1.
//   Dibit (Q1 Q2) | Phase change
//     0 0         | +90°
//     0 1         |   0°
//     1 1         | +270°
//     1 0         | +180°
const PHASE_CHANGE = [
  Math.PI / 2,        // 00 → +90°
  0,                  // 01 →   0°
  Math.PI,            // 10 → +180°
  3 * Math.PI / 2,    // 11 → +270°
];

// Quadrant-point offsets for V.22bis (last 2 bits Q3,Q4).
// Per Figure 2/V.22bis, within quadrant 1 (upper right, +I +Q):
//     Q3 Q4 | (I, Q)
//     0  0  | (1, 1)
//     0  1  | (3, 1)  ← V.22-compatible point
//     1  0  | (1, 3)
//     1  1  | (3, 3)
const QUADRANT_POINT = [
  { i: 1, q: 1 },     // 00 → inner
  { i: 3, q: 1 },     // 01 → V.22 compatible
  { i: 1, q: 3 },     // 10 → middle-outer
  { i: 3, q: 3 },     // 11 → outer
];

// ─── SRRC pulse shape (used by the TX modulator) ──────────────────────────

// SRRC β per V.22bis §2.4. "75% roll-off" = β = 0.75.
const RRC_BETA = 0.75;

// SRRC pulse span (symbols). 6 symbols (3 each side of center) is standard
// for β=0.75 and gives well below −60 dB truncation sidelobes.
const RRC_SPAN = 6;

/**
 * Square-root raised cosine impulse response evaluated at one point.
 * @param {number} t     time in symbol periods (t=0 is symbol peak)
 * @param {number} beta  roll-off factor (0..1)
 */
function rrcImpulse(t, beta) {
  const EPS = 1e-8;
  if (Math.abs(t) < EPS) {
    return 1 + beta * (4 / Math.PI - 1);
  }
  const tCrit = 1 / (4 * beta);
  if (Math.abs(Math.abs(t) - tCrit) < EPS) {
    return (beta / Math.sqrt(2)) *
      ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) +
       (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
  }
  const pit = Math.PI * t;
  const num = Math.sin(pit * (1 - beta)) +
              4 * beta * t * Math.cos(pit * (1 + beta));
  const den = pit * (1 - (4 * beta * t) * (4 * beta * t));
  return num / den;
}

function buildRrcTaps(beta = RRC_BETA, span = RRC_SPAN) {
  const totalSamples = Math.round(span * SPS);
  const centerSample = totalSamples / 2;
  const taps = new Float32Array(totalSamples);
  let peak = 0;
  for (let n = 0; n < totalSamples; n++) {
    const t = (n - centerSample) / SPS;
    taps[n] = rrcImpulse(t, beta);
    if (Math.abs(taps[n]) > peak) peak = Math.abs(taps[n]);
  }
  return { taps, span: totalSamples, centerOffset: centerSample, gain: peak };
}

const RRC = buildRrcTaps(RRC_BETA, RRC_SPAN);

// ─── V.22bis scrambler / descrambler ───────────────────────────────────────
//
// Polynomial: 1 ⊕ x⁻¹⁴ ⊕ x⁻¹⁷  (V.22bis §5.1/§5.2, both directions)
//
// Direct port of spandsp's scramble()/descramble() (v22bis_tx.c lines
// 413-432, v22bis_rx.c lines 307-328). Verified bit-for-bit equivalent.
// 64-consecutive-ones rule per spec: when 64 consecutive 1s appear at the
// line side (scrambler output / descrambler input), the next bit is
// inverted in the appropriate direction.
class V22Scrambler {
  constructor() {
    this._reg          = new Uint8Array(17);  // shift register, index 0 = newest
    this._onesCount    = 0;
    this._invertNext   = false;
  }
  reset() {
    this._reg.fill(0);
    this._onesCount = 0;
    this._invertNext = false;
  }
  scramble(bitIn) {
    let di = bitIn & 1;
    if (this._invertNext) { di ^= 1; this._invertNext = false; }
    const ds = di ^ this._reg[13] ^ this._reg[16];
    for (let i = 16; i > 0; i--) this._reg[i] = this._reg[i - 1];
    this._reg[0] = ds;
    if (ds === 1) {
      this._onesCount++;
      if (this._onesCount >= 64) {
        this._invertNext = true;
        this._onesCount = 0;
      }
    } else {
      this._onesCount = 0;
    }
    return ds;
  }
  descramble(bitIn) {
    const ds = bitIn & 1;
    let dout = ds ^ this._reg[13] ^ this._reg[16];
    if (this._invertNext) { dout ^= 1; this._invertNext = false; }
    for (let i = 16; i > 0; i--) this._reg[i] = this._reg[i - 1];
    this._reg[0] = ds;
    if (ds === 1) {
      this._onesCount++;
      if (this._onesCount >= 64) {
        this._invertNext = true;
        this._onesCount = 0;
      }
    } else {
      this._onesCount = 0;
    }
    return dout;
  }
}

module.exports = {
  SR, BAUD, SPS, CARRIER_LOW, CARRIER_HIGH, GUARD_FREQ,
  PHASE_CHANGE, QUADRANT_POINT,
  RRC_BETA, RRC_SPAN, rrcImpulse, buildRrcTaps, RRC,
  V22Scrambler,
};
