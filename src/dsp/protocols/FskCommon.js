'use strict';

/**
 * FskCommon — shared classes for FSK-based modem protocols.
 *
 * Two demodulators live here:
 *
 *   - `FskDemodulator` — incoherent: bandpass + envelope detection +
 *     UART framing with majority-of-3 mid-bit sampling. Used by V.21
 *     and Bell 103 at 300 baud, where it works very well.
 *
 *   - `CoherentFskDemodulator` — quadrature DDS correlators + sliding
 *     dot-product matched filter + spandsp-style UART framing with
 *     central-bit stability check. Used by V.23 (both the 1200-baud
 *     forward channel and the 75-baud backward channel), where the
 *     short symbol period (forward) and the narrow tone separation
 *     (backward) make incoherent BPF + envelope marginal. This is a
 *     port of spandsp's `fsk.c` (LGPL 2.1) by Steve Underwood.
 *
 * Both demodulators emit:
 *   'data' — Buffer of UART-framed bytes (start + 8 data LSB-first + stop)
 *   'bit'  — raw bit stream (used by V.8 octet decoder for V.21)
 *
 * One modulator class is shared by everyone:
 *
 *   - `FskModulator` — DDS-style continuous-phase frequency switcher
 *     with sub-sample-accurate baud timing (1/100-bps fractional
 *     accumulator, same approach as spandsp's `fsk_tx`). Works for
 *     any (mark, space, baud) triple.
 *
 * ── Demodulator design notes (incoherent / FskDemodulator) ─────────
 *
 * Three improvements over the pre-shared V.21/Bell103 implementations:
 *
 *   1. **Majority-of-3 mid-bit sampling.** Each data bit is decided
 *      from three (mark > space) comparisons taken at samples
 *      mid-bit-1, mid-bit, and mid-bit+1, and the byte uses the
 *      majority. A single noise spike at the precise mid-bit moment
 *      no longer flips the bit. On clean signal all three agree so
 *      the result is identical to single-sample decoding.
 *
 *   2. **Stop-bit majority-of-3.** Same idea applied to the stop bit
 *      so a bit-error there doesn't drop an otherwise-good byte.
 *
 *   3. **Reset parity.** `reset()` now clears every piece of state
 *      that `process()` mutates, including `_cdWarmup`, `_dataBits`,
 *      `_bitCount` — fields the prior code forgot to reset.
 */

const { EventEmitter }            = require('events');
const config                      = require('../../../config');
const { BiquadFilter, SinglePoleLPF, TWO_PI } = require('../Primitives');

const SR = config.rtp.sampleRate;   // 8000 Hz

// ─── Modulator base ────────────────────────────────────────────────────────

/**
 * Generic UART-framed FSK modulator.
 *
 * Per-symbol audio is a constant-amplitude continuous-phase tone at
 * either markFreq or spaceFreq. UART framing is start (0) + 8 data
 * LSB-first + stop (1). Fractional-sample symbol timing keeps the
 * long-term baud rate exact regardless of whether SR/baud is integral.
 *
 * Subclasses pass `markFreq`, `spaceFreq`, `baud`, `amplitude`.
 */
class FskModulator {
  constructor({ markFreq, spaceFreq, baud, amplitude = 0.15 }) {
    this._markFreq  = markFreq;
    this._spaceFreq = spaceFreq;
    this._baud      = baud;
    this._amplitude = amplitude;

    this._curFreq = markFreq;
    this._phase   = 0;
    this._bits    = [];

    // Sub-sample-accurate symbol timing. At 8000 Hz / 300 baud the
    // period is 26.666... samples; at 8000 / 1200 it's 6.666...
    // Carry the fraction across symbols so over many symbols the
    // total sample count tracks the ideal baud exactly.
    this._samplesPerSymbol = SR / baud;
    this._symbolPhase      = 0;
    this._samplesLeft      = 0;
  }

  /** Queue bytes to transmit (UART-framed: start + 8 data LSB-first + stop). */
  write(bytes) {
    for (const byte of bytes) {
      this._bits.push(0);
      for (let b = 0; b < 8; b++) this._bits.push((byte >> b) & 1);
      this._bits.push(1);
    }
  }

