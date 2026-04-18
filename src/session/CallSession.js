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
 */

const { EventEmitter }          = require('events');
const config                    = require('../../config');
const { makeLogger }            = require('../logger');
const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../rtp/RtpSession');
const { ModemDSP }              = require('../dsp/ModemDSP');
const { TelnetProxy }           = require('../telnet/TelnetProxy');

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

    // Wire RTP → DSP (inbound audio)
    this._rtp.on('audio', samples => this._dsp.receiveAudio(samples));

    // Wire DSP → RTP (outbound audio)
    this._dsp.on('audioOut', samples => this._rtp.send(samples));

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
    log.info(`[${this._id}] Modem handshake complete — attaching TelnetProxy`);

    // DSP data → telnet proxy
    this._dsp.on('data', buf => this._telnet.receive(buf));

    // Telnet proxy output → DSP (→ RTP)
    this._telnet.attach(buf => this._dsp.write(buf));

    // Telnet proxy requests disconnect
    this._telnet.on('disconnect', () => {
      log.info(`[${this._id}] User disconnected via terminal`);
      this.hangup('user');
    });
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
    this.emit('ended', { callId: this._id, reason: 'bye' });
  }

  get id()        { return this._id; }
  get dialog()    { return this._dialog; }
  get active()    { return this._active; }
  get dsp()       { return this._dsp; }
  get rtp()       { return this._rtp; }
}

module.exports = { CallSession };
