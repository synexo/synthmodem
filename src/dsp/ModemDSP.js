'use strict';

/**
 * ModemDSP — top-level DSP coordinator
 *
 * Sits between the RTP session (Float32Array audio) and the modem protocols.
 * Responsibilities:
 *  - Drive HandshakeEngine generate/receive cycle
 *  - Emit 'data' events when decoded bytes arrive (post-connect)
 *  - Accept write(buf) calls and modulate them to audio
 *  - Emit 'audioOut' events with Float32Array to be sent via RTP
 *  - Detect silence/hangup
 *
 * ── TX pacing note ──────────────────────────────────────────────────────
 *
 * On Windows, Node.js setInterval with short intervals (≤20 ms) has poor
 * timer resolution — Win32 default timer resolution is 15.6 ms and the
 * actual inter-firing interval is highly variable. A naive
 * setInterval(_txTick, 20) produces TX output at only 65-75% of wall-
 * clock rate, which manifests as gaps and compressions on the RTP wire
 * and destroys the bit timing of the modem's V.21 demodulator.
 *
 * The TX path now uses a wall-clock catch-up loop: on each timer fire,
 * compute how much audio *should* have been produced by now based on
 * the elapsed wall-clock time, and generate exactly that much. If a
 * previous tick was late, the next tick produces a longer block to
 * catch up. If ticks fire early, we generate nothing. This keeps
 * long-term throughput locked to real-time regardless of timer jitter.
 */

const { EventEmitter }    = require('events');
const config              = require('../../config');
const { makeLogger }      = require('../logger');
const { rms }             = require('./Primitives');
const { HandshakeEngine } = require('./Handshake');

const log  = makeLogger('ModemDSP');
const cfg  = config.modem;          // shared keys (role, captureAudio, …)
const ncfg = config.modem.native;   // native-only keys (silenceThreshold, …)
const rcfg = config.rtp;

const SR          = rcfg.sampleRate;          // 8000
const BLOCK       = rcfg.packetIntervalMs * SR / 1000; // 160 samples at 20ms/8kHz
const SAMPLES_PER_MS = SR / 1000;

class ModemDSP extends EventEmitter {

  constructor(role) {
    super();
    this._role        = role || cfg.role;
    this._handshake   = new HandshakeEngine(this._role);
    this._connected   = false;
    this._silentPkts  = 0;
    this._txTimer     = null;
    this._started     = false;
    this._rxBuf       = [];   // overflow buffer for received audio

    // Wall-clock TX pacing.
    this._txStartMs       = 0;
    this._txSamplesEmitted = 0;

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

  /**
   * Start the modem DSP.
   *
   * @param {object} [opts] — passed through to HandshakeEngine.start.
   *     Notable fields:
   *       skipV8:    boolean — skip V.8/ANSam, jump to V.25 legacy probe
   *       skipAnsam: boolean — skip ANSam in V.8 mode (typically with skipV8)
   *     See HandshakeEngine.start for full documentation. Used by the
   *     `auto` backend in CallSession when falling through from a failed
   *     slmodemd-pjsip V.8 attempt.
   */
  start(opts) {
    if (this._started) return;
    this._started = true;
    log.debug(`ModemDSP starting (${this._role})${opts && opts.skipV8 ? ' [skipV8]' : ''}`);
    this._handshake.start(opts);

    // Wall-clock-paced TX. Tick more frequently than packetIntervalMs
    // (here: every 5ms) and generate only as much audio as wall-clock
    // has advanced, in BLOCK-sized chunks. This keeps long-term
    // throughput locked to real-time even if timer firing is jittery.
    this._txStartMs = Date.now();
    this._txSamplesEmitted = 0;
    this._txTimer = setInterval(() => this._txTick(), 5);
  }

  stop() {
    this._started = false;
    if (this._txTimer) { clearInterval(this._txTimer); this._txTimer = null; }
    this._handshake.stop();
  }

  // ─── TX path ─────────────────────────────────────────────────────────────────

  _txTick() {
    // Compute how many samples should have been emitted by now based on
    // wall-clock time since start. If we're behind, emit one or more
    // BLOCK-sized packets to catch up. If we're ahead, do nothing.
    const elapsedMs     = Date.now() - this._txStartMs;
    const targetSamples = Math.floor(elapsedMs * SAMPLES_PER_MS);
    const deficit       = targetSamples - this._txSamplesEmitted;
    if (deficit <= 0) return;

    // Emit in whole BLOCK units (160 samples = 20 ms). Rate-cap to
    // 3 blocks per tick to avoid flooding if the event loop was severely
    // backed up — that way we eventually catch up but don't burst.
    let blocks = Math.min(3, Math.floor(deficit / BLOCK));
    if (blocks === 0 && this._txSamplesEmitted === 0) blocks = 1;  // first tick always emits
    for (let i = 0; i < blocks; i++) {
      const audio = this._handshake.generateAudio(BLOCK);
      this.emit('audioOut', audio);
      this._txSamplesEmitted += BLOCK;
    }
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

    // Silence detection
    const level = rms(samples);
    if (level < ncfg.silenceThreshold) {
      this._silentPkts++;
      if (this._silentPkts >= ncfg.silenceHangupPackets) {
        log.warn(`${this._silentPkts} silent packets — emitting silence-hangup`);
        this.emit('silenceHangup');
        this._silentPkts = 0;
      }
    } else {
      this._silentPkts = 0;
    }

    this._handshake.receiveAudio(samples);
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  get connected()    { return this._connected; }
  get handshakeState() { return this._handshake.state; }
  get protocol()     { return this._handshake.protocol; }
}

module.exports = { ModemDSP };