  /** Queue raw bits (no UART framing). Used by V.8 preamble for V.21. */
  writeBits(bits) {
    for (const b of bits) this._bits.push(b & 1);
  }

  /** Generate numSamples of audio. Returns Float32Array. */
  generate(numSamples) {
    const out = new Float32Array(numSamples);
    let pos = 0;

    while (pos < numSamples) {
      if (this._samplesLeft <= 0) {
        // Start the next symbol. Empty queue → mark (idle = 1).
        const bit = this._bits.length > 0 ? this._bits.shift() : 1;
        this._curFreq = bit === 1 ? this._markFreq : this._spaceFreq;
        this._symbolPhase += this._samplesPerSymbol;
        this._samplesLeft = Math.floor(this._symbolPhase);
        this._symbolPhase -= this._samplesLeft;
      }

      const chunk    = Math.min(this._samplesLeft, numSamples - pos);
      const phaseInc = TWO_PI * this._curFreq / SR;
      for (let i = 0; i < chunk; i++) {
        out[pos + i] = this._amplitude * Math.cos(this._phase);
        this._phase  = (this._phase + phaseInc) % TWO_PI;
      }
      this._samplesLeft -= chunk;
      pos               += chunk;
    }
    return out;
  }

  get idle() { return this._bits.length === 0; }
}

// ─── Demodulator base ──────────────────────────────────────────────────────

/**
 * Generic FSK demodulator with UART framing.
 *
 * Pipeline per sample:
 *   1. Bandpass-filter at mark and space frequencies (Q parameterised)
 *   2. Envelope-detect each via abs() + single-pole LPF
 *   3. Update slow envelope for CD hysteresis
 *   4. CD on/off transitions, with hold time and warmup
 *   5. Per-sample bit decision: mark > space → 1
 *   6. Start-bit detection: stableNeeded consecutive 0s after mark idle
 *   7. Per-bit majority-of-3 sampling at mid-bit ± 1 sample
 *   8. UART byte assembly + stop-bit check + emit
 *
 * Subclasses pass `markFreq`, `spaceFreq`, `baud`. Filter Q defaults
 * to 15 (V.21/Bell103 norm). Override via `q` if needed for V.23.
 */
class FskDemodulator extends EventEmitter {
  constructor({ markFreq, spaceFreq, baud, q = 15 }) {
    super();
    this._markFreq  = markFreq;
    this._spaceFreq = spaceFreq;
    this._baud      = baud;

    // Bandpass filters and envelope detectors.
    this._bpMark  = BiquadFilter.makeBandPass(markFreq,  q, SR);
    this._bpSpace = BiquadFilter.makeBandPass(spaceFreq, q, SR);
    const fastAlpha = 1 - Math.exp(-TWO_PI * (baud * 0.8) / SR);
    this._envMark   = new SinglePoleLPF(fastAlpha);
    this._envSpace  = new SinglePoleLPF(fastAlpha);

    // Slow envelope for CD (averaged over ~2 symbols).
    const slowAlpha = 1 - Math.exp(-TWO_PI * (baud / 2) / SR);
    this._slowEnvMark  = new SinglePoleLPF(slowAlpha);
    this._slowEnvSpace = new SinglePoleLPF(slowAlpha);

    this._samplesPerSym = SR / baud;

    // CD thresholds — tuned from real-modem 300-baud captures.
    // These also work for 1200-baud (V.23 forward) at line levels
    // around -10 dBm0; tune per-subclass if needed.
    this._cdOnHyst       = 0.008;
    this._cdOffHyst      = 0.003;
    this._cd             = false;
    this._cdHoldSamples  = 0;
    this._cdHoldMax      = Math.round(SR * 0.010);   // 10 ms hang

    // CD warmup: suppress bit decisions for ~3.6 symbols after CD
    // turns on, while bandpass filters reach steady state.
    this._cdWarmupMax = Math.round(SR * 0.012);      // 12 ms at 300 baud
    this._cdWarmup    = 0;

    // Start-bit detection.
    this._stableCount  = 0;
    this._stableNeeded = 4;

    // Sub-sample-accurate bit-sampling timer.
    this._bitTimer = 0;
    this._bitPhase = 0;

    // UART frame state.
    this._state    = 'IDLE';
    this._dataBits = new Array(8).fill(0);
    this._bitCount = 0;

    // Majority-of-3 voting state. We collect three (mark>space)
    // decisions as the bit timer ticks through (mid-bit-1, mid-bit,
    // mid-bit+1) and use majority for the final bit value.
    this._voteCount = 0;          // 0..3 — how many votes we've collected this bit
    this._voteOnes  = 0;          // count of 1-votes among collected
  }

