'use strict';

/**
 * V.21 — 300 bps full-duplex FSK, per ITU-T Recommendation V.21.
 *
 * Spec frequencies (V.21 §2):
 *   Channel 1 (originating/call modem):   Mark = 980 Hz, Space = 1180 Hz
 *   Channel 2 (answering modem):          Mark = 1650 Hz, Space = 1850 Hz
 *
 * UART framing: start (0) + 8 data LSB-first + stop (1) — also the
 * format used by V.8 §5 for CI/CM/JM octets on the V.21(L) channel.
 *
 * The modulation, demodulation, carrier-detect, and UART framing are
 * shared with Bell 103 (and V.23's forward channel). All of that
 * lives in FskCommon.js. This file is a thin wrapper supplying the
 * V.21-specific frequencies and the conventional class names that
 * the rest of the codebase imports.
 *
 * History note: this file used to contain a near-line-for-line copy
 * of Bell103.js (or vice-versa). The shared base classes were
 * extracted in April 2026 along with two demodulator improvements
 * (majority-of-3 mid-bit and stop-bit sampling) targeted at the
 * "very occasional garbage characters" failure mode users had
 * observed under noisy line conditions.
 */

const { EventEmitter }                  = require('events');
const { FskModulator, FskDemodulator }  = require('./FskCommon');

// V.21 carrier frequencies (Hz) per ITU-T V.21.
const V21_CH1_MARK  = 980;
const V21_CH1_SPACE = 1180;
const V21_CH2_MARK  = 1650;
const V21_CH2_SPACE = 1850;

const V21_BAUD = 300;

class V21Modulator extends FskModulator {
  /** @param {1|2} channel — 1 for originate, 2 for answer */
  constructor(channel) {
    const isCh2 = channel === 2;
    super({
      markFreq:  isCh2 ? V21_CH2_MARK  : V21_CH1_MARK,
      spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
      baud:      V21_BAUD,
    });
  }
}

class V21Demodulator extends FskDemodulator {
  /** @param {1|2} channel — TX channel; we receive from the OTHER channel */
  constructor(channel) {
    const rxCh = channel === 2 ? 1 : 2;
    const isCh2 = rxCh === 2;
    super({
      markFreq:  isCh2 ? V21_CH2_MARK  : V21_CH1_MARK,
      spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
      baud:      V21_BAUD,
    });
  }
}

class V21 extends EventEmitter {
  constructor(role) {
    super();
    const txCh = role === 'answer' ? 2 : 1;
    this.modulator   = new V21Modulator(txCh);
    this.demodulator = new V21Demodulator(txCh);

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit', bit));
  }

  /** Write data bytes to be transmitted (UART-framed). */
  write(data)              { this.modulator.write(data); }

  /** Write raw bits (no UART framing). For V.8 preamble. */
  writeBits(bits)          { this.modulator.writeBits(bits); }

  /** Generate n samples of transmit audio. */
  generateAudio(n)         { return this.modulator.generate(n); }

  /** Process received audio samples. */
  receiveAudio(samples)    { this.demodulator.process(samples); }

  /** True if RX carrier is currently detected. */
  get carrierDetected()    { return this.demodulator.carrierDetected; }

  get name() { return 'V21'; }
  get bps()  { return V21_BAUD; }
}

module.exports = { V21, V21Modulator, V21Demodulator };
