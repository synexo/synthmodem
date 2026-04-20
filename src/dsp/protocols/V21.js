'use strict';

/**
 * V.21 — 300 bps full-duplex FSK, per ITU-T Recommendation V.21.
 *
 * Spec frequencies (V.21 §2):
 *   Channel 1 (originating/call modem):   Mark = 980 Hz, Space = 1180 Hz
 *   Channel 2 (answering modem):          Mark = 1650 Hz, Space = 1850 Hz
 *
 * Modulation: binary FSK, 1 bit per symbol at 300 baud.
 * Demodulation: bandpass-filter correlator with envelope detection,
 *               oversampled per symbol period.
 *
 * This file used to have non-standard frequencies (1280/1080/2100/1750)
 * that worked only between two SynthModem instances. They are now replaced
 * with V.21-spec frequencies so a real V.21 or V.8 modem can recognize
 * our transmit signal and vice-versa.
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const {
  NCO, BiquadFilter, SinglePoleLPF, rms, generateTone, TWO_PI
} = require('../Primitives');

const SR    = config.rtp.sampleRate;        // 8000
const BAUD  = 300;
const SPS   = SR / BAUD;                    // 26.667 samples/symbol

// Spec V.21 frequencies — not read from config because config was wrong.
// If config.modem.carriers.V21 is present it's ignored.
const V21_CH1_MARK  = 980;
const V21_CH1_SPACE = 1180;
const V21_CH2_MARK  = 1650;
const V21_CH2_SPACE = 1850;

// ─── Modulator ────────────────────────────────────────────────────────────────

class V21Modulator {
  constructor(channel) {
    // channel: 1 = originating (call), 2 = answering
    this._markFreq  = channel === 2 ? V21_CH2_MARK  : V21_CH1_MARK;
    this._spaceFreq = channel === 2 ? V21_CH2_SPACE : V21_CH1_SPACE;
    this._phase     = 0;
    this._curFreq   = this._markFreq; // idle = mark
    this._channel   = channel;

    // Bit queue (can be populated via write() for UART-framed bytes, or
    // via writeBits() for raw bit patterns — both mechanisms coexist).
    this._bits      = [];
    // Amplitude chosen to match typical PSTN V.21 line level (~-13 dBm)
    // when treated as a normalized signal. 0.15 peak is roughly -10 dBm0
    // in a PCMU/PCMA μ-law/A-law encoded stream without saturating. The
    // previous value (0.45) was ~10 dB hot and caused demod distortion
    // in real modems.
    this._amplitude = 0.15;

    // Baud-accurate symbol timing. At 8000 Hz / 300 baud the symbol
    // period is exactly 26.666... samples. Instead of rounding to 27
    // (which gives +1.25% baud error), we use a sub-sample accumulator:
    // add 26.666... per symbol and take the floor as the integer sample
    // count. Over every 3 symbols this yields 27+27+26 = 80 samples =
    // 10.0 ms = exactly 300 baud.
    this._samplesPerSymbol = SR / BAUD;   // 26.666...
    this._symbolPhase      = 0;           // accumulated fractional samples
    this._samplesLeft      = 0;           // remaining samples in current symbol
  }

  /** Queue bytes to transmit (UART-framed: start + 8 data LSB-first + 1 stop).
   *  V.8 §5 specifies single-stop-bit framing for CI/CM/JM octets; standard
   *  V.21 async serial is also 10N1 (10 bits = start + 8 data + 1 stop). */
  write(bytes) {
    for (const byte of bytes) {
      this._bits.push(0); // start bit
      for (let b = 0; b < 8; b++) {
        this._bits.push((byte >> b) & 1);
      }
      this._bits.push(1); // stop bit (single, per V.8 §5 and V.21 standard)
    }
  }

  /** Queue raw bits to transmit (no UART framing). Used for V.8 preamble. */
  writeBits(bits) {
    for (const b of bits) this._bits.push(b & 1);
  }

  /** Generate numSamples of audio. Returns Float32Array. */
  generate(numSamples) {
    const out = new Float32Array(numSamples);
    let   pos = 0;

    while (pos < numSamples) {
      if (this._samplesLeft <= 0) {
        // Start the next symbol. When queue is empty, output mark (idle = 1).
        const bit = this._bits.length > 0 ? this._bits.shift() : 1;
        this._curFreq = bit === 1 ? this._markFreq : this._spaceFreq;
        // Sub-sample-accurate timing.
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
      pos += chunk;
    }
    return out;
  }

  get idle() { return this._bits.length === 0; }
}

// ─── Demodulator ─────────────────────────────────────────────────────────────