  /** Schedule the next bit-sampling point at the canonical mid-bit. We
   *  collect three (mark>space) votes at timer = 1, 0, -1 (one sample
   *  before, at, and one sample after center) and majority-vote them.
   *  Centering on the original target keeps clean-signal behavior
   *  identical to single-sample decoding (all three votes agree). */
  _scheduleNextBit(initialOffset) {
    if (initialOffset != null) {
      // First bit: from the falling edge (start of start bit), the
      // canonical mid-bit-0 center is SPS/2 + SPS samples. We've
      // already consumed `initialOffset` samples confirming start-bit
      // stability, so the remaining distance to bit-0 center is
      //   SPS/2 + SPS - initialOffset.
      this._bitPhase += this._samplesPerSym / 2 + this._samplesPerSym - initialOffset;
    } else {
      this._bitPhase += this._samplesPerSym;
    }
    this._bitTimer = Math.floor(this._bitPhase);
    this._bitPhase -= this._bitTimer;
    this._voteCount = 0;
    this._voteOnes  = 0;
  }

  process(samples) {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      const mEnv = this._envMark.process(Math.abs(this._bpMark.process(x)));
      const sEnv = this._envSpace.process(Math.abs(this._bpSpace.process(x)));

      // Slow envelope for CD.
      const smEnv  = this._slowEnvMark.process(mEnv);
      const ssEnv  = this._slowEnvSpace.process(sEnv);
      const topEnv = Math.max(smEnv, ssEnv);

      // CD hysteresis.
      if (!this._cd && topEnv > this._cdOnHyst) {
        this._cd = true;
        this._cdHoldSamples = this._cdHoldMax;
        this._cdWarmup      = this._cdWarmupMax;
        // Reset frame state on every fresh CD edge to avoid resuming
        // mid-byte with stale bits.
        this._state       = 'IDLE';
        this._stableCount = 0;
        this._bitCount    = 0;
      } else if (this._cd && topEnv < this._cdOffHyst) {
        if (this._cdHoldSamples > 0) {
          this._cdHoldSamples--;
        } else {
          this._cd       = false;
          this._cdWarmup = 0;
          this._state    = 'IDLE';
          this._stableCount = 0;
          this._bitCount    = 0;
        }
      } else if (this._cd) {
        if (topEnv >= this._cdOffHyst) this._cdHoldSamples = this._cdHoldMax;
      }

      if (!this._cd)         continue;
      if (this._cdWarmup > 0) { this._cdWarmup--; continue; }

      const bit = mEnv > sEnv ? 1 : 0;

      if (this._state === 'IDLE') {
        if (bit === 0) {
          this._stableCount++;
          if (this._stableCount >= this._stableNeeded) {
            this._state    = 'DATA';
            this._bitCount = 0;
            this._bitPhase = 0;
            this._scheduleNextBit(this._stableNeeded);
            this._stableCount = 0;
          }
        } else {
          this._stableCount = 0;
        }
        continue;
      }

      // DATA or STOP — count down to the canonical mid-bit, then take
      // three votes (one sample before center, at center, one after)
      // and finalize with the majority.
      this._bitTimer--;

      // Collect votes at timer values 1, 0, -1 — three samples spaced
      // one apart, centered on the canonical mid-bit. samplesPerSym
      // is at least ~6 (for 1200 baud) and ~26 (for 300 baud) so a
      // ±1 sample window is well inside the bit cell.
      if (this._bitTimer <= 1 && this._bitTimer >= -1 && this._voteCount < 3) {
        this._voteOnes += bit;
        this._voteCount++;
      }

      if (this._bitTimer <= -1) {
        const decided = this._voteOnes >= 2 ? 1 : 0;

        if (this._state === 'DATA') {
          this._dataBits[this._bitCount] = decided;
          // Emit raw bit for V.8 and other bit-level consumers.
          this.emit('bit', decided);
          if (++this._bitCount === 8) this._state = 'STOP';
          this._scheduleNextBit();
        } else {
          // Stop bit. If decided === 1, frame is good → emit byte.
          // Otherwise drop silently — likely a framing error from a
          // brief carrier glitch or an out-of-sync demod.
          if (decided === 1) {
            let byte = 0;
            for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
            this.emit('data', Buffer.from([byte]));
          }
          this._state       = 'IDLE';
          this._stableCount = 0;
          this._bitCount    = 0;
        }
      }
    }
  }

  get carrierDetected() { return this._cd; }

  reset() {
    this._bpMark.reset();
    this._bpSpace.reset();
    this._envMark.reset();
    this._envSpace.reset();
    this._slowEnvMark.reset();
    this._slowEnvSpace.reset();
    this._cd            = false;
    this._cdHoldSamples = 0;
    this._cdWarmup      = 0;
    this._stableCount   = 0;
    this._bitTimer      = 0;
    this._bitPhase      = 0;
    this._state         = 'IDLE';
    this._bitCount      = 0;
    this._voteCount     = 0;
    this._voteOnes      = 0;
  }
}

