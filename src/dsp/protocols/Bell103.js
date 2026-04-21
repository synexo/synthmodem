'use strict';

/**
 * Bell 103 — 300 bps full-duplex FSK (AT&T Bell System standard).
 *
 * Bell 103 is the North American predecessor of ITU-T V.21. Same modulation
 * family (asynchronous binary FSK at 300 baud, UART-framed bytes), but uses
 * different carrier pairs and a different (inverted) mark/space polarity
 * relative to V.21:
 *
 *   Originate (call) modem:   Mark = 1270 Hz, Space = 1070 Hz
 *   Answer modem:             Mark = 2225 Hz, Space = 2025 Hz
 *
 * For comparison, V.21 puts the answer side above 1600 Hz with Mark < Space:
 *   V.21 Originate:           Mark =  980 Hz, Space = 1180 Hz
 *   V.21 Answer:              Mark = 1650 Hz, Space = 1850 Hz
 *
 * The bandpass-filter correlator demodulator handles both polarities
 * transparently — we just tune filters to the correct frequencies and
 * the `mark > space envelope` comparison works either way.
 *
 * This file is a near-line-for-line clone of V21.js with the four carrier
 * frequency constants swapped. It is intentionally kept as a separate file
 * rather than a parameterised superclass so that (a) V21.js is not modified
 * and can never regress, and (b) the carrier frequencies remain immediately
 * visible without trailing a config object.
 *
 * Bell 103 predates V.8 signalling by a quarter-century, so there is no
 * answer-tone / ANSam exchange — the answer modem simply idles mark and
 * listens. See Handshake.js for the forced-Bell103 answer-side sequence.
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const {
  NCO, BiquadFilter, SinglePoleLPF, rms, generateTone, TWO_PI
} = require('../Primitives');

const SR    = config.rtp.sampleRate;        // 8000
const BAUD  = 300;
const SPS   = SR / BAUD;                    // 26.667 samples/symbol

// Bell 103 frequencies per AT&T Bell System spec.
const B103_CH1_MARK  = 1270;   // originate Mark (binary 1)
const B103_CH1_SPACE = 1070;   // originate Space (binary 0)
const B103_CH2_MARK  = 2225;   // answer Mark (binary 1)
const B103_CH2_SPACE = 2025;   // answer Space (binary 0)

// ─── Modulator ────────────────────────────────────────────────────────────────

class Bell103Modulator {
  constructor(channel) {
    // channel: 1 = originating (call), 2 = answering
    this._markFreq  = channel === 2 ? B103_CH2_MARK  : B103_CH1_MARK;
    this._spaceFreq = channel === 2 ? B103_CH2_SPACE : B103_CH1_SPACE;
    this._phase     = 0;
    this._curFreq   = this._markFreq; // idle = mark
    this._channel   = channel;

    // Bit queue (can be populated via write() for UART-framed bytes, or
    // via writeBits() for raw bit patterns — both mechanisms coexist).
    this._bits      = [];
    // Amplitude chosen to match typical PSTN line level (~-10 dBm0) when
    // treated as a normalised signal. Matches V.21's level for consistent
    // behaviour through our SIP/PCMU path.
    this._amplitude = 0.15;

    // Baud-accurate symbol timing. At 8000 Hz / 300 baud the symbol
    // period is exactly 26.666... samples. Use a sub-sample accumulator
    // so over 3 symbols we emit 27+27+26 = 80 samples = 10.0 ms =
    // exactly 300 baud.
    this._samplesPerSymbol = SR / BAUD;   // 26.666...
    this._symbolPhase      = 0;
    this._samplesLeft      = 0;
  }

  /** Queue bytes to transmit (UART-framed: start + 8 data LSB-first + 1 stop). */
  write(bytes) {
    for (const byte of bytes) {
      this._bits.push(0); // start bit
      for (let b = 0; b < 8; b++) {
        this._bits.push((byte >> b) & 1);
      }
      this._bits.push(1); // stop bit (single, standard 10N1 async)
    }
  }

  /** Queue raw bits to transmit (no UART framing). */
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

