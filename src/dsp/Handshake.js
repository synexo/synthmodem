'use strict';

/**
 * Handshake Engine
 *
 * Manages the full modem handshake sequence from call connect to data mode.
 *
 * Answer mode sequence:
 *   1. Wait answerToneDelayMs
 *   2. Send ANS (2100 Hz) or ANSam (2100 Hz with phase reversals) — configurable
 *   3. Detect CI (Call Indicator) from originating modem via V.8
 *   4. Exchange JM/CM (Joint Menu / Call Menu) to negotiate protocol
 *   5. If V.8 times out → fall back to legacy (highest-speed FSK/QAM)
 *   6. Start protocol-specific training
 *   7. Emit 'connected' with negotiated protocol
 *
 * Originate mode sequence:
 *   1. Send CI tone (300 Hz silence + 600 Hz marks) — V.8 call indicator
 *   2. Detect ANSam from answer modem
 *   3. Send CM (Call Menu) with our capabilities
 *   4. Detect JM response, select common protocol
 *   5. Start training
 *   6. Emit 'connected'
 */

const { EventEmitter }    = require('events');
const config              = require('../../config');
const { makeLogger }      = require('../logger');
const {
  generateTone, generateANSam, goertzel, rms, mix
} = require('./Primitives');
const { V21 }             = require('./protocols/V21');
const { V22, V22bis }     = require('./protocols/V22');
const { V23, V32bis }     = require('./protocols/V32bis');
const { V34 }             = require('./protocols/V34');

const log = makeLogger('Handshake');
const SR  = config.rtp.sampleRate;
const cfg = config.modem;

// ─── Protocol registry ────────────────────────────────────────────────────────

const PROTOCOLS = {
  V21:    (role) => new V21(role),
  V22:    (role) => new V22(role),
  V22bis: (role) => new V22bis(role),
  V23:    (role) => new V23(role),
  V32bis: (role) => new V32bis(role),
  V34:    (role) => new V34(role),
};

// ─── V.8 CI (Call Indicator) detection ───────────────────────────────────────
// CI is a 1-second sequence of 100ms tones at specific frequencies
// ANSam detection: 2100 Hz burst with periodic phase reversals

const CI_FREQ  = 1300;   // V.8 CI primary frequency
const ANS_FREQ = 2100;   // ANS / ANSam
const DETECT_WINDOW_MS = 200;
const DETECT_SAMPLES   = Math.round(SR * DETECT_WINDOW_MS / 1000);
const DETECT_THRESHOLD = 0.03;

// ─── Handshake state machine ──────────────────────────────────────────────────

const HS_STATE = {
  IDLE:      'IDLE',
  ANS_SEND:  'ANS_SEND',     // Sending ANS/ANSam (answer)
  V8_WAIT:   'V8_WAIT',      // Waiting for CI/ANSam
  V8_JM:     'V8_JM',        // Exchanging JM/CM
  TRAINING:  'TRAINING',     // Protocol training
  DATA:      'DATA',         // In data mode
  FAILED:    'FAILED',
};

class HandshakeEngine extends EventEmitter {

  constructor(role) {
    super();
    this._role          = role;
    this._state         = HS_STATE.IDLE;
    this._protocol      = null;   // selected ModemProtocol instance
    this._protocolName  = null;
    this._audioQueue    = [];     // { samples: Float32Array, pos: number }
    this._detectBuf     = [];     // accumulate samples for detection
    this._startTime     = 0;
    this._timer         = null;
    this._v8Detected    = false;
    this._negotiatedProto = null;
    this._forced        = cfg.forceProtocol;
    // _advertise: limit CM advertisement without bypassing V.8
    if (cfg.advertiseProtocol && this._role === 'originate') {
      this._advertise = [cfg.advertiseProtocol];
    }
  }

  // ─── Start ──────────────────────────────────────────────────────────────────

  start() {
    this._state     = HS_STATE.IDLE;
    this._startTime = Date.now();
    log.info(`Handshake starting (${this._role})`);

    if (this._forced) {
      log.info(`Protocol forced to ${this._forced}`);
      // Both roles: bypass V.8 and go straight to protocol training.
      // This is used for direct protocol testing without negotiation.
      // In production, only the answer side uses _forced (from config.forceProtocol).
      // The originate side normally uses V.8 and sends a constrained CM.
      this._selectProtocol(this._forced);
      return;
    }

    if (this._role === 'answer') {
      this._timer = setTimeout(() => this._sendAnswerTone(), cfg.answerToneDelayMs);
    } else {
      this._sendCI();
    }
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._state = HS_STATE.IDLE;
    // Detach protocol to prevent stale timer callbacks from a stopped engine
    // from corrupting shared state when new protocol instances are created.
    if (this._protocol) {
      this._protocol.removeAllListeners();
      this._protocol = null;
    }
  }