class V21Demodulator extends EventEmitter {
  constructor(channel) {
    super();
    // We receive from the OTHER channel.
    const rxCh      = channel === 2 ? 1 : 2;
    this._markFreq  = rxCh === 2 ? V21_CH2_MARK  : V21_CH1_MARK;
    this._spaceFreq = rxCh === 2 ? V21_CH2_SPACE : V21_CH1_SPACE;

    // Bandpass filters around mark and space. Higher Q = narrower band,
    // better rejection of out-of-band energy (e.g. ANSam at 2100 Hz).
    const Q = 15;
    this._bpMark  = BiquadFilter.makeBandPass(this._markFreq,  Q, SR);
    this._bpSpace = BiquadFilter.makeBandPass(this._spaceFreq, Q, SR);

    // Envelope detectors — fast enough to follow 300 baud transitions.
    const alpha       = 1 - Math.exp(-2 * Math.PI * (BAUD * 0.8) / SR);
    this._envMark     = new SinglePoleLPF(alpha);
    this._envSpace    = new SinglePoleLPF(alpha);

    // Slow envelope for carrier detection (averaged over ~1.5 symbols
    // so CD picks up within ~5 ms of carrier onset).
    const slowAlpha = 1 - Math.exp(-2 * Math.PI * (BAUD / 2) / SR);
    this._slowEnvMark  = new SinglePoleLPF(slowAlpha);
    this._slowEnvSpace = new SinglePoleLPF(slowAlpha);

    this._samplesPerSym = SR / BAUD;   // 26.667

    // Carrier-detection (CD) state. When CD is false, the demod does not
    // emit bits or frame UART — prevents spurious bytes from pure noise
    // or from our own TX echoing back.
    //
    // CD thresholds — tuned from measurements on real-modem captures.
    // When V.21 signal is present we see mark or space envelope around
    // 0.05-0.08; background/noise produces < 0.005.
    this._cdThreshold    = 0.005;   // min of max(mark,space) envelopes
    this._cdOnHyst       = 0.008;   // turn-on threshold (raise above off)
    this._cdOffHyst      = 0.003;   // turn-off threshold
    this._cd             = false;
    this._cdHoldSamples  = 0;       // hang time: keep CD on briefly
    this._cdHoldMax      = Math.round(SR * 0.010);  // 10 ms hang

    // CD warmup: after CD turns ON, suppress bit decisions for this many
    // samples to let the mark/space bandpass filters settle. At Q=15 and
    // 300 baud, filters take ~3 symbols to reach steady-state.
    this._cdWarmupMax = Math.round(SR * 0.012);  // 12 ms = ~3.6 symbols
    this._cdWarmup    = 0;

    // Per-sample bit stream and edge-locked UART.
    this._prevBit      = 1;    // line idles at mark = 1
    this._stableCount  = 0;    // consecutive space samples seen
    this._stableNeeded = 4;    // samples needed to confirm start bit

    // Sub-sample-accurate bit timing.
    // _bitTimer counts down sample-by-sample to the middle of the next
    // bit. _bitPhase accumulates the fractional part so that over N bits
    // the total elapsed samples equals N * 26.666... (exactly 300 baud).
    this._bitTimer     = 0;
    this._bitPhase     = 0;

    // UART state machine.
    this._state    = 'IDLE';
    this._dataBits = [];
    this._bitCount = 0;
  }

  /** Schedule the next bit sampling point, advancing the phase accumulator
   *  by one symbol period (26.666... samples at 8 kHz / 300 bps). */
  _scheduleNextBit(initialOffset) {
    // initialOffset: when falling-edge-detect hits mid-start-bit, we've
    // already consumed some samples; the caller passes that count so we
    // target the middle of the NEXT bit (start-bit center + 1 symbol).
    if (initialOffset != null) {
      // First sampling point: center of start bit is SPS/2 from its leading
      // edge. We've already seen stableNeeded samples past that edge, so the
      // remaining distance to bit-0 center = SPS/2 + SPS - stableNeeded.
      this._bitPhase += this._samplesPerSym / 2 + this._samplesPerSym - initialOffset;
    } else {
      this._bitPhase += this._samplesPerSym;
    }
    this._bitTimer = Math.floor(this._bitPhase);
    this._bitPhase -= this._bitTimer;
  }