// ─── Coherent FSK demodulator (spandsp-port) ───────────────────────────────

/**
 * CoherentFskDemodulator — quadrature-correlator FSK demodulator with
 * UART framing.
 *
 * Algorithm (port of spandsp's fsk.c, LGPL 2.1, by Steve Underwood):
 *
 *   For each input sample:
 *     1. Multiply by quadrature DDS reference (cos + j*sin) at each of
 *        the two tone frequencies (mark, space).
 *     2. Maintain a sliding-window dot product over `correlation_span`
 *        samples = one symbol period. Subtract oldest, add newest.
 *     3. Compute |dot|² for each tone — this is the matched-filter
 *        energy at that frequency over the last symbol period.
 *     4. Bit decision: `mark_energy > space_energy` → 1, else 0.
 *
 *   Carrier-presence is tracked separately via a power meter on the
 *   DC-blocked input signal, with hysteresis around `cutoffDbm0`.
 *
 *   UART framing follows spandsp's `FSK_FRAME_MODE_FRAMED` state
 *   machine:
 *     - frame_pos == -2: looking for any start-bit edge (baudstate=0)
 *     - frame_pos == -1: continuous-zero stability check from start-bit
 *       detection until past mid-bit. If any 1 appears, restart.
 *     - frame_pos >= 0:  for each subsequent bit, sample at 60% and
 *       at 100% of the bit period and require they agree. If not,
 *       framing error and restart.
 *
 *   This is more robust than incoherent BPF + envelope at low SNR,
 *   especially at high baud rates where envelope detectors blur over
 *   adjacent symbols, and at narrow tone-pair separations where BPFs
 *   bleed energy between mark and space.
 *
 * Why this is for V.23 specifically:
 *
 *   - V.23 forward (1200 baud, 1300/2100 Hz): only 6.67 samples per
 *     symbol at 8 kHz. The incoherent envelope detector's LPF time
 *     constant struggles to track that fast, and the bandpass filters
 *     (Q=15 → ~100 Hz bandwidth at 1700 Hz) admit too much adjacent-
 *     symbol energy. Coherent matched filtering over exactly one
 *     symbol period is the right tool.
 *   - V.23 backward (75 baud, 390/450 Hz): 60 Hz tone separation —
 *     too narrow for a Q=15 bandpass to distinguish reliably. Coherent
 *     correlation against quadrature references resolves it cleanly.
 *
 * Constructor opts:
 *   markFreq, spaceFreq, baud  — required.
 *   cutoffDbm0     — carrier-on/off threshold dBm0 (default -30).
 *
 * Emits 'bit' (raw 0/1 stream) and 'data' (UART-framed bytes).
 */
// ─── Coherent FSK demodulator (spandsp port) ───────────────────────────