  // ─── Audio generation ────────────────────────────────────────────────────────

  /**
   * Generate n samples of handshake audio (tones/training).
   * When in DATA state, delegates to the protocol modulator.
   */
  generateAudio(n) {
    if (this._state === HS_STATE.DATA && this._protocol) {
      return this._protocol.generateAudio(n);
    }
    // Drain audio queue
    return this._drainQueue(n);
  }

  _drainQueue(n) {
    const out = new Float32Array(n);
    let pos   = 0;
    while (pos < n && this._audioQueue.length > 0) {
      const item = this._audioQueue[0];
      const avail = item.samples.length - item.pos;
      const take  = Math.min(avail, n - pos);
      out.set(item.samples.subarray(item.pos, item.pos + take), pos);
      item.pos += take;
      pos += take;
      if (item.pos >= item.samples.length) this._audioQueue.shift();
    }
    // Remaining: silence
    return out;
  }

  _enqueue(samples) {
    this._audioQueue.push({ samples, pos: 0 });
  }

  _enqueueTone(freq, durationMs, amplitude = 0.45) {
    this._enqueue(generateTone(freq, durationMs, SR, amplitude));
  }

  _enqueueSilence(durationMs) {
    const n = Math.round(SR * durationMs / 1000);
    this._enqueue(new Float32Array(n));
  }

  // ─── Receive audio ───────────────────────────────────────────────────────────

  /**
   * Feed received audio samples through the handshake detector.
   * Once in DATA mode, delegates to protocol demodulator.
   */
  receiveAudio(samples) {
    if (this._state === HS_STATE.DATA && this._protocol) {
      this._protocol.receiveAudio(samples);
      return;
    }
    // During TRAINING: protocol is selected but DATA state not yet entered.
    // Feed audio to the protocol demodulator anyway so it can train on the
    // incoming carrier from the other side. This prevents a race where the
    // remote enters DATA mode and sends real data before our TRAINING timer
    // fires, causing the first bytes to be lost to the detection buffer.
    if (this._state === HS_STATE.TRAINING && this._protocol) {
      this._protocol.receiveAudio(samples);
      return;
    }
    // Accumulate for detection during handshake phases
    for (const s of samples) this._detectBuf.push(s);
    if (this._detectBuf.length >= DETECT_SAMPLES) {
      this._runDetection();
    }
  }

  _runDetection() {
    const buf = new Float32Array(this._detectBuf.splice(0, DETECT_SAMPLES));

    switch (this._state) {
      case HS_STATE.V8_WAIT:
        if (this._role === 'answer') {
          this._detectV8CI(buf);
        } else {
          this._detectANSam(buf);
        }
        break;
      case HS_STATE.V8_JM:
        if (this._role === 'answer') {
          this._detectJM(buf);
        }
        // originate: just wait for JM timer then select protocol
        break;
      case HS_STATE.TRAINING:
        break;
    }
  }

  // ─── Answer mode: send ANS / ANSam ───────────────────────────────────────────

  _sendAnswerTone() {
    this._state = HS_STATE.ANS_SEND;
    log.debug(`Sending ${cfg.useANSam ? 'ANSam' : 'ANS'} tone`);

    if (cfg.useANSam) {
      this._enqueue(generateANSam(
        cfg.answerToneDurationMs,
        SR,
        cfg.answerTonePhaseReversalMs,
        0.45
      ));
    } else {
      this._enqueueTone(ANS_FREQ, cfg.answerToneDurationMs);
    }

    // Enter V8_WAIT immediately — CI can arrive while we are still sending ANSam.
    // The originate side starts sending CI as soon as it connects, so we must
    // start listening right away, not wait until after the tone finishes.
    if (cfg.enableV8) {
      this._state = HS_STATE.V8_WAIT;
      log.debug(`V.8 enabled — listening for CI while sending ANSam`);
      this._timer = setTimeout(() => this._v8Timeout(), cfg.v8HandshakeTimeoutMs);
    } else {
      // After tone finishes, start legacy training
      this._timer = setTimeout(() => {
        log.debug('V.8 disabled — starting legacy training');
        this._selectProtocol(cfg.protocolPreference[0]);
      }, cfg.answerToneDurationMs + 200);
    }
  }

  // ─── V.8 CI detection (answer side) ─────────────────────────────────────────

