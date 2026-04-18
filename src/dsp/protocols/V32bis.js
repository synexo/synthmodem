'use strict';

/**
 * V.23  — 1200/75 bps split-speed FSK
 * V.32bis — 7200 bps QAM-64 at 1200 baud (6 bits/symbol)
 *
 * V.32bis at full spec uses 2400 baud — but at 8kHz RTP sample rate that gives
 * only 3.33 samples/symbol, which is insufficient for reliable SW demodulation.
 * We use 1200 baud (6.67 sps) with 6 bits/symbol = 7200 bps effective rate.
 * This is still 3x faster than V.22bis (2400 bps) and achieves the desired
 * "high speed" tier. Carrier separation: answer=1800 Hz, originate=1200 Hz.
 *
 * V.23 and V.32bis use the same integrate-and-dump demodulator pattern as V.22bis.
 */

const { EventEmitter } = require('events');
const config           = require('../../../config');
const { NCO, BiquadFilter, SinglePoleLPF, Scrambler, TWO_PI } = require('../Primitives');

const SR     = config.rtp.sampleRate;
const SCPOLY = config.modem.scramblerPolynomial;
const V23CFG = config.modem.carriers.V23;

// ─── V.23 FSK ─────────────────────────────────────────────────────────────────

class V23FSKModulator {
  constructor({ markFreq, spaceFreq, baud }) {
    this._mark  = markFreq;
    this._space = spaceFreq;
    this._baud  = baud;
    this._sps   = SR / baud;
    this._bitQueue   = [];
    this._samplesLeft = 0;
    this._curFreq    = markFreq;
    this._phase      = 0;
    this._amp        = 0.4;
  }

  write(bytes) {
    for (const byte of bytes) {
      this._bitQueue.push(0);
      for (let b = 0; b < 8; b++) this._bitQueue.push((byte >> b) & 1);
      this._bitQueue.push(1);
    }
  }

  generate(n) {
    const out = new Float32Array(n);
    let pos = 0;
    while (pos < n) {
      if (this._samplesLeft <= 0) {
        const bit = this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
        this._curFreq     = bit === 1 ? this._mark : this._space;
        this._samplesLeft = Math.round(this._sps);
      }
      const chunk = Math.min(this._samplesLeft, n - pos);
      const inc   = TWO_PI * this._curFreq / SR;
      for (let i = 0; i < chunk; i++) {
        out[pos + i] = this._amp * Math.cos(this._phase);
        this._phase = (this._phase + inc) % TWO_PI;
      }
      this._samplesLeft -= chunk;
      pos += chunk;
    }
    return out;
  }

  get idle() { return this._bitQueue.length === 0; }
}

class V23FSKDemodulator extends EventEmitter {
  constructor({ markFreq, spaceFreq, baud }) {
    super();
    this._baud = baud;
    this._sps  = SR / baud;
    const Q = 12;
    this._bpMark  = BiquadFilter.makeBandPass(markFreq,  Q, SR);
    this._bpSpace = BiquadFilter.makeBandPass(spaceFreq, Q, SR);
    const alpha = 1 - Math.exp(-TWO_PI * baud / SR);
    this._envM = new SinglePoleLPF(alpha);
    this._envS = new SinglePoleLPF(alpha);
    this._sampleCount = 0;
    this._samplesPerSym = Math.round(this._sps);
    this._state = 'IDLE'; this._dataBits = []; this._bitCount = 0;
  }

  process(samples) {
    for (const x of samples) {
      const m = this._envM.process(Math.abs(this._bpMark.process(x)));
      const s = this._envS.process(Math.abs(this._bpSpace.process(x)));
      const bit = m > s ? 1 : 0;
      if (++this._sampleCount >= this._samplesPerSym) {
        this._onBit(bit);
        this._sampleCount = 0;
      }
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
          if (byte !== 0xFF) {
            this.emit('data', Buffer.from([byte]));
          }
        }
        this._state = 'IDLE';
        break;
    }
  }
}

class V23 extends EventEmitter {
  constructor(role) {
    super();
    const isAnswer = role === 'answer';
    this.modulator = new V23FSKModulator(
      isAnswer
        ? { markFreq: V23CFG.forwardMark,  spaceFreq: V23CFG.forwardSpace,  baud: 1200 }
        : { markFreq: V23CFG.backwardMark, spaceFreq: V23CFG.backwardSpace, baud: 75   }
    );
    this.demodulator = new V23FSKDemodulator(
      isAnswer
        ? { markFreq: V23CFG.backwardMark, spaceFreq: V23CFG.backwardSpace, baud: 75   }
        : { markFreq: V23CFG.forwardMark,  spaceFreq: V23CFG.forwardSpace,  baud: 1200 }
    );
    this.demodulator.on('data', buf => this.emit('data', buf));
  }

  write(data)           { this.modulator.write(data); }
  generateAudio(n)      { return this.modulator.generate(n); }
  receiveAudio(samples) { this.demodulator.process(samples); }
  get name()            { return 'V23'; }
  get bps()             { return 1200; }
}

// ─── V.32bis 64-QAM at 1200 baud ─────────────────────────────────────────────
// 8 levels per axis (±1,±3,±5,±7) → 3 bits per axis → 6 bits/symbol
// At 1200 baud: 7200 bps effective rate
// Role-separated carriers: answer=1800 Hz, originate=1200 Hz

