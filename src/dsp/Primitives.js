'use strict';

/**
 * DSP Primitives
 *
 * Low-level signal processing building blocks used by all modem protocols.
 * Everything operates on Float32Array at 8000 Hz.
 */

const TWO_PI = Math.PI * 2;

// ─── Numerically Controlled Oscillator (NCO) ──────────────────────────────────

/**
 * Generates a continuous sinusoid.  Phase accumulates across calls.
 */
class NCO {
  constructor(sampleRate) {
    this._sr    = sampleRate;
    this._phase = 0;
    this._freq  = 0;
    this._phaseInc = 0;
  }

  setFrequency(hz) {
    this._freq     = hz;
    this._phaseInc = TWO_PI * hz / this._sr;
  }

  /** Advance by one sample, return [cos, sin] */
  tick() {
    const c = Math.cos(this._phase);
    const s = Math.sin(this._phase);
    this._phase = (this._phase + this._phaseInc) % TWO_PI;
    return [c, s];
  }

  /** Generate n samples of cosine into out[], starting at offset */
  fill(out, n, offset = 0) {
    for (let i = 0; i < n; i++) {
      out[offset + i] = Math.cos(this._phase);
      this._phase = (this._phase + this._phaseInc) % TWO_PI;
    }
  }

  /** Adjust phase by delta radians (used by Costas loop) */
  adjustPhase(delta) {
    this._phase = (this._phase + delta) % TWO_PI;
  }

  setPhase(p) { this._phase = p % TWO_PI; }
  get phase()  { return this._phase; }
  get freq()   { return this._freq; }
}

// ─── Simple IIR low-pass filter (biquad) ────────────────────────────────────

/**
 * Single-pole IIR low-pass  y[n] = alpha*x[n] + (1-alpha)*y[n-1]
 * Faster than a full biquad for envelope detection.
 */
class SinglePoleLPF {
  constructor(alpha) {
    this._alpha = alpha;
    this._y = 0;
  }

  process(x) {
    this._y += this._alpha * (x - this._y);
    return this._y;
  }

  reset() { this._y = 0; }
  get value() { return this._y; }
}

/**
 * Biquad filter — direct form II.
 * Use makeLP / makeBP / makeHP factory methods.
 */
class BiquadFilter {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
    this.w1 = 0; this.w2 = 0;
  }

  process(x) {
    const w = x - this.a1 * this.w1 - this.a2 * this.w2;
    const y = this.b0 * w + this.b1 * this.w1 + this.b2 * this.w2;
    this.w2 = this.w1;
    this.w1 = w;
    return y;
  }

  processBlock(input, output, n) {
    for (let i = 0; i < n; i++) output[i] = this.process(input[i]);
  }

  reset() { this.w1 = 0; this.w2 = 0; }

  static makeLowPass(fc, Q, sr) {
    const omega = TWO_PI * fc / sr;
    const sn = Math.sin(omega), cs = Math.cos(omega);
    const alpha = sn / (2 * Q);
    const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = b0;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new BiquadFilter(b0/a0, b1/a0, b2/a0, a1/a0, a2/a0);
  }

  static makeBandPass(fc, Q, sr) {
    const omega = TWO_PI * fc / sr;
    const sn = Math.sin(omega), cs = Math.cos(omega);
    const alpha = sn / (2 * Q);
    const b0 = alpha, b1 = 0, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new BiquadFilter(b0/a0, b1/a0, b2/a0, a1/a0, a2/a0);
  }

  static makeHighPass(fc, Q, sr) {
    const omega = TWO_PI * fc / sr;
    const sn = Math.sin(omega), cs = Math.cos(omega);
    const alpha = sn / (2 * Q);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = b0;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new BiquadFilter(b0/a0, b1/a0, b2/a0, a1/a0, a2/a0);
  }
}

// ─── AGC (Automatic Gain Control) ─────────────────────────────────────────────

class AGC {
  constructor(cfg) {
    this._target  = cfg.agcTargetLevel;
    this._attack  = cfg.agcAttackAlpha;
    this._decay   = cfg.agcDecayAlpha;
    this._gain    = 1.0;
    this._rmsEst  = 0.0;
  }

  process(samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const x    = samples[i] * this._gain;
      const xabs = Math.abs(x);
      const alpha = xabs > this._rmsEst ? this._attack : this._decay;
      this._rmsEst += alpha * (xabs - this._rmsEst);
      if (this._rmsEst > 1e-6) {
        const err = this._target - this._rmsEst;
        this._gain *= (1 + 0.1 * err);
        this._gain = Math.max(0.01, Math.min(100, this._gain));
      }
      out[i] = Math.max(-1, Math.min(1, x));
    }
    return out;
  }
}