class Bell103Demodulator extends EventEmitter {
  constructor(channel) {
    super();
    // We receive from the OTHER channel.
    const rxCh      = channel === 2 ? 1 : 2;
    this._markFreq  = rxCh === 2 ? B103_CH2_MARK  : B103_CH1_MARK;
    this._spaceFreq = rxCh === 2 ? B103_CH2_SPACE : B103_CH1_SPACE;

    // Bandpass filters around mark and space. Q = 15 matches V.21 and
    // gives ~200 Hz -3 dB bandwidth — wide enough for 300 baud FSK
    // transitions, narrow enough to reject adjacent-band interference
    // (e.g. the other direction's signal in full-duplex operation).
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

    this._samplesPerSym = SR / BAUD;

    // Carrier-detection thresholds — same as V.21 (same modulation,
    // same line level, same filter Q).
    this._cdThreshold    = 0.005;
    this._cdOnHyst       = 0.008;
    this._cdOffHyst      = 0.003;
    this._cd             = false;
    this._cdHoldSamples  = 0;
    this._cdHoldMax      = Math.round(SR * 0.010);  // 10 ms hang

    // CD warmup: after CD turns ON, suppress bit decisions for this many
    // samples to let the mark/space bandpass filters settle.
    this._cdWarmupMax = Math.round(SR * 0.012);  // 12 ms
    this._cdWarmup    = 0;

    // Per-sample bit stream and edge-locked UART.
    this._prevBit      = 1;
    this._stableCount  = 0;
    this._stableNeeded = 4;

    // Sub-sample-accurate bit timing.
    this._bitTimer     = 0;
    this._bitPhase     = 0;

    // UART state machine.
    this._state    = 'IDLE';
    this._dataBits = [];
    this._bitCount = 0;
  }

  /** Schedule the next bit sampling point. */
  _scheduleNextBit(initialOffset) {
    if (initialOffset != null) {
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

      const smEnv = this._slowEnvMark.process(mEnv);
      const ssEnv = this._slowEnvSpace.process(sEnv);
      const topEnv = Math.max(smEnv, ssEnv);

      // Hysteresis-based carrier detect.
      if (!this._cd && topEnv > this._cdOnHyst) {
        this._cd = true;
        this._cdHoldSamples = this._cdHoldMax;
        this._cdWarmup      = this._cdWarmupMax;
        this._state = 'IDLE';
        this._stableCount = 0;
      } else if (this._cd && topEnv < this._cdOffHyst) {
        if (this._cdHoldSamples > 0) {
          this._cdHoldSamples--;
        } else {
          this._cd = false;
          this._cdWarmup = 0;
          this._state = 'IDLE';
          this._stableCount = 0;
          this._dataBits = [];
          this._bitCount = 0;
        }
      } else if (this._cd) {
        if (topEnv >= this._cdOffHyst) this._cdHoldSamples = this._cdHoldMax;
      }

      if (!this._cd) {
        this._prevBit = 1;
        continue;
      }

      if (this._cdWarmup > 0) {
        this._cdWarmup--;
        this._prevBit = 1;
        continue;
      }

      const bit = mEnv > sEnv ? 1 : 0;

      if (this._state === 'IDLE') {
        if (bit === 0) {
          this._stableCount++;
          if (this._stableCount >= this._stableNeeded) {
            this._state    = 'DATA';
            this._dataBits = [];
            this._bitCount = 0;
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
            this._state       = 'IDLE';
            this._stableCount = 0;
          }
        }
      }

      this._prevBit = bit;
    }
  }

  /** Returns true if Bell 103 carrier is currently detected on the RX band. */
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

// ─── Bell 103 combined codec ──────────────────────────────────────────────────

class Bell103 extends EventEmitter {
  constructor(role) {
    super();
    // role: 'answer' or 'originate'
    const txCh = role === 'answer' ? 2 : 1;
    this.modulator   = new Bell103Modulator(txCh);
    this.demodulator = new Bell103Demodulator(txCh);

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit', bit));
  }

  /** Write data bytes to be transmitted (UART-framed). */
  write(data) {
    this.modulator.write(data);
  }

  /** Write raw bits to be transmitted (no UART framing). */
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

  get name() { return 'Bell103'; }
  get bps()  { return 300; }
}

module.exports = { Bell103, Bell103Modulator, Bell103Demodulator };