  _detectV8CI(buf) {
    // CI is a burst sequence at ~1300 Hz.
    // Run detector on each 50ms sub-window for faster response.
    const step = Math.round(SR * 0.05);
    for (let off = 0; off + step <= buf.length; off += step) {
      const slice    = buf.subarray ? buf.subarray(off, off + step) : buf.slice(off, off + step);
      const ciPower  = goertzel(slice, CI_FREQ, SR);
      const ansPower = goertzel(slice, ANS_FREQ, SR);
      log.trace(`CI detector: CI=${ciPower.toFixed(4)} ANS=${ansPower.toFixed(4)}`);

      // Ignore our own ANSam reflection — only react if CI >> ANS
      if (ciPower > DETECT_THRESHOLD && ciPower > ansPower * 1.5) {
        log.info('V.8 CI detected — sending JM');
        this._v8Detected = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        // Small delay to let CI burst finish before we reply
        setTimeout(() => this._sendJM(), 150);
        return;
      }
    }
  }

  // ─── V.8 JM (Joint Menu) — advertise our protocol capabilities ───────────────

  _sendJM() {
    this._state = HS_STATE.V8_JM;

    // Persistent V.21 decoder for CM detection.
    // CI tones (1300 Hz) don't produce valid V.21 decode events.
    // The actual CM audio (V.21 ch1 FSK) will be decoded correctly once it arrives.
    // We scan all received audio continuously — no per-window re-init needed.
    this._cmDecoder = PROTOCOLS['V21']('answer');
    this._cmBytes   = [];
    this._cmDecoder.on('data', b => {
      this._cmBytes.push(...b);
      // Anchor on the 0xFF terminator. The byte immediately before it is the
      // capability byte. The V.21 decoder may corrupt leading null bytes due to
      // initial sync, so we don't rely on the [0x00, 0x00] preamble.
      // A valid CM must have: capByte > 0, capByte < 0xFF, followed by 0xFF.
      const cb = this._cmBytes;
      const map = { V34: 0x80, V32bis: 0x40, V22bis: 0x20, V22: 0x10, V23: 0x08, V21: 0x04 };
      const knownBits = 0x80 | 0x40 | 0x20 | 0x10 | 0x08 | 0x04;
      for (let i = 1; i < cb.length; i++) {
        if (cb[i] === 0xFF) {
          const cmByte = cb[i - 1];
          // Validate: must have at least one known protocol bit, and no unknown bits
          if (cmByte > 0 && (cmByte & knownBits) !== 0) {
            log.debug('CM decoded by persistent decoder: capability byte = 0x' + cmByte.toString(16));
            if (this._timer) { clearTimeout(this._timer); this._timer = null; }
            let chosen = cfg.protocolPreference[cfg.protocolPreference.length - 1];
            for (const proto of cfg.protocolPreference) {
              if ((cmByte & (map[proto] || 0)) !== 0) { chosen = proto; break; }
            }
            log.info('Negotiated protocol: ' + chosen + ' (CM byte=0x' + cmByte.toString(16) + ')');
            this._cmDecoder = null;
            this._cmBytes   = null;
            this._selectProtocol(chosen);
            return;
          }
        }
      }
      // Cap buffer size to avoid unbounded growth
      if (cb.length > 32) this._cmBytes = cb.slice(-16);
    });

    const jmProtos = cfg.v8ModulationModes;
    log.debug(`Sending JM advertising: ${jmProtos.join(', ')}`);

    // JM: use V.21 channel 2 to carry capability bytes
    const jmCoder = PROTOCOLS['V21']('answer');
    const jmBytes = this._encodeJM(jmProtos);
    jmCoder.write(jmBytes);
    const jmAudio = jmCoder.generateAudio(Math.round(SR * 0.25));
    this._enqueue(jmAudio);

    // Arm timeout waiting for CM
    this._timer = setTimeout(() => this._v8Timeout(), cfg.v8HandshakeTimeoutMs);
  }

  _detectJM(buf) {
    // Feed received audio into the persistent V.21 CM decoder.
    // The decoder runs continuously across all 200ms detection windows.
    // When it decodes the CM framing [0x00, 0x00, capByte, 0xFF], the
    // 'data' listener on this._cmDecoder fires and calls _selectProtocol().
    // CI tones (1300 Hz) do not produce valid V.21 decode events, so they
    // are naturally ignored without any frequency guard needed.
    if (this._cmDecoder) {
      this._cmDecoder.receiveAudio(buf);
    }
  }


  _v8Timeout() {
    const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
    log.warn(`V.8 handshake timeout — falling back to ${fallback}`);
    this._selectProtocol(fallback);
  }

  // ─── Originate mode: send CI and detect ANSam ────────────────────────────────

  _sendCI() {
    this._state = HS_STATE.V8_WAIT;
    log.debug('Sending CI (Call Indicator)');

    // CI: repeated 100ms bursts at 1300 Hz with 100ms gaps.
    // Send for longer than the answer tone delay so we are still sending
    // when the answer side starts listening.
    const totalCiMs  = cfg.answerToneDelayMs + cfg.answerToneDurationMs + 500;
    const repetitions = Math.ceil(totalCiMs / 200);
    for (let i = 0; i < repetitions; i++) {
      this._enqueueTone(CI_FREQ, 100, 0.4);
      this._enqueueSilence(100);
    }

    // Also detect ANSam coming back so we can respond with CM
    this._ansDetectCount = 0;

    this._timer = setTimeout(() => this._v8Timeout(), totalCiMs + cfg.v8HandshakeTimeoutMs);
  }