// ─── Costas Loop (carrier phase/frequency recovery) ──────────────────────────

/**
 * Costas loop for BPSK / QPSK / QAM carrier recovery.
 *
 * Drives a VCO to track the incoming carrier.
 * Outputs I/Q baseband samples.
 */
class CostasLoop {
  constructor(nominalFreq, sampleRate, loopBw = 0.01) {
    this._sr       = sampleRate;
    this._nco      = new NCO(sampleRate);
    this._nco.setFrequency(nominalFreq);
    this._lpI      = new SinglePoleLPF(0.1);
    this._lpQ      = new SinglePoleLPF(0.1);
    // Loop filter coefficients
    this._alpha    = loopBw;
    this._beta     = loopBw * loopBw / 4;
    this._freqAdj  = 0;
  }

  /**
   * Process one sample.
   * @returns {{ i: number, q: number }}
   */
  process(x) {
    const [ci, cq] = this._nco.tick();
    const i =  x * ci;
    const q = -x * cq;
    const iLp = this._lpI.process(i);
    const qLp = this._lpQ.process(q);

    // Phase error estimator (decision-directed for BPSK: sign(I)*Q - sign(Q)*I)
    const err = (iLp > 0 ? 1 : -1) * qLp - (qLp > 0 ? 1 : -1) * iLp;
    this._freqAdj += this._beta * err;
    this._nco.adjustPhase(this._alpha * err);
    this._nco.setFrequency(this._nco.freq + this._freqAdj);

    return { i: iLp, q: qLp };
  }

  reset(freq) {
    if (freq !== undefined) this._nco.setFrequency(freq);
    this._lpI.reset();
    this._lpQ.reset();
    this._freqAdj = 0;
  }
}

// ─── Gardner Timing Recovery ──────────────────────────────────────────────────

/**
 * Gardner timing error detector.
 * Tracks symbol timing using the Gardner algorithm.
 *
 * samplesPerSymbol: nominal samples per symbol (can be fractional)
 * Outputs decision samples at the correct symbol phase.
 */
class GardnerTiming {
  constructor(samplesPerSymbol, loopGain = 0.01) {
    this._sps      = samplesPerSymbol;
    this._loopGain = loopGain;
    this._mu       = 0;          // fractional timing offset [0, 1)
    this._strobe   = 0;          // counter
    this._prev     = 0;          // previous sample (for midpoint)
    this._mid      = 0;          // midpoint sample
    this._symbols  = [];         // output queue
  }

  /**
   * Push samples in, get symbols out.
   * @param {number[]} samples
   * @returns {number[]} symbol decisions
   */
  process(samples) {
    const out = [];
    for (const x of samples) {
      this._strobe += 1;
      const frac = this._strobe - Math.floor(this._strobe);

      // Linear interpolation
      const interp = this._prev + frac * (x - this._prev);

      if (Math.floor(this._strobe) >= Math.round(this._sps / 2) &&
          this._strobe < this._sps) {
        this._mid = interp;
      }

      if (this._strobe >= this._sps) {
        // Symbol strobe
        const sym = interp;
        // Gardner error = (prev_sym - sym) * mid_sample
        const err = (this._prev - sym) * this._mid;
        this._mu -= this._loopGain * err;
        this._mu  = Math.max(-0.5, Math.min(0.5, this._mu));
        this._sps = this._sps + this._mu;

        this._strobe -= Math.round(this._sps);
        out.push(sym);
      }
      this._prev = x;
    }
    return out;
  }

  reset() {
    this._mu = 0; this._strobe = 0; this._prev = 0; this._mid = 0;
  }
}

// ─── LMS Adaptive Equalizer ───────────────────────────────────────────────────

/**
 * Decision-feedback equalizer using LMS algorithm.
 * Linear equalizer (no decision feedback) when dfTaps = 0.
 */
class LMSEqualizer {
  constructor(forwardTaps, stepSize, dfTaps = 0) {
    this._n     = forwardTaps;
    this._dfTaps = dfTaps;
    this._mu    = stepSize;
    this._wFwd  = new Float64Array(forwardTaps);  // forward filter weights
    this._wFb   = new Float64Array(dfTaps);        // feedback weights
    this._bufFwd = new Float64Array(forwardTaps);
    this._bufFb  = new Float64Array(dfTaps);
    // Centre tap initialised to 1 (identity response)
    this._wFwd[Math.floor(forwardTaps / 2)] = 1.0;
  }