  /**
   * Process incoming audio samples. Emits:
   *   'bit'  — per-decision raw bit (0 or 1) one per symbol period
   *   'data' — Buffer of UART-decoded bytes
   */
  process(samples) {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      const mEnv = this._envMark.process(Math.abs(this._bpMark.process(x)));
      const sEnv = this._envSpace.process(Math.abs(this._bpSpace.process(x)));

      // Slow envelope for CD.
      const smEnv = this._slowEnvMark.process(mEnv);
      const ssEnv = this._slowEnvSpace.process(sEnv);
      const topEnv = Math.max(smEnv, ssEnv);

      // Hysteresis-based carrier detect.
      if (!this._cd && topEnv > this._cdOnHyst) {
        this._cd = true;
        this._cdHoldSamples = this._cdHoldMax;
        this._cdWarmup      = this._cdWarmupMax;
        // Reset UART state whenever carrier returns so we don't resume
        // mid-frame with stale bits.
        this._state = 'IDLE';
        this._stableCount = 0;
      } else if (this._cd && topEnv < this._cdOffHyst) {
        if (this._cdHoldSamples > 0) {
          this._cdHoldSamples--;
        } else {
          this._cd = false;
          this._cdWarmup = 0;
          // Abandon any partial frame.
          this._state = 'IDLE';
          this._stableCount = 0;
          this._dataBits = [];
          this._bitCount = 0;
        }
      } else if (this._cd) {
        // Refresh hang time if we're still above the off threshold.
        if (topEnv >= this._cdOffHyst) this._cdHoldSamples = this._cdHoldMax;
      }

      // Without carrier, do nothing further.
      if (!this._cd) {
        this._prevBit = 1;
        continue;
      }

      // During warmup, don't make bit decisions — filters haven't settled.
      if (this._cdWarmup > 0) {
        this._cdWarmup--;
        this._prevBit = 1;
        continue;
      }

      const bit = mEnv > sEnv ? 1 : 0;

      if (this._state === 'IDLE') {
        if (bit === 0) {
          // Potential start bit — require stableNeeded consecutive space
          // samples to reject filter transients.
          this._stableCount++;
          if (this._stableCount >= this._stableNeeded) {
            this._state    = 'DATA';
            this._dataBits = [];
            this._bitCount = 0;
            // Schedule mid-bit-0 sampling point. initialOffset = stableNeeded
            // because we've consumed that many samples of the start bit.
            this._bitPhase = 0;
            this._scheduleNextBit(this._stableNeeded);
            this._stableCount = 0;
          }
        } else {
          this._stableCount = 0;
        }
      } else if (this._state === 'DATA' || this._state === 'STOP') {
        this._bitTimer--;
        if (this._bitTimer <= 0) {
          if (this._state === 'DATA') {
            this._dataBits.push(bit);
            // Emit raw bit for V.8 and other bit-level consumers.
            this.emit('bit', bit);
            if (++this._bitCount === 8) this._state = 'STOP';
            this._scheduleNextBit();
          } else {
            // Stop bit.
            if (bit === 1) {
              let byte = 0;
              for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
              this.emit('data', Buffer.from([byte]));
            }
            // If stop bit is 0 (framing error), drop the byte silently —
            // this rejects bits captured during brief carrier glitches.
            this._state       = 'IDLE';
            this._stableCount = 0;
          }
        }
      }

      this._prevBit = bit;
    }
  }

  /** Returns true if V.21 carrier is currently detected on the RX band. */
  get carrierDetected() { return this._cd; }

  reset() {
    this._bpMark.reset(); this._bpSpace.reset();
    this._envMark.reset(); this._envSpace.reset();
    this._slowEnvMark.reset(); this._slowEnvSpace.reset();
    this._bitTimer = 0; this._bitPhase = 0;
    this._prevBit = 1; this._stableCount = 0;
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
    this._cd = false; this._cdHoldSamples = 0;
  }
}

// ─── V.21 combined codec ───────────────────────────────────────────────────────

class V21 extends EventEmitter {
  constructor(role) {
    super();
    // role: 'answer' or 'originate'
    const txCh = role === 'answer' ? 2 : 1;
    this.modulator   = new V21Modulator(txCh);
    this.demodulator = new V21Demodulator(txCh);

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit', bit));
  }

  /** Write data bytes to be transmitted (UART-framed). */
  write(data) {
    this.modulator.write(data);
  }

  /** Write raw bits to be transmitted (no UART framing). For V.8 preamble. */
  writeBits(bits) {
    this.modulator.writeBits(bits);
  }

  /** Generate n samples of transmit audio. */
  generateAudio(n) {
    return this.modulator.generate(n);
  }

  /** Process received audio samples. */
  receiveAudio(samples) {
    this.demodulator.process(samples);
  }

  /** True if RX carrier is currently detected. */
  get carrierDetected() { return this.demodulator.carrierDetected; }

  get name() { return 'V21'; }
  get bps()  { return 300; }
}

module.exports = { V21, V21Modulator, V21Demodulator };
