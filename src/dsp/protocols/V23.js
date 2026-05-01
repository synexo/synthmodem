'use strict';

/**
 * V.23 — 1200/75 bps split-speed FSK, per ITU-T Recommendation V.23.
 *
 * V.23 has TWO channels at different baud rates. Per spandsp's
 * preset_fsk_specs (which we follow):
 *
 *   Forward channel (1200 bps): mark = 1300 Hz, space = 2100 Hz
 *   Backward channel (75 bps):  mark =  390 Hz, space =  450 Hz
 *
 * Historical use is asymmetric — Minitel, Prestel, BBSes-as-host —
 * with one side (the host) sending the high-speed forward channel
 * and the other side (the terminal) replying on the slow backward
 * channel. We follow the convention that the answering modem is the
 * host, so:
 *
 *   role === 'answer'   →  TX forward (1200), RX backward (75)
 *   role === 'originate' → TX backward (75),  RX forward  (1200)
 *
 * Internally V.23 uses two completely independent FSK transceivers,
 * one for each channel direction. Both use:
 *
 *   - `FskModulator`           for TX (sub-sample-accurate baud
 *                                     timing via fractional carry)
 *   - `CoherentFskDemodulator` for RX (quadrature matched-filter
 *                                     correlator; see FskCommon.js)
 *
 * Why coherent demod for V.23 (and not for V.21 / Bell 103):
 *
 *   - At 1200 baud / 8 kHz there are only ~6.7 samples per symbol.
 *     A bandpass-envelope detector cannot follow this fast cleanly,
 *     and adjacent-symbol energy bleeds into each decision. The
 *     coherent matched-filter approach correlates against pure
 *     reference tones over exactly one symbol period and is the
 *     textbook answer for short-symbol FSK.
 *
 *   - At 75 baud, mark and space are only 60 Hz apart (390 vs 450).
 *     Practical-Q bandpass filters have overlapping passbands at
 *     that separation. Coherent correlation against pure tones
 *     discriminates cleanly because orthogonal frequencies are
 *     uncorrelated over one full symbol period.
 *
 * The previous V.23 implementation (extracted from V32bis.js in
 * cleanup-phase-2) had several bugs that produced massive garbage
 * characters against real V.23 peers:
 *
 *   - Modulator used `Math.round(SR/baud)` for the symbol period,
 *     producing 7 samples/symbol at 1200 baud → actual baud rate
 *     1142.86 (-4.8% error). V.23 spec allows ±0.01%; no real
 *     receiver could decode this.
 *   - Demodulator used the same `Math.round` for symbol timing in
 *     RX, so even when receiving from a baud-accurate transmitter
 *     it would slip bit boundaries over time.
 *   - Demodulator was incoherent BPF + envelope (marginal at these
 *     parameters), had no carrier-detect (so noise during silence
 *     produced phantom bytes), and the framer had no central-bit
 *     stability check.
 *   - TX amplitude was 0.4 (~+12 dB above the V.21/Bell103 value
 *     used by working protocols on the same path).
 *
 * The new implementation in this file inherits sub-sample-accurate
 * baud timing, the spandsp-style robust framer, and -10 dBm0-class
 * TX amplitude from `FskCommon.js`.
 */

const { EventEmitter }                                = require('events');
const config                                          = require('../../../config');
const { FskModulator, CoherentFskDemodulator }        = require('./FskCommon');

const V23CFG = config.modem.native.carriers.V23;

// V.23 baud rates (per ITU-T V.23 Mode 2 — the asymmetric mode;
// Mode 1 / 600 baud is not implemented here, matching spandsp).
const V23_FORWARD_BAUD  = 1200;
const V23_BACKWARD_BAUD = 75;

class V23 extends EventEmitter {
  constructor(role) {
    super();
    const isAnswer = role === 'answer';

    // Answer side acts as the host: TX forward (1200), RX backward (75).
    // Originate side acts as the terminal: TX backward (75), RX forward (1200).
    if (isAnswer) {
      this.modulator = new FskModulator({
        markFreq:  V23CFG.forwardMark,
        spaceFreq: V23CFG.forwardSpace,
        baud:      V23_FORWARD_BAUD,
      });
      this.demodulator = new CoherentFskDemodulator({
        markFreq:  V23CFG.backwardMark,
        spaceFreq: V23CFG.backwardSpace,
        baud:      V23_BACKWARD_BAUD,
      });
    } else {
      this.modulator = new FskModulator({
        markFreq:  V23CFG.backwardMark,
        spaceFreq: V23CFG.backwardSpace,
        baud:      V23_BACKWARD_BAUD,
      });
      this.demodulator = new CoherentFskDemodulator({
        markFreq:  V23CFG.forwardMark,
        spaceFreq: V23CFG.forwardSpace,
        baud:      V23_FORWARD_BAUD,
      });
    }

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit',  bit));
  }

  /** Write data bytes to be transmitted (UART-framed: start + 8 data
   *  LSB-first + stop). */
  write(data)              { this.modulator.write(data); }

  /** Write raw bits (no UART framing). */
  writeBits(bits)          { this.modulator.writeBits(bits); }

  /** Generate n samples of transmit audio. */
  generateAudio(n)         { return this.modulator.generate(n); }

  /** Process received audio samples. */
  receiveAudio(samples)    { this.demodulator.process(samples); }

  /** True if RX carrier is currently detected. */
  get carrierDetected()    { return this.demodulator.carrierDetected; }

  get name() { return 'V23'; }

  /** Nominal forward-channel rate; data-mode throughput from the
   *  host's perspective. */
  get bps()  { return V23_FORWARD_BAUD; }
}

module.exports = { V23 };