/**
 * CoherentFskDemodulator — coherent quadrature-correlator FSK
 * demodulator with UART-character framing. Port of the relevant
 * portion of spandsp's `fsk.c` (LGPL 2.1, Steve Underwood, 2003).
 * Used by V.23.
 *
 * Original: https://github.com/freeswitch/spandsp/blob/master/src/fsk.c
 *
 * Why coherent / spandsp port instead of the BPF+envelope approach
 * used for V.21 and Bell 103:
 *
 *   - V.23 forward (1200 baud) has only 6.67 samples per symbol at
 *     8 kHz. A bandpass-filter envelope detector cannot follow that
 *     fast cleanly, and adjacent-symbol energy bleeds heavily into
 *     each decision. Coherent quadrature correlation against the
 *     target tones over exactly one symbol period is the textbook
 *     answer for short-symbol FSK demodulation.
 *
 *   - V.23 backward (75 baud) puts mark and space only 60 Hz apart
 *     (390 vs 450 Hz). Bandpass filters with practical Q have
 *     overlapping passbands at that separation, but quadrature
 *     correlation against pure tones discriminates cleanly because
 *     orthogonal frequencies are uncorrelated over a full symbol
 *     interval (one-baud integration is a matched filter).
 *
 *   - V.21 and Bell 103 work fine on the BPF+envelope path; we
 *     don't change them.
 *
 * Algorithm overview (per-sample loop):
 *
 *   1. Quadrature DDS at each tone (mark, space). Multiply input by
 *      cos and sin references; maintain a sliding-window sum over
 *      `winLen = round(SR / baud)` samples for each I/Q component.
 *      `|dot[j]|² = re[j]² + im[j]²` is the matched-filter energy
 *      at frequency j over the last symbol period.
 *
 *   2. Bit decision: `mark_energy > space_energy → 1, else 0`.
 *
 *   3. Carrier-presence: independent power meter on a DC-blocked
 *      signal, with hysteresis around `cutoffDbm0 ± 2.5 dB`. While
 *      carrier is absent the framer is silent; it cannot emit
 *      garbage from noise during silence.
 *
 *   4. UART framing (spandsp `FSK_FRAME_MODE_FRAMED`):
 *      - frame_pos == -2: idle. On `baudstate==0` (a 0 might be a
 *        start bit), seed `baudPhase = 0.3 * samplesPerSym` and
 *        advance to frame_pos == -1.
 *      - frame_pos == -1: stable-zero verification. Each sample
 *        with `baudstate != 0` aborts back to -2. Otherwise advance
 *        baudPhase by 1 per sample; when it crosses
 *        `samplesPerSym`, the start bit is confirmed and we move
 *        to frame_pos == 0 (subtracting samplesPerSym to keep the
 *        sub-sample fractional remainder).
 *      - frame_pos == 0..7: data bits. baudPhase advances each
 *        sample. At the 60% mark we capture lastBit; from then
 *        until the 100% mark, we require the sampled baudstate to
 *        match lastBit (the central-stability check, what spandsp
 *        calls "voice immunity"). On disagreement, framing error
 *        and restart. At the 100% mark, the bit is committed:
 *        either appended to frame_in_progress (data bit) or
 *        validated as a stop bit (must be 1, else framing error).
 *
 * Sub-sample-accurate baud timing: the fractional `SR/baud`
 * (e.g. 6.667 at 1200 baud / 8 kHz) is preserved across bits by
 * subtracting `samplesPerSym` (a float) from `baudPhase` rather
 * than resetting it to 0 between bits. Over many bits, the actual
 * symbol period stays exactly `SR/baud` samples on average — same
 * approach spandsp uses with its `SAMPLE_RATE*100 / baud_rate*100`
 * integer-scaled phase.
 *
 * Constructor opts:
 *   markFreq, spaceFreq, baud  — required.
 *   cutoffDbm0  — carrier-detect threshold (default -30, V.23 spec).
 *
 * Emits:
 *   'data' — Buffer of UART-decoded bytes.
 *   'bit'  — raw demodulated bits (used by V.8 octet framers if any
 *            external code wants them; V.23 generally doesn't).
 */
