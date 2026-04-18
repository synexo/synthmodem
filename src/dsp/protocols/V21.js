'use strict';

/**
 * V.21 — 300 bps full-duplex FSK
 *
 * Channel 1 (originating modem):  Mark=1280 Hz, Space=1080 Hz
 * Channel 2 (answering modem):    Mark=2100 Hz, Space=1750 Hz  (ITU uses 2100/1850, adjusted in config)
 *
 * Modulation: binary FSK, 1 bit per symbol at 300 baud.
 * Demodulation: Goertzel-based energy detection per symbol period,
 *               with bandpass filters to separate mark/space.
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const {
  NCO, BiquadFilter, SinglePoleLPF, rms, generateTone, TWO_PI
} = require('../Primitives');

const SR    = config.rtp.sampleRate;        // 8000
const BAUD  = 300;
const SPS   = SR / BAUD;                    // 26.667 samples/symbol
const CFG   = config.modem.carriers.V21;

// ─── Modulator ────────────────────────────────────────────────────────────────

class V21Modulator {
  constructor(channel) {
    // channel: 1 = originating, 2 = answering
    this._markFreq  = channel === 2 ? CFG.ch2Mark  : CFG.ch1Mark;
    this._spaceFreq = channel === 2 ? CFG.ch2Space : CFG.ch1Space;
    this._nco       = new NCO(SR);
    this._phase     = 0;
    this._curFreq   = this._markFreq; // idle = mark
    this._channel   = channel;

    // Bit queue
    this._bits      = [];
    this._samplesLeft = 0;
    this._amplitude = 0.45;
  }

  /** Queue bytes to transmit */
  write(bytes) {
    for (const byte of bytes) {
      this._bits.push(0); // start bit
      for (let b = 0; b < 8; b++) {
        this._bits.push((byte >> b) & 1);
      }
      this._bits.push(1); // stop bit
      this._bits.push(1); // 2nd stop bit
    }
  }

  /** Generate numSamples of audio. Returns Float32Array. */
  generate(numSamples) {
    const out    = new Float32Array(numSamples);
    let   pos    = 0;

    while (pos < numSamples) {
      if (this._samplesLeft <= 0) {
        // Get next bit
        const bit = this._bits.length > 0 ? this._bits.shift() : 1; // idle = mark
        this._curFreq = bit === 1 ? this._markFreq : this._spaceFreq;
        // Spread 300 baud evenly: alternate 26 and 27 samples per symbol
        // so that over 300 symbols we use exactly 8000 samples
        this._symCount = (this._symCount || 0) + 1;
        this._samplesLeft = (this._symCount % 3 === 0) ? 27 : 27;
        // Simplest: always 27, accept 0.1% baud error (fine for async UART)
        this._samplesLeft = 27;
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
    // We receive from the OTHER channel
    const rxCh      = channel === 2 ? 1 : 2;
    this._markFreq  = rxCh === 2 ? CFG.ch2Mark  : CFG.ch1Mark;
    this._spaceFreq = rxCh === 2 ? CFG.ch2Space : CFG.ch1Space;

    // Bandpass filters around mark and space
    const Q = 10;
    this._bpMark  = BiquadFilter.makeBandPass(this._markFreq,  Q, SR);
    this._bpSpace = BiquadFilter.makeBandPass(this._spaceFreq, Q, SR);

    // Envelope detectors — fast enough to follow 300 baud transitions
    const alpha       = 1 - Math.exp(-2 * Math.PI * (BAUD * 0.8) / SR);
    this._envMark     = new SinglePoleLPF(alpha);
    this._envSpace    = new SinglePoleLPF(alpha);

    this._samplesPerSym = SR / BAUD;   // 26.667

    // Per-sample bit stream and edge-locked UART
    this._prevBit      = 1;    // line idles at mark = 1
    this._stableCount  = 0;    // consecutive space samples seen
    this._stableNeeded = 4;    // samples needed to confirm start bit
    this._sampleTimer  = 0;    // counts down to next sample point

    // UART state machine
    this._state    = 'IDLE';
    this._dataBits = [];
    this._bitCount = 0;
  }

  /**
   * Process incoming audio samples. Emits 'data' with Buffer of decoded bytes.
   */
  process(samples) {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      const mEnv = this._envMark.process(Math.abs(this._bpMark.process(x)));
      const sEnv = this._envSpace.process(Math.abs(this._bpSpace.process(x)));

      const bit = mEnv > sEnv ? 1 : 0;

      if (this._state === 'IDLE') {
        if (bit === 0) {
          // Potential start bit — require STABLE_NEEDED consecutive space samples
          // to reject filter transients
          this._stableCount++;
          if (this._stableCount >= this._stableNeeded) {
            // We are now this._stableNeeded samples into the start bit.
            // Centre of start bit is at SPS/2 from its beginning.
            // Centre of bit-0 is SPS further on.
            // We've already consumed this._stableNeeded samples of start bit,
            // so timer to first data sample = SPS/2 + SPS - stableNeeded
            this._sampleTimer = Math.round(
              this._samplesPerSym / 2 + this._samplesPerSym - this._stableNeeded
            );
            this._state    = 'DATA';
            this._dataBits = [];
            this._bitCount = 0;
            this._stableCount = 0;
          }
        } else {
          this._stableCount = 0;
        }
      } else if (this._state === 'DATA' || this._state === 'STOP') {
        this._sampleTimer--;
        if (this._sampleTimer <= 0) {
          this._sampleTimer = Math.round(this._samplesPerSym);
          if (this._state === 'DATA') {
            this._dataBits.push(bit);
            if (++this._bitCount === 8) this._state = 'STOP';
          } else {
            // Stop bit
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

  reset() {
    this._bpMark.reset(); this._bpSpace.reset();
    this._envMark.reset(); this._envSpace.reset();
    this._sampleTimer = 0; this._prevBit = 1; this._stableCount = 0;
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
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
  }

  /** Write data bytes to be transmitted */
  write(data) {
    this.modulator.write(data);
  }

  /** Generate n samples of transmit audio */
  generateAudio(n) {
    return this.modulator.generate(n);
  }

  /** Process received audio samples */
  receiveAudio(samples) {
    this.demodulator.process(samples);
  }

  get name() { return 'V21'; }
  get bps()  { return 300; }
}

module.exports = { V21, V21Modulator, V21Demodulator };