  // Originate side: detect ANSam in received audio, then send CM
  _detectANSam(buf) {
    const ansPower = goertzel(buf, ANS_FREQ, SR);
    log.trace(`ANSam detector: power=${ansPower.toFixed(4)}`);
    if (ansPower > DETECT_THRESHOLD) {
      this._ansDetectCount = (this._ansDetectCount || 0) + 1;
      if (this._ansDetectCount >= 3) {  // require 3 consecutive detections
        log.info('ANSam detected — sending CM');
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        // Flush the CI tone queue so the answer side stops seeing CI energy
        // during the JM exchange window — otherwise the answer mistakes
        // leftover CI tones for CM content and picks the wrong protocol.
        this._audioQueue = [];
        this._sendCM();
      }
    } else {
      this._ansDetectCount = 0;
    }
  }

  _sendCM() {
    // CM (Call Menu): advertise capabilities. If forced to a specific protocol,
    // only advertise that one so the answer side picks correctly.
    // _advertise allows the originate to limit what it advertises in the CM
    // without bypassing V.8 entirely (unlike _forced which skips V.8 completely).
    const advertised = this._advertise || cfg.v8ModulationModes;
    const cmCoder = PROTOCOLS['V21']('originate');
    const cmBytes = this._encodeJM(advertised);
    cmCoder.write(cmBytes);
    const cmAudio = cmCoder.generateAudio(Math.round(SR * 0.25));
    this._enqueue(cmAudio);

    log.debug(`CM sent advertising: ${advertised.join(', ')} — selecting after JM exchange`);
    this._state = HS_STATE.V8_JM;
    // Give answerer time to receive CM, then select the negotiated protocol
    const chosenProto = this._forced || (this._advertise && this._advertise[0]) || cfg.protocolPreference[0];
    this._timer = setTimeout(() => {
      log.debug('JM exchange complete — selecting protocol');
      this._selectProtocol(chosenProto);
    }, 600);
  }

  // ─── Protocol selection and training ─────────────────────────────────────────

  _selectProtocol(name) {
    log.info(`Selecting protocol: ${name}`);
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    this._protocolName = name;
    this._protocol = PROTOCOLS[name]
      ? PROTOCOLS[name](this._role)
      : PROTOCOLS['V21'](this._role);

    this._protocol.on('data', buf => this.emit('data', buf));

    // If V.34, let it drive its own handshake internals
    if (name === 'V34' && this._protocol.startHandshake) {
      this._protocol.startHandshake();
    }

    // Start training
    this._state = HS_STATE.TRAINING;
    const trainMs = cfg.trainingDurationMs[name] || 600;
    log.debug(`Training for ${trainMs}ms`);

    // Generate training sequence via the protocol itself
    const trainSamples = Math.round(SR * trainMs / 1000);

    // Enqueue training audio (silence for protocols without specific training audio)
    if (trainSamples > 0) {
      const trainAudio = this._protocol.generateAudio
        ? this._protocol.generateAudio(trainSamples)
        : new Float32Array(trainSamples);
      this._enqueue(trainAudio);
    }

    // Transition to data mode after training
    this._timer = setTimeout(() => {
      this._state = HS_STATE.DATA;
      log.info(`Handshake complete — ${name} @ ${this._protocol.bps || '?'} bps`);
      this.emit('connected', {
        protocol: name,
        bps:      this._protocol.bps || 0,
        instance: this._protocol,
      });
    }, trainMs + 100);
  }

  // ─── Data mode passthrough ────────────────────────────────────────────────────

  write(data) {
    if (this._protocol) this._protocol.write(data);
  }

  // ─── V.8 JM encoding (simplified) ────────────────────────────────────────────

  _encodeJM(protocols) {
    // Simplified: encode protocol list as ASCII for simulation purposes
    // Real V.8 JM uses specific bit fields defined in ITU-T V.8
    const map = { V34: 0x80, V32bis: 0x40, V22bis: 0x20, V22: 0x10, V23: 0x08, V21: 0x04 };
    let byte = 0;
    for (const p of protocols) byte |= (map[p] || 0);
    return Buffer.from([0x00, 0x00, byte, 0xFF]); // framing + capability + terminator
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  get state()    { return this._state; }
  get protocol() { return this._protocolName; }
  get isData()   { return this._state === HS_STATE.DATA; }
}

module.exports = { HandshakeEngine, PROTOCOLS };
