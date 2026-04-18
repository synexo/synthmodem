'use strict';

/**
 * ModemDSP — top-level DSP coordinator
 *
 * Sits between the RTP session (Float32Array audio) and the modem protocols.
 * Responsibilities:
 *  - AGC on inbound audio
 *  - Drive HandshakeEngine generate/receive cycle
 *  - Emit 'data' events when decoded bytes arrive (post-connect)
 *  - Accept write(buf) calls and modulate them to audio
 *  - Emit 'audioOut' events with Float32Array to be sent via RTP
 *  - Detect silence/hangup
 */

const { EventEmitter }    = require('events');
const config              = require('../../config');
const { makeLogger }      = require('../logger');
const { AGC, rms }        = require('./Primitives');
const { HandshakeEngine } = require('./Handshake');

const log  = makeLogger('ModemDSP');
const cfg  = config.modem;
const rcfg = config.rtp;

const BLOCK = rcfg.packetIntervalMs * rcfg.sampleRate / 1000; // 160 samples at 20ms/8kHz

class ModemDSP extends EventEmitter {

  constructor(role) {
    super();
    this._role        = role || cfg.role;
    this._agc         = new AGC(cfg);
    this._handshake   = new HandshakeEngine(this._role);
    this._connected   = false;
    this._silentPkts  = 0;
    this._txTimer     = null;
    this._started     = false;
    this._rxBuf       = [];   // overflow buffer for received audio

    // Wire up events
    this._handshake.on('connected', info => {
      this._connected = true;
      log.info(`Modem connected: ${info.protocol} @ ${info.bps} bps`);
      this.emit('connected', info);
    });

    this._handshake.on('data', buf => {
      if (config.logging.logModemData) {
        log.trace(`Modem data RX: ${buf.toString('hex')}`);
      }
      this.emit('data', buf);
    });
  }

  // ─── Start / stop ────────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    log.debug(`ModemDSP starting (${this._role})`);
    this._handshake.start();

    // TX timer — generate one block of audio per packet interval
    this._txTimer = setInterval(() => this._txTick(), rcfg.packetIntervalMs);
  }

  stop() {
    this._started = false;
    if (this._txTimer) { clearInterval(this._txTimer); this._txTimer = null; }
    this._handshake.stop();
  }

  // ─── TX path ─────────────────────────────────────────────────────────────────

  _txTick() {
    const audio = this._handshake.generateAudio(BLOCK);
    this.emit('audioOut', audio);
  }

  /**
   * Write data bytes to be transmitted.
   * Only valid after 'connected' event.
   */
  write(data) {
    if (!this._connected) {
      log.warn('write() called before modem connected — buffering not implemented');
      return;
    }
    if (config.logging.logModemData) {
      log.trace(`Modem data TX: ${data.toString('hex')}`);
    }
    this._handshake.write(data);
  }

  // ─── RX path ─────────────────────────────────────────────────────────────────

  /**
   * Feed received audio samples from RTP.
   * @param {Float32Array} samples
   */
  receiveAudio(samples) {
    if (!this._started) return;

    // AGC
    const processed = cfg.agcEnabled ? this._agc.process(samples) : samples;

    // Silence detection
    const level = rms(processed);
    if (level < cfg.silenceThreshold) {
      this._silentPkts++;
      if (this._silentPkts >= cfg.silenceHangupPackets) {
        log.warn(`${this._silentPkts} silent packets — emitting silence-hangup`);
        this.emit('silenceHangup');
        this._silentPkts = 0;
      }
    } else {
      this._silentPkts = 0;
    }

    this._handshake.receiveAudio(processed);
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  get connected()    { return this._connected; }
  get handshakeState() { return this._handshake.state; }
  get protocol()     { return this._handshake.protocol; }
}

module.exports = { ModemDSP };