  process(x, decision) {
    // Shift delay line
    for (let i = this._n - 1; i > 0; i--) this._bufFwd[i] = this._bufFwd[i - 1];
    this._bufFwd[0] = x;

    // Forward filter output
    let y = 0;
    for (let i = 0; i < this._n; i++) y += this._wFwd[i] * this._bufFwd[i];

    // Feedback (decision-directed)
    for (let i = 0; i < this._dfTaps; i++) y -= this._wFb[i] * this._bufFb[i];

    // Error (using provided decision, or sign for BPSK training)
    const d   = decision !== undefined ? decision : Math.sign(y);
    const err = d - y;

    // LMS weight update
    for (let i = 0; i < this._n; i++) {
      this._wFwd[i] += this._mu * err * this._bufFwd[i];
    }

    // Feedback update
    if (this._dfTaps > 0) {
      for (let i = this._dfTaps - 1; i > 0; i--) this._bufFb[i] = this._bufFb[i - 1];
      this._bufFb[0] = d;
      for (let i = 0; i < this._dfTaps; i++) {
        this._wFb[i] += this._mu * err * this._bufFb[i];
      }
    }

    return y;
  }

  reset() {
    this._wFwd.fill(0);
    this._wFb.fill(0);
    this._wFwd[Math.floor(this._n / 2)] = 1.0;
    this._bufFwd.fill(0);
    this._bufFb.fill(0);
  }
}

// ─── V.34 Self-synchronising Scrambler / Descrambler ─────────────────────────

/**
 * Self-synchronising scrambler: out = in XOR (shift register taps)
 * Polynomial: 1 + x^-18 + x^-23  (configurable)
 */
class Scrambler {
  constructor(poly = [18, 23]) {
    this._poly = [...poly]; // defensive copy — never mutate the caller's array
    this._maxTap = Math.max(...poly);
    this._reg = new Uint8Array(this._maxTap + 1);
  }

  scramble(bit) {
    let fb = bit;
    for (const t of this._poly) fb ^= this._reg[t - 1];
    // Shift
    for (let i = this._maxTap - 1; i > 0; i--) this._reg[i] = this._reg[i - 1];
    this._reg[0] = fb;
    return fb;
  }

  // Descrambler: in XOR taps (self-sync — uses incoming bits for feedback)
  descramble(bit) {
    let out = bit;
    for (const t of this._poly) out ^= this._reg[t - 1];
    for (let i = this._maxTap - 1; i > 0; i--) this._reg[i] = this._reg[i - 1];
    this._reg[0] = bit;
    return out;
  }

  reset() { this._reg.fill(0); }
}

// ─── RMS energy ───────────────────────────────────────────────────────────────

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ─── Generate a pure tone burst ───────────────────────────────────────────────

function generateTone(freq, durationMs, sampleRate, amplitude = 0.5) {
  const n = Math.round(durationMs * sampleRate / 1000);
  const out = new Float32Array(n);
  const phaseInc = TWO_PI * freq / sampleRate;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.cos(phase);
    phase = (phase + phaseInc) % TWO_PI;
  }
  return out;
}

/**
 * Generate a tone with optional phase reversals (for ANSam).
 */
function generateANSam(durationMs, sampleRate, reversalIntervalMs, amplitude = 0.5) {
  const freq = 2100;
  const n = Math.round(durationMs * sampleRate / 1000);
  const reversalSamples = Math.round(reversalIntervalMs * sampleRate / 1000);
  const out = new Float32Array(n);
  const phaseInc = TWO_PI * freq / sampleRate;
  let phase = 0;
  let sign = 1;
  let reversalCounter = 0;
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * sign * Math.cos(phase);
    phase = (phase + phaseInc) % TWO_PI;
    if (++reversalCounter >= reversalSamples) {
      sign = -sign;
      reversalCounter = 0;
    }
  }
  return out;
}

/**
 * Detect presence of a tone in samples using Goertzel algorithm.
 * Returns power at that frequency.
 */
function goertzel(samples, freq, sampleRate) {
  const k = Math.round(samples.length * freq / sampleRate);
  const omega = TWO_PI * k / samples.length;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

/**
 * Mix two Float32Arrays together.
 */
function mix(a, b, gainA = 1.0, gainB = 1.0) {
  const len = Math.max(a.length, b.length);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (i < a.length ? a[i] * gainA : 0) +
             (i < b.length ? b[i] * gainB : 0);
  }
  return out;
}

/**
 * Apply a simple raised-cosine window to reduce spectral leakage.
 */
function applyWindow(samples) {
  const n = samples.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos(TWO_PI * i / (n - 1)));
    out[i] = samples[i] * w;
  }
  return out;
}

module.exports = {
  NCO,
  SinglePoleLPF,
  BiquadFilter,
  AGC,
  CostasLoop,
  GardnerTiming,
  LMSEqualizer,
  Scrambler,
  rms,
  generateTone,
  generateANSam,
  goertzel,
  mix,
  applyWindow,
  TWO_PI,
};