const V32_BAUD   = 600;
const V32_SPS    = SR / V32_BAUD;   // 13.333 samples/symbol
const V32_AMP    = 0.35;
const V32_NORM   = Math.sqrt((1+9+25+49)*2/8); // RMS of ±1,±3,±5,±7
const V32_SCALE  = V32_AMP * 0.5;
const ISI_GUARD  = 0.35;

// 8-level natural-binary mapper: 3 bits (LSB first) → level value
// Level order: -7 -5 -3 -1 +1 +3 +5 +7  (indices 0..7)
const V32_SORTED_LEVELS = [-7, -5, -3, -1, 1, 3, 5, 7];
const V32_T = [2, 4, 6].map(t => V32_SCALE * t / V32_NORM); // midpoints between adjacent levels

function bitsToLevel8(b0, b1, b2) {
  return V32_SORTED_LEVELS[b0 | (b1 << 1) | (b2 << 2)] / V32_NORM;
}

function sliceLevel8(v) {
  const av = Math.abs(v);
  let idx;
  if (v < 0) {
    if      (av < V32_T[0]) idx = 3;   // -1
    else if (av < V32_T[1]) idx = 2;   // -3
    else if (av < V32_T[2]) idx = 1;   // -5
    else                    idx = 0;   // -7
  } else {
    if      (av < V32_T[0]) idx = 4;   // +1
    else if (av < V32_T[1]) idx = 5;   // +3
    else if (av < V32_T[2]) idx = 6;   // +5
    else                    idx = 7;   // +7
  }
  return [idx & 1, (idx >> 1) & 1, (idx >> 2) & 1];
}

class V32bisModulator {
  constructor(role) {
    const carrier = role === 'answer'
      ? config.modem.carriers.V32bis.answerCarrier
      : config.modem.carriers.V32bis.originateCarrier;
    this._carrier   = carrier;
    this._nco       = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._scrambler = new Scrambler(SCPOLY);
    this._bitQueue  = [];
    this._curI      = 0;
    this._curQ      = 0;
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
      const symStart = Math.round(this._symIndex * V32_SPS);
      const symEnd   = Math.round((this._symIndex + 1) * V32_SPS);
      if (symStart >= endPos) break;

      // Get 6 bits for this symbol
      const sc = this._scrambler;
      const b = [];
      for (let i = 0; i < 6; i++) {
        const raw = this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
        b.push(sc.scramble(raw));
      }
      this._curI = bitsToLevel8(b[0], b[1], b[2]);
      this._curQ = bitsToLevel8(b[3], b[4], b[5]);

      const genStart = Math.max(symStart, startPos);
      const genEnd   = Math.min(symEnd,   endPos);
      for (let s = genStart; s < genEnd; s++) {
        const ci = Math.cos(this._nco.phase);
        const si = Math.sin(this._nco.phase);
        out[s - startPos] = V32_AMP * (this._curI * ci - this._curQ * si);
        this._nco.adjustPhase(inc);
      }

      this._symIndex++;
    }

    this._samplePos = endPos;
    return out;
  }

  get idle() { return this._bitQueue.length === 0; }
}

class V32bisDemodulator extends EventEmitter {
  constructor(role) {
    super();
    const carrier = role === 'answer'
      ? config.modem.carriers.V32bis.originateCarrier   // receive originate TX
      : config.modem.carriers.V32bis.answerCarrier;     // receive answer TX
    this._carrier    = carrier;
    this._descrambler = new Scrambler(SCPOLY);
    this._nco        = new NCO(SR);
    this._nco.setFrequency(carrier);
    this._lpI        = BiquadFilter.makeLowPass(V32_BAUD * 0.75, 0.707, SR);
    this._lpQ        = BiquadFilter.makeLowPass(V32_BAUD * 0.75, 0.707, SR);

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

      const symStart = Math.round(this._symIndex * V32_SPS);
      const symEnd   = Math.round((this._symIndex + 1) * V32_SPS);
      const posInSym = pos - symStart;
      const guardEnd = Math.round(V32_SPS * ISI_GUARD);

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
      // Do NOT reset descrambler — self-synchronising
      this._state    = 'IDLE';
      this._dataBits = [];
      this._bitCount = 0;
    }
    if (!this._locked) return;

    const dc    = this._descrambler;
    const [ib0, ib1, ib2] = sliceLevel8(avgI);
    const [qb0, qb1, qb2] = sliceLevel8(avgQ);
    for (const bit of [ib0,ib1,ib2,qb0,qb1,qb2]) this._onBit(dc.descramble(bit));
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
  }
}

class V32bis extends EventEmitter {
  constructor(role) {
    super();
    this.modulator   = new V32bisModulator(role);
    this.demodulator = new V32bisDemodulator(role);
    this.demodulator.on('data', buf => this.emit('data', buf));
  }

  write(data)           { this.modulator.write(data); }
  generateAudio(n)      { return this.modulator.generate(n); }
  receiveAudio(samples) { this.demodulator.process(samples); }
  get name()            { return 'V32bis'; }
  get bps()             { return 3600; }
}

module.exports = { V23, V32bis };
