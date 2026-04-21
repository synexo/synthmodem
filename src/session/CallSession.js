'use strict';

/**
 * CallSession
 *
 * The single owner of one active call.
 * Wires together:
 *   SipDialog  → knows who called and the SIP state
 *   RtpSession → bidirectional audio over UDP
 *   ModemDSP   → modem handshake and data codec
 *   TelnetProxy → terminal UI and TCP proxy
 *
 * Lifecycle:
 *   1. Created by SipServer when INVITE arrives
 *   2. Allocates RTP port, calls sipServer.answerCall()
 *   3. On ACK: starts DSP
 *   4. On ModemDSP 'connected': attaches TelnetProxy
 *   5. On BYE / silence hangup: tears everything down
 *
 * Optional: per-call audio capture (WAV files) when config.modem.captureAudio
 * is true. Writes one _rx.wav and one _tx.wav per call to
 * config.modem.captureDir, useful for debugging modem handshakes against
 * real hardware.
 */

const { EventEmitter }          = require('events');
const config                    = require('../../config');
const { makeLogger }            = require('../logger');
const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../rtp/RtpSession');
const { ModemDSP }              = require('../dsp/ModemDSP');
const { TelnetProxy }           = require('../telnet/TelnetProxy');
const { AudioCapture }          = require('../dsp/AudioCapture');

const log = makeLogger('CallSession');

class CallSession extends EventEmitter {

  constructor(sipServer, dialog) {
    super();
    this._sip      = sipServer;
    this._dialog   = dialog;
    this._rtp      = new RtpSession();
    this._dsp      = new ModemDSP(config.modem.role);
    this._telnet   = new TelnetProxy();
    this._rtpPort  = null;
    this._active   = false;
    this._id       = dialog.callId;
    this._capture  = null;

    // Per-call audio capture (optional, for debugging).
    if (config.modem.captureAudio) {
      try {
        this._capture = new AudioCapture({
          dir: config.modem.captureDir || './captures',
          tag: String(this._id).replace(/[^a-z0-9]/gi, '-'),
        });
        log.info(`[${this._id}] Audio capture enabled`);
        log.debug(`[${this._id}]   RX → ${this._capture.rxPath}`);
        log.debug(`[${this._id}]   TX → ${this._capture.txPath}`);
      } catch (e) {
        log.warn(`[${this._id}] Audio capture setup failed: ${e.message}`);
        this._capture = null;
      }
    }

    if (config.logging.logDspState) {
      this._dsp.on('connected', info => {
        log.info(`[${this._id}] Modem connected: ${info.protocol} @ ${info.bps} bps`);
      });
    }
  }

  // ─── Setup ───────────────────────────────────────────────────────────────────

  async setup() {
    log.info(`Setting up call session ${this._id}`);

    // Allocate RTP port
    this._rtpPort = await allocateRtpPort();
    await this._rtp.open(this._rtpPort);
    log.debug(`[${this._id}] RTP port ${this._rtpPort} open`);

    // Configure RTP codec from negotiated dialog
    const codecInfo = this._dialog.negotiatedCodec || config.rtp.preferredCodecs[0];
    this._rtp.setCodec(codecInfo.name, codecInfo.payloadType);

    // Tell the SIP server to answer with our RTP port
    this._dialog.localRtpPort = this._rtpPort;
    this._sip.answerCall(this._dialog, this._rtpPort);

    // Store session on dialog for reference
    this._dialog.session = this;
  }

  // ─── Activate (called on ACK received) ───────────────────────────────────────

  activate() {
    if (this._active) return;
    this._active = true;
    log.info(`[${this._id}] Call active — starting DSP`);

    // Point RTP at remote
    this._rtp.setRemote(this._dialog.remoteRtpAddr, this._dialog.remoteRtpPort);

    // Wire RTP → DSP (inbound audio). Capture RX audio alongside if enabled.
    this._rtp.on('audio', samples => {
      if (this._capture) {
        try { this._capture.writeRx(samples); } catch (e) { /* ignore */ }
      }
      this._dsp.receiveAudio(samples);
    });

    // Wire DSP → RTP (outbound audio). Capture TX audio alongside if enabled.
    this._dsp.on('audioOut', samples => {
      if (this._capture) {
        try { this._capture.writeTx(samples); } catch (e) { /* ignore */ }
      }
      this._rtp.send(samples);
    });

    // Start modem DSP (begins generating answer tone)
    this._dsp.start();

    // When modem connects, attach telnet proxy
    this._dsp.on('connected', () => this._onModemConnected());

    // Silence hangup
    this._dsp.on('silenceHangup', () => {
      log.info(`[${this._id}] Silence hangup`);
      this.hangup('silence');
    });
  }

  // ─── Modem data path ─────────────────────────────────────────────────────────