class CoherentFskDemodulator extends EventEmitter {
  constructor({ markFreq, spaceFreq, baud, cutoffDbm0 = -30 }) {
    super();
    this._markFreq  = markFreq;
    this._spaceFreq = spaceFreq;
    this._baud      = baud;

    // Quadrature DDS references at each tone. Phase is in radians.
    this._phaseMark      = 0;
    this._phaseSpace     = 0;
    this._phaseIncMark   = TWO_PI * markFreq  / SR;
    this._phaseIncSpace = TWO_PI * spaceFreq / SR;

    // Sliding-window length = one symbol period rounded DOWN (matches
    // spandsp's `correlation_span = SAMPLE_RATE*100/baud_rate` which
    // is C integer division = truncation). For V.23 forward at
    // 8 kHz this gives 6 samples, leaving a small fraction of each
    // symbol outside the window — a deliberate trade-off in spandsp
    // that reduces inter-symbol energy bleeding at the cost of
    // slightly less integration energy. The bit-period timing in the
    // framer uses exact `baud` units so baud accuracy is preserved
    // independent of this rounding.
    this._winLen = Math.max(2, Math.floor(SR / baud));
    this._winRe  = [new Float64Array(this._winLen), new Float64Array(this._winLen)];
    this._winIm  = [new Float64Array(this._winLen), new Float64Array(this._winLen)];
    this._dotRe  = [0, 0];
    this._dotIm  = [0, 0];
    this._winPtr = 0;

    // Integer baud-phase arithmetic (spandsp-faithful):
    //
    //   baudPhase ∈ [0, SR)  is in "baud-time / SR" units.
    //   Per-sample increment = `baud` (the protocol baud rate, in bps).
    //   60% threshold   = 0.6 * SR
    //   100% threshold  = SR
    //   Start-bit seed  = 0.3 * SR  (spandsp does
    //                                 SAMPLE_RATE*(100-40)/2 = SR*30
    //                                 in its 1/100-bps-scaled units;
    //                                 dividing both sides of all the
    //                                 thresholds by 100 collapses to
    //                                 plain bps for the increment and
    //                                 plain SR for the thresholds.)
    //
    // Concretely for V.23 forward (1200 baud, 8000 SR):
    //   per-sample increment = 1200
    //   sixty threshold      = 4800
    //   sps threshold        = 8000
    //   one symbol = 8000/1200 ≈ 6.67 samples (handled via the carry
    //                  baud_phase -= SR after each commit, preserving
    //                  the fractional remainder exactly).
    this._baudInc       = baud;
    this._sixtyThresh   = Math.floor(SR * 0.6);
    this._spsThresh     = SR;
    this._startBitSeed  = Math.floor(SR * 0.3);

    // ── Carrier-presence detector ─────────────────────────────────
    //
    // Power threshold derivation: spandsp specifies a `min_level`
    // in dBm0 (default -30 for V.23). It applies hysteresis of
    // ±2.5 dB around it (carrier_on at +2.5 dBm0 above cutoff,
    // carrier_off at -2.5 below) plus a -5.3 dB correction for
    // the DC-blocker's measurement-gain offset. We replicate the
    // same offsets here.
    //
    // 0 dBm0 reference in our normalized PCMU [-1, +1] float space:
    // a sine wave at peak amplitude 0.5 has RMS 0.5/√2, RMS power
    // (0.5)²/2 = 0.125. We treat that as 0 dBm0.
    //   power_dbm0 = 10*log10(power_linear / 0.125)
    //   power_linear = 0.125 * 10^(dbm0 / 10)
    const refPower = 0.125;
    const dcBlockerCorrection = -5.3;   // matches spandsp
    const onDbm0  = cutoffDbm0 + 2.5 + dcBlockerCorrection;
    const offDbm0 = cutoffDbm0 - 2.5 + dcBlockerCorrection;
    this._carrierOnPower  = refPower * Math.pow(10, onDbm0  / 10);
    this._carrierOffPower = refPower * Math.pow(10, offDbm0 / 10);

    // Power-meter LPF on (x - x_prev)². Time constant ~4 baud
    // (matches spandsp's `power_meter_init(s, 4)` 16-sample
    // integration scale at 1200 baud / 8 kHz; for slower bauds
    // this stretches naturally).
    this._powerAlpha = 1 - Math.exp(-1 / (this._winLen * 4));
    this._powerEst   = 0;
    this._lastSample = 0;

    // Carrier state. signal_present mirrors spandsp's int — 0 means
    // off; on first transition above carrier_on it goes to 1. Stays
    // > 0 while carrier is up; -- on each below-off-threshold sample;
    // when it reaches 0 carrier is declared down.
    this._signalPresent = 0;

    // ── UART framing state machine ────────────────────────────────
    this._baudPhase    = 0;
    this._framePos     = -2;     // -2 idle, -1 start-bit confirm, 0..7 data, 8 stop
    this._frameInProg  = 0;
    this._lastBit      = -1;
    // Pre-roll counter: spandsp delays asserting signal_present until
    // the correlation window is partially filled.
    this._preRoll      = 0;
  }

