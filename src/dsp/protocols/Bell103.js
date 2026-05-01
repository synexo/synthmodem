'use strict';

/**
 * Bell 103 — 300 bps full-duplex FSK (AT&T Bell System standard).
 *
 * Bell 103 is the North American predecessor of ITU-T V.21. Same
 * modulation family (binary FSK at 300 baud, UART-framed bytes), but
 * uses different carrier pairs and an inverted mark/space polarity
 * relative to V.21:
 *
 *   Originate (call) modem:   Mark = 1270 Hz, Space = 1070 Hz
 *   Answer modem:             Mark = 2225 Hz, Space = 2025 Hz
 *
 * For comparison, V.21 puts the answer side above 1600 Hz with
 * Mark < Space:
 *   V.21 Originate:           Mark =  980 Hz, Space = 1180 Hz
 *   V.21 Answer:              Mark = 1650 Hz, Space = 1850 Hz
 *
 * The bandpass-filter correlator demodulator handles either polarity
 * transparently — we just tune filters to the correct frequencies and
 * the `mark > space envelope` comparison works either way.
 *
 * Bell 103 predates V.8 signalling by a quarter-century, so there is
 * no answer-tone / ANSam exchange — the answer modem simply idles
 * mark and listens. See Handshake.js for the forced-Bell103 answer-
 * side sequence.
 *
 * The modulator, demodulator, carrier-detect, and UART framing are
 * shared with V.21 (see FskCommon.js).
 */

const { EventEmitter }                  = require('events');
const { FskModulator, FskDemodulator }  = require('./FskCommon');

// Bell 103 carrier frequencies (Hz) per AT&T Bell System spec.
const B103_CH1_MARK  = 1270;   // originate Mark (binary 1)
const B103_CH1_SPACE = 1070;   // originate Space (binary 0)
const B103_CH2_MARK  = 2225;   // answer Mark (binary 1)
const B103_CH2_SPACE = 2025;   // answer Space (binary 0)

const B103_BAUD = 300;

class Bell103Modulator extends FskModulator {
  /** @param {1|2} channel — 1 for originate, 2 for answer */
  constructor(channel) {
    const isCh2 = channel === 2;
    super({
      markFreq:  isCh2 ? B103_CH2_MARK  : B103_CH1_MARK,
      spaceFreq: isCh2 ? B103_CH2_SPACE : B103_CH1_SPACE,
      baud:      B103_BAUD,
    });
  }
}

class Bell103Demodulator extends FskDemodulator {
  /** @param {1|2} channel — TX channel; we receive from the OTHER channel */
  constructor(channel) {
    const rxCh = channel === 2 ? 1 : 2;
    const isCh2 = rxCh === 2;
    super({
      markFreq:  isCh2 ? B103_CH2_MARK  : B103_CH1_MARK,
      spaceFreq: isCh2 ? B103_CH2_SPACE : B103_CH1_SPACE,
      baud:      B103_BAUD,
    });
  }
}

class Bell103 extends EventEmitter {
  constructor(role) {
    super();
    const txCh = role === 'answer' ? 2 : 1;
    this.modulator   = new Bell103Modulator(txCh);
    this.demodulator = new Bell103Demodulator(txCh);

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit', bit));
  }

  /** Write data bytes to be transmitted (UART-framed). */
  write(data)              { this.modulator.write(data); }

  /** Write raw bits (no UART framing). */
  writeBits(bits)          { this.modulator.writeBits(bits); }

  /** Generate n samples of transmit audio. */
  generateAudio(n)         { return this.modulator.generate(n); }

  /** Process received audio samples. */
  receiveAudio(samples)    { this.demodulator.process(samples); }

  /** True if RX carrier is currently detected. */
  get carrierDetected()    { return this.demodulator.carrierDetected; }

  get name() { return 'Bell103'; }
  get bps()  { return B103_BAUD; }
}

module.exports = { Bell103, Bell103Modulator, Bell103Demodulator };
