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
    log.info(`[${this._id}] Modem handshake complete — waiting for remote to settle`);

    // DSP data → telnet proxy (connect receive side immediately so we
    // don't lose any early bytes from the remote).
    this._dsp.on('data', buf => this._telnet.receive(buf));

    // Give the remote modem time to finish its own handshake / lock
    // carrier detect / initialise its UART framer before we blast data
    // into the new connection. Banner bytes that arrive during the
    // remote's CD-acquisition window are lost — a settle delay avoids
    // that at the cost of a brief pause before the user sees our banner.
    // 500 ms is conservative; most modems lock in ≤ 200 ms, but some
    // older ones take up to 300 ms after their own training completes.
    setTimeout(() => {
      if (!this._active) return;
      log.info(`[${this._id}] Attaching TelnetProxy`);

      // Telnet proxy output → DSP (→ RTP)
      this._telnet.attach(buf => this._dsp.write(buf));

      // Telnet proxy requests disconnect
      this._telnet.on('disconnect', () => {
        log.info(`[${this._id}] User disconnected via terminal`);
        this.hangup('user');
      });
    }, 500);
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