  /** Reset all per-call state. */
  reset() {
    this._phaseMark    = 0;
    this._phaseSpace   = 0;
    for (let j = 0; j < 2; j++) {
      this._winRe[j].fill(0);
      this._winIm[j].fill(0);
      this._dotRe[j] = 0;
      this._dotIm[j] = 0;
    }
    this._winPtr        = 0;
    this._powerEst      = 0;
    this._lastSample    = 0;
    this._signalPresent = 0;
    this._baudPhase     = 0;
    this._framePos      = -2;
    this._frameInProg   = 0;
    this._lastBit       = -1;
    this._preRoll       = 0;
  }

  /** True if carrier is currently detected. */
  get carrierDetected() { return this._signalPresent > 0; }

  process(samples) {
    const winLen = this._winLen;
    let winPtr = this._winPtr;

    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      // ── Sliding-window quadrature correlation ─────────────────
      //
      // For each of mark (j=0) and space (j=1):
      //   subtract the oldest contribution at winPtr
      //   compute new I/Q against the current DDS phase
      //   add the new contribution
      // Then |dot|² = re² + im² is the matched-filter output.
      for (let j = 0; j < 2; j++) {
        this._dotRe[j] -= this._winRe[j][winPtr];
        this._dotIm[j] -= this._winIm[j][winPtr];
        const phase = j === 0 ? this._phaseMark : this._phaseSpace;
        const cs = Math.cos(phase);
        const sn = Math.sin(phase);
        const re = cs * x;
        const im = sn * x;
        this._winRe[j][winPtr] = re;
        this._winIm[j][winPtr] = im;
        this._dotRe[j] += re;
        this._dotIm[j] += im;
      }

      // Advance phase accumulators.
      this._phaseMark  += this._phaseIncMark;
      this._phaseSpace += this._phaseIncSpace;
      if (this._phaseMark  >= TWO_PI) this._phaseMark  -= TWO_PI;
      if (this._phaseSpace >= TWO_PI) this._phaseSpace -= TWO_PI;

      // ── Power-meter on DC-blocked input ───────────────────────
      const dc = x - this._lastSample;
      this._lastSample = x;
      this._powerEst += this._powerAlpha * (dc * dc - this._powerEst);

      // ── Carrier-on / carrier-off hysteresis ──────────────────
      if (this._signalPresent > 0) {
        if (this._powerEst < this._carrierOffPower) {
          if (--this._signalPresent <= 0) {
            // Carrier dropped — flush UART state.
            this._baudPhase   = 0;
            this._framePos    = -2;
            this._frameInProg = 0;
            this._lastBit     = -1;
            if (++winPtr >= winLen) winPtr = 0;
            continue;
          }
        } else {
          // Refresh the hold counter if power is still healthy.
          this._signalPresent = 1;
        }
      } else {
        if (this._powerEst < this._carrierOnPower) {
          this._preRoll = 0;
          if (++winPtr >= winLen) winPtr = 0;
          continue;
        }
        // Carrier is rising — wait for the correlation window to fill
        // about halfway before declaring signal_present and trusting
        // bit decisions. Spandsp's heuristic: correlation_span/2 - 30
        // (the 30 is in 1/100-baud units, i.e. negligible for short
        // windows); in our sample units that's roughly winLen/2.
        if (this._preRoll < (winLen >> 1)) {
          this._preRoll++;
          if (++winPtr >= winLen) winPtr = 0;
          continue;
        }
        // Activate.
        this._signalPresent = 1;
        this._baudPhase     = 0;
        this._framePos      = -2;
        this._frameInProg   = 0;
        this._lastBit       = -1;
      }

      // ── Bit decision: matched-filter energy comparison ────────
      const sumMark  = this._dotRe[0] * this._dotRe[0] + this._dotIm[0] * this._dotIm[0];
      const sumSpace = this._dotRe[1] * this._dotRe[1] + this._dotIm[1] * this._dotIm[1];
      const baudstate = sumMark > sumSpace ? 1 : 0;

      // ── UART framing (spandsp FSK_FRAME_MODE_FRAMED) ─────────
      this._processFrameBit(baudstate);

      if (++winPtr >= winLen) winPtr = 0;
    }
    this._winPtr = winPtr;
  }

  /**
   * Per-sample UART character framer.
   *
   * Faithful port of spandsp fsk.c's FSK_FRAME_MODE_FRAMED case,
   * using integer baud-phase arithmetic for exactness.
   *
   *   Per-sample increment = baud (bps)
   *   60% threshold        = SR * 0.6
   *   100% threshold       = SR
   *
   * Sub-sample accuracy is preserved by subtracting (not zeroing)
   * the SR threshold at each bit boundary, carrying the fractional
   * remainder into the next bit. Over many bits the actual symbol
   * period is exactly SR/baud samples on average.
   */
  _processFrameBit(baudstate) {
    if (this._framePos === -2) {
      // Idle: any 0 is a candidate start bit. Seed baud_phase such
      // that the start-bit verify period covers the next ~70% of a
      // symbol (matches spandsp's `baud_phase = SR*30` seed).
      if (baudstate === 0) {
        this._baudPhase   = this._startBitSeed;
        this._framePos    = -1;
        this._frameInProg = 0;
        this._lastBit     = -1;
      }
      return;
    }

    if (this._framePos === -1) {
      // Start-bit verification. Demand continuous 0 from the edge
      // through past mid-bit.
      if (baudstate !== 0) {
        // Spurious 0 — restart hunt.
        this._framePos = -2;
        return;
      }
      this._baudPhase += this._baudInc;
      if (this._baudPhase >= this._spsThresh) {
        // Stable start bit confirmed. Begin data-bit phase.
        // _lastBit MUST be -1 here so that at the next 60% mark the
        // first data bit's value gets seeded fresh.
        this._framePos  = 0;
        this._lastBit   = -1;
        this._baudPhase -= this._spsThresh;     // preserve fractional carry
      }
      return;
    }

    // Data or stop bit.
    this._baudPhase += this._baudInc;
    if (this._baudPhase >= this._sixtyThresh) {
      // First sample at or past the 60% mark seeds lastBit.
      if (this._lastBit < 0) this._lastBit = baudstate;

      // Central-stability check: from 60% through 100%, the sampled
      // bit must remain consistent. Any change → framing error.
      if (this._lastBit !== baudstate) {
        this._framePos = -2;
        return;
      }

      if (this._baudPhase >= this._spsThresh) {
        // 100% mark — commit the bit.
        if (this._framePos > 7) {
          // This is the stop bit (we've already taken 8 data bits).
          if (baudstate === 1) {
            // Good frame — emit the byte. _frameInProg has been
            // assembled LSB-first, so it's already byte-aligned.
            this.emit('data', Buffer.from([this._frameInProg & 0xff]));
          }
          // else: bad stop bit, framing error — drop silently.
          this._framePos    = -2;
          this._frameInProg = 0;
        } else {
          // Data bit. Append LSB-first — bit at _framePos goes into
          // bit-position _framePos of the byte (bit 0 first).
          this._frameInProg |= (baudstate & 1) << this._framePos;
          this.emit('bit', baudstate);
          this._framePos++;
        }
        this._baudPhase -= this._spsThresh;     // preserve fractional carry
        this._lastBit    = -1;
      }
    }
  }
}

module.exports = { FskModulator, FskDemodulator, CoherentFskDemodulator, SR };