  _onModemConnected() {
    log.info(`[${this._id}] Modem handshake complete — holding post-train idle`);

    // Post-training "V.42 Penalty Box" — after V.22 training completes,
    // most modern modems spend some seconds transmitting V.42 ODP trying
    // to negotiate LAPM error correction. synthmodem doesn't implement
    // V.42, so we must wait that window out without sending any payload
    // bytes (which would corrupt the caller's descrambler and cause it
    // to refuse DCD) and without routing the descrambled ODP garbage to
    // TelnetProxy (the menu would interpret the bytes as hostnames).
    //
    // Strategy: two-phase wait.
    //
    //   Phase 1 — MINIMUM HOLD: wait config.modem.postTrainIdleMs
    //   (default 6000 ms) unconditionally. This covers the V.22
    //   §6.3.1.2.2 tail and the typical V.42 T400 timers observed in
    //   consumer modems (4-6 s). Smaller values (3-4 s) caused some
    //   modems to drop the call when banner bytes arrived mid-V.42.
    //
    //   Phase 2 — QUIESCENCE WAIT: after the minimum hold, keep the
    //   TelnetProxy detached as long as RX bytes keep arriving. When the
    //   byte stream goes quiet for QUIESCENCE_MS (caller has finished
    //   V.42 and dropped into mark idle, which our binding suppresses
    //   as 0xFF), attach the TelnetProxy. Hard cap at ATTACH_MAX_MS from
    //   training-complete to avoid waiting forever on pathological modems.
    //
    // During both phases, RX bytes are counted for quiescence tracking
    // but NOT routed anywhere — they're silently discarded.
    const holdMs        = (config.modem.postTrainIdleMs    ?? 3000);
    const quiescenceMs  = (config.modem.postTrainQuiescenceMs ?? 500);
    const attachMaxMs   = (config.modem.postTrainAttachMaxMs  ?? 10000);

    log.debug(`[${this._id}] Post-train hold: minimum ${holdMs}ms, then wait ${quiescenceMs}ms quiescence (cap ${attachMaxMs}ms)`);

    const startedAt = Date.now();
    let lastByteAt  = startedAt;
    let droppedCount = 0;
    let minHoldElapsed = false;
    let attached = false;

    // Temporary RX sink — counts bytes for quiescence tracking but
    // discards them.
    const rxSink = (buf) => {
      if (attached) return;          // real path is active now
      lastByteAt = Date.now();
      droppedCount += buf.length;
    };
    this._dsp.on('data', rxSink);

    const attach = (reason) => {
      if (attached || !this._active) return;
      attached = true;
      this._dsp.off('data', rxSink);
      const waited = Date.now() - startedAt;
      log.info(`[${this._id}] Post-train hold complete — attaching TelnetProxy (${reason}, waited ${waited}ms, dropped ${droppedCount} bytes)`);

      // DSP data → TelnetProxy — bytes from here onwards are real user input.
      this._dsp.on('data', buf => this._telnet.receive(buf));

      // TelnetProxy output → DSP.
      this._telnet.attach(buf => this._dsp.write(buf));

      // TelnetProxy requests disconnect.
      this._telnet.on('disconnect', () => {
        log.info(`[${this._id}] User disconnected via terminal`);
        this.hangup('user');
      });
    };

    // Phase 1: min hold timer.
    setTimeout(() => {
      if (!this._active) return;
      minHoldElapsed = true;
      // If there's been no byte activity during the min hold at all, we
      // can attach right away — nothing in flight.
      if (Date.now() - lastByteAt >= quiescenceMs) {
        attach('quiet from start');
      }
    }, holdMs);

    // Phase 2: periodic quiescence check.
    const tick = setInterval(() => {
      if (!this._active || attached) {
        clearInterval(tick);
        return;
      }
      const now = Date.now();
      if (now - startedAt >= attachMaxMs) {
        clearInterval(tick);
        attach('attach_max reached');
        return;
      }
      if (minHoldElapsed && now - lastByteAt >= quiescenceMs) {
        clearInterval(tick);
        attach('quiescence');
      }
    }, 100);
  }

  // ─── Hangup ───────────────────────────────────────────────────────────────────

  hangup(reason = 'normal') {
    if (!this._active) return;
    this._active = false;
    log.info(`[${this._id}] Hanging up (reason: ${reason})`);

    this._telnet.disconnect();
    this._dsp.stop();

    if (this._dialog.canBye()) {
      this._sip.sendBye(this._dialog);
    }

    this._rtp.close();
    if (this._rtpPort) {
      releaseRtpPort(this._rtpPort);
      this._rtpPort = null;
    }

    this._closeCapture();

    this.emit('ended', { callId: this._id, reason });
  }

  // ─── BYE received from remote ─────────────────────────────────────────────────

  onBye() {
    log.info(`[${this._id}] BYE received`);
    this._active = false;
    this._telnet.disconnect();
    this._dsp.stop();
    this._rtp.close();
    if (this._rtpPort) {
      releaseRtpPort(this._rtpPort);
      this._rtpPort = null;
    }

    this._closeCapture();

    this.emit('ended', { callId: this._id, reason: 'bye' });
  }

  _closeCapture() {
    if (!this._capture) return;
    try {
      this._capture.close();
      log.info(`[${this._id}] Audio capture saved:`);
      log.info(`[${this._id}]   RX → ${this._capture.rxPath}`);
      log.info(`[${this._id}]   TX → ${this._capture.txPath}`);
    } catch (e) {
      log.warn(`[${this._id}] Audio capture close failed: ${e.message}`);
    }
    this._capture = null;
  }

  get id()        { return this._id; }
  get dialog()    { return this._dialog; }
  get active()    { return this._active; }
  get dsp()       { return this._dsp; }
  get rtp()       { return this._rtp; }
}

module.exports = { CallSession };
