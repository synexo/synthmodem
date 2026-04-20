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

/**
 * Automatic Gain Control for modem RX audio.
 *
 * QAM signals have non-constant envelope — outer 16-QAM constellation
 * points are 3× the inner-points' amplitude, which is information, not
 * channel fade. A naive per-sample AGC that tracks |x| would "correct"
 * this amplitude structure and destroy the slicer's ability to decode.
 *
 * This AGC measures block RMS over ~120ms (960 samples @ 8kHz, ~72 symbols
 * at V.22bis 600 baud) — much longer than any one symbol — and updates
 * gain by ~1% per block. That tracks real channel-level drift without
 * disturbing symbol-to-symbol amplitude information.
 *
 * agcTargetLevel should match the natural RMS of your expected signal.
 * For loopback (local-generated G.711) this is about 0.28 for the default
 * AMP=0.4 QAM TX level (theoretical: AMP × √0.5 = 0.283). If the target
 * matches the input RMS, AGC converges to gain=1 and is effectively a
 * pass-through — useful behaviour in loopback while still being able to
 * correct real-channel level drift when enabled.
 *
 * Disabled by default in config.modem.agcEnabled; ModemDSP skips calling
 * AGC.process() entirely when it's disabled.
 */
class AGC {
  constructor(cfg) {
    this._target    = cfg.agcTargetLevel;
    this._gain      = 1.0;
    this._sqSum     = 0;
    this._count     = 0;
    this._blockSize = 960;   // ~120ms @ 8kHz
    this._stepSize  = 0.01;  // 1% gain adjustment per block
  }

  process(samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const y = samples[i] * this._gain;
      out[i] = y < -1 ? -1 : (y > 1 ? 1 : y);
      // Measure RMS of INPUT to estimate natural channel level
      this._sqSum += samples[i] * samples[i];
      if (++this._count >= this._blockSize) {
        const rms = Math.sqrt(this._sqSum / this._count);
        if (rms > 1e-5) {
          const desired = this._target / rms;
          // Geometric step toward target gain
          this._gain *= 1 + (desired / this._gain - 1) * this._stepSize;
          this._gain = Math.max(0.1, Math.min(10, this._gain));
        }
        this._sqSum = 0;
        this._count = 0;
      }
    }
    return out;
  }

  get gain() { return this._gain; }
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
 * Generate ITU-T V.8 ANSam (modified answer tone).
 *
 * Spec (ITU-T V.8 §3.1, §3.2):
 *
 *   ANSam = 2100 Hz carrier, amplitude-modulated by a 15 Hz sinewave.
 *   Envelope ranges between (0.8 ± 0.01) and (1.2 ± 0.01) times the
 *   average amplitude — that is, envelope(t) = avg * (1 + 0.2 * sin(2π·15·t)).
 *
 *   Phase reversals: when network echo canceller disabling is required,
 *   the 2100 Hz carrier shall be 180° phase-reversed every `reversalIntervalMs`
 *   (typically 450 ms). The AM envelope is NOT phase-reversed — it runs
 *   continuously across the carrier reversals.
 *
 *   Total duration per §8: 5 ± 1 s if not terminated by CM detection.
 *
 *   Power: per V.2, around -12 to -13 dBm at modem output. In our
 *   normalized float signal that's about 0.15 peak (envelope max) when
 *   later encoded to PCMU. A previous version used 0.45 peak which is
 *   15+ dB too hot and causes codec distortion on the AM peaks.
 *
 * A previous implementation of this function produced only a 2100 Hz
 * carrier with sign flips at reversalIntervalMs — no 15 Hz AM at all,
 * which real modems recognise as legacy V.25 ANS, not ANSam. That is
 * why V.8 negotiation was not happening.
 *
 * @param {number} durationMs
 * @param {number} sampleRate
 * @param {number} reversalIntervalMs  carrier phase-reversal interval (e.g. 450)
 * @param {number} amplitude           peak amplitude of the modulated envelope
 *                                     (default 0.15; the average amplitude is
 *                                     amplitude/1.2 so envelope peaks reach `amplitude`)
 * @returns {Float32Array}
 */
function generateANSam(durationMs, sampleRate, reversalIntervalMs, amplitude = 0.15) {
  const n = Math.round(durationMs * sampleRate / 1000);
  const out = new Float32Array(n);
  const carrierInc = TWO_PI * 2100 / sampleRate;
  const amInc      = TWO_PI *   15 / sampleRate;
  // Envelope peaks at 1.2 × avg, so avg = amplitude / 1.2.
  const avgAmp = amplitude / 1.2;

  let carrierPhase = 0;
  let amPhase      = 0;
  const samplesPerReversal = Math.round(reversalIntervalMs * sampleRate / 1000);
  let samplesUntilReversal = samplesPerReversal;

  for (let i = 0; i < n; i++) {
    // 15 Hz AM envelope — continuous across the whole tone.
    const env = avgAmp * (1 + 0.2 * Math.sin(amPhase));
    // 2100 Hz carrier — phase jumps by π every reversalIntervalMs.
    out[i] = env * Math.cos(carrierPhase);

    carrierPhase = (carrierPhase + carrierInc) % TWO_PI;
    amPhase      = (amPhase + amInc) % TWO_PI;

    if (--samplesUntilReversal <= 0) {
      carrierPhase = (carrierPhase + Math.PI) % TWO_PI;
      samplesUntilReversal = samplesPerReversal;
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
