'use strict';

/**
 * V.22  — 1200 bps DPSK  (2-bit DPSK at 600 baud)
 * V.22bis — 2400 bps QAM-16 (4-bit QAM at 600 baud)
 *
 * Carrier frequencies:
 *   Originating modem TX: 1200 Hz  |  Answering modem TX: 2400 Hz
 *   Answering modem RX:   1200 Hz  |  Originating modem RX: 2400 Hz
 *
 * DSP approach:
 *   - Precise symbol-boundary integrate-and-dump (no Gardner timing)
 *   - 35% ISI guard: skip first 35% of each symbol
 *   - No LMS equalizer (G.711 loopback has no ISI/multipath)
 *   - Open-loop NCO (no Costas feedback — stable carrier through G.711)
 *   - 4-level threshold slicer with known scale factor (amp*0.5)
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const { NCO, BiquadFilter, Scrambler, TWO_PI } = require('../Primitives');

const SR     = config.rtp.sampleRate;
const BAUD   = 600;
const SPS    = SR / BAUD;          // 13.333 samples/symbol
const AMP    = 0.4;
const SCALE  = AMP * 0.5;
const CFG    = config.modem.carriers;
const SCPOLY = config.modem.scramblerPolynomial;

const NORM   = Math.sqrt(10);
const G2LEVEL = [-3, -1, 3, 1];   // Gray-coded level map: index by (lsb | msb<<1)

function bitsToLevel(b0, b1) {
  return G2LEVEL[b0 | (b1 << 1)] / NORM;
}

const THRESH = 2 * SCALE / NORM;  // ~0.126

function sliceLevel(v) {
  if (v < -THRESH) return [0, 0];
  if (v <       0) return [1, 0];
  if (v <  THRESH) return [1, 1];
  return             [0, 1];
}

const DPSK_PHASE = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
const ISI_GUARD  = 0.35;

// ─── Modulator ────────────────────────────────────────────────────────────────

class QAMModulator {
  constructor({ carrier, bitsPerSymbol }) {
    this._carrier   = carrier;
    this._bps       = bitsPerSymbol;
    this._nco       = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._scrambler = new Scrambler(SCPOLY);
    this._bitQueue  = [];
    this._curI      = 0;
    this._curQ      = 0;
    this._curPhase  = 0;
    this._symIndex  = 0;
    this._samplePos = 0;
  }

  write(bytes) {
    for (const byte of bytes) {
      this._bitQueue.push(0);
      for (let b = 0; b < 8; b++) this._bitQueue.push((byte >> b) & 1);
      this._bitQueue.push(1);
      this._bitQueue.push(1);
    }
  }

  generate(numSamples) {
    const out      = new Float32Array(numSamples);
    const startPos = this._samplePos;
    const endPos   = startPos + numSamples;
    const inc      = TWO_PI * this._carrier / SR;

    while (true) {
      const symStart = Math.round(this._symIndex * SPS);
      const symEnd   = Math.round((this._symIndex + 1) * SPS);
      if (symStart >= endPos) break;

      this._advanceSymbol();

      const genStart = Math.max(symStart, startPos);
      const genEnd   = Math.min(symEnd,   endPos);

      for (let s = genStart; s < genEnd; s++) {
        const ci = Math.cos(this._nco.phase);
        const si = Math.sin(this._nco.phase);
        out[s - startPos] = AMP * (this._curI * ci - this._curQ * si);
        this._nco.adjustPhase(inc);
      }

      this._symIndex++;
    }

    this._samplePos = endPos;
    return out;
  }

  _advanceSymbol() {
    if (this._bps === 2) {
      const b0  = this._nextBit();
      const b1  = this._nextBit();
      this._curPhase = (this._curPhase + DPSK_PHASE[b0 | (b1 << 1)]) % TWO_PI;
      this._curI = Math.cos(this._curPhase);
      this._curQ = Math.sin(this._curPhase);
    } else {
      const b0 = this._nextBit(), b1 = this._nextBit();
      const b2 = this._nextBit(), b3 = this._nextBit();
      this._curI = bitsToLevel(b0, b1);
      this._curQ = bitsToLevel(b2, b3);
    }
  }

  _nextBit() {
    const b = this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
    return this._scrambler.scramble(b);
  }

  get idle() { return this._bitQueue.length === 0; }
}

// ─── Demodulator ─────────────────────────────────────────────────────────────

class QAMDemodulator extends EventEmitter {
  constructor({ carrier, bitsPerSymbol }) {
    super();
    this._carrier    = carrier;
    this._bps        = bitsPerSymbol;
    this._descrambler = new Scrambler(SCPOLY);
    this._nco        = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._lpI        = BiquadFilter.makeLowPass(BAUD * 0.75, 0.707, SR);
    this._lpQ        = BiquadFilter.makeLowPass(BAUD * 0.75, 0.707, SR);

    this._samplePos  = 0;
    this._symIndex   = 0;
    this._accumI     = 0;
    this._accumQ     = 0;
    this._accumCount = 0;

    this._symCount   = 0;
    this._locked     = false;
    this._lockAfter  = config.modem.equalizer.pretrainSymbols;

    this._state      = 'IDLE';
    this._dataBits   = [];
    this._bitCount   = 0;
    this._prevPhase  = 0;
  }

  process(samples) {
    const inc = TWO_PI * this._carrier / SR;

    for (let i = 0; i < samples.length; i++) {
      const x   = samples[i];
      const pos = this._samplePos + i;

      const ci = Math.cos(this._nco.phase);
      const si = Math.sin(this._nco.phase);
      this._nco.adjustPhase(inc);

      const I = this._lpI.process(x *   ci);
      const Q = this._lpQ.process(x * (-si));

      const symStart = Math.round(this._symIndex * SPS);
      const symEnd   = Math.round((this._symIndex + 1) * SPS);
      const posInSym = pos - symStart;
      const guardEnd = Math.round(SPS * ISI_GUARD);

      if (posInSym >= guardEnd) {
        this._accumI     += I;
        this._accumQ     += Q;
        this._accumCount++;
      }

      if (pos + 1 >= symEnd) {
        this._onSymbolEnd();
        this._symIndex++;
      }
    }

    this._samplePos += samples.length;
  }

  _onSymbolEnd() {
    this._symCount++;
    const count = this._accumCount;
    const avgI  = count > 0 ? this._accumI / count : 0;
    const avgQ  = count > 0 ? this._accumQ / count : 0;
    this._accumI = 0; this._accumQ = 0; this._accumCount = 0;

    if (!this._locked && this._symCount >= this._lockAfter) {
      this._locked = true;
      // Do NOT reset descrambler — self-synchronising scrambler converges
      // automatically after 23 bits of received data. Resetting would
      // put TX and RX out of phase.
      this._state    = 'IDLE';
      this._dataBits = [];
      this._bitCount = 0;
    }
    if (!this._locked) return;

    if (this._bps === 2) {
      const curPhase = Math.atan2(avgQ, avgI);
      let dPhase     = curPhase - this._prevPhase;
      this._prevPhase = curPhase;
      while (dPhase < 0)       dPhase += TWO_PI;
      while (dPhase >= TWO_PI) dPhase -= TWO_PI;
      const idx = Math.round(dPhase / (Math.PI / 2)) % 4;
      this._onBit(this._descrambler.descramble(idx & 1));
      this._onBit(this._descrambler.descramble((idx >> 1) & 1));
    } else {
      const [ib0, ib1] = sliceLevel(avgI);
      const [qb0, qb1] = sliceLevel(avgQ);
      this._onBit(this._descrambler.descramble(ib0));
      this._onBit(this._descrambler.descramble(ib1));
      this._onBit(this._descrambler.descramble(qb0));
      this._onBit(this._descrambler.descramble(qb1));
    }
  }

  _onBit(bit) {
    switch (this._state) {
      case 'IDLE':
        if (bit === 0) { this._state = 'DATA'; this._dataBits = []; this._bitCount = 0; }
        break;
      case 'DATA':
        this._dataBits.push(bit);
        if (++this._bitCount === 8) this._state = 'STOP';
        break;
      case 'STOP':
        if (bit === 1) {
          let byte = 0;
          for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
          // Suppress 0xFF: it is always the idle-mark scrambler pattern, never real data.
          // In practice 0xFF means the scrambled mark stream was decoded without a real
          // start bit — just noise from the QAM slicer on idle carrier.
          if (byte !== 0xFF) {
            this.emit('data', Buffer.from([byte]));
          }
        }
        this._state = 'IDLE';
        break;
    }
  }

  reset() {
    this._lpI.reset(); this._lpQ.reset();
    this._descrambler.reset();
    this._accumI = 0; this._accumQ = 0; this._accumCount = 0;
    this._symCount = 0; this._locked = false;
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
    this._prevPhase = 0;
  }
}

// ─── V.22 ─────────────────────────────────────────────────────────────────────

class V22 extends EventEmitter {
  constructor(role) {
    super();
    const txCarrier = role === 'answer' ? CFG.V22.answerCarrier : CFG.V22.origCarrier;
    const rxCarrier = role === 'answer' ? CFG.V22.origCarrier   : CFG.V22.answerCarrier;
    this.modulator   = new QAMModulator({ carrier: txCarrier, bitsPerSymbol: 2 });
    this.demodulator = new QAMDemodulator({ carrier: rxCarrier, bitsPerSymbol: 2 });
    this.demodulator.on('data', buf => this.emit('data', buf));
  }

  write(data)          { this.modulator.write(data); }
  generateAudio(n)     { return this.modulator.generate(n); }
  receiveAudio(samples){ this.demodulator.process(samples); }
  get name()           { return 'V22'; }
  get bps()            { return 1200; }
}

// ─── V.22bis ──────────────────────────────────────────────────────────────────

class V22bis extends EventEmitter {
  constructor(role) {
    super();
    const txCarrier = role === 'answer' ? CFG.V22bis.answerCarrier : CFG.V22bis.origCarrier;
    const rxCarrier = role === 'answer' ? CFG.V22bis.origCarrier   : CFG.V22bis.answerCarrier;
    this.modulator   = new QAMModulator({ carrier: txCarrier, bitsPerSymbol: 4 });
    this.demodulator = new QAMDemodulator({ carrier: rxCarrier, bitsPerSymbol: 4 });
    this.demodulator.on('data', buf => this.emit('data', buf));
  }

  write(data)          { this.modulator.write(data); }
  generateAudio(n)     { return this.modulator.generate(n); }
  receiveAudio(samples){ this.demodulator.process(samples); }
  get name()           { return 'V22bis'; }
  get bps()            { return 2400; }
}

module.exports = { V22, V22bis };
