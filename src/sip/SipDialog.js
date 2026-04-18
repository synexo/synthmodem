'use strict';

const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');
const { generateTag }  = require('./SipParser');

const log = makeLogger('SipDialog');

/**
 * Tracks the state of a SIP dialog (INVITE session).
 *
 * States: INIT → EARLY → CONFIRMED → TERMINATED
 */
class SipDialog extends EventEmitter {

  constructor({ callId, localTag, remoteTag, localUri, remoteUri, transport, remoteAddr, remotePort }) {
    super();
    this.callId      = callId;
    this.localTag    = localTag  || generateTag();
    this.remoteTag   = remoteTag || '';
    this.localUri    = localUri;
    this.remoteUri   = remoteUri;
    this.transport   = transport;   // 'udp' | 'tcp'
    this.remoteAddr  = remoteAddr;
    this.remotePort  = remotePort;

    this.state       = 'INIT';      // INIT | EARLY | CONFIRMED | TERMINATED
    this.localSeq    = 0;
    this.remoteSeq   = 0;

    this.routeSet    = [];          // Record-Route headers (in order)
    this.remoteTarget = null;       // Contact URI of remote party

    // SDP negotiated media
    this.remoteRtpAddr = null;
    this.remoteRtpPort = null;
    this.negotiatedCodec = null;

    // Store original INVITE for re-sending 200 OK
    this.lastInvite  = null;
    this.last200     = null;

    this._ackTimer   = null;
    this._createdAt  = Date.now();
  }

  get dialogId() {
    return `${this.callId};from-tag=${this.localTag};to-tag=${this.remoteTag}`;
  }

  transition(newState) {
    const prev = this.state;
    this.state = newState;
    log.debug(`Dialog ${this.callId} ${prev} → ${newState}`);
    this.emit('stateChange', { from: prev, to: newState });
  }

  setEarly() {
    this.transition('EARLY');
  }

  setConfirmed(remoteTag) {
    if (remoteTag) this.remoteTag = remoteTag;
    this.transition('CONFIRMED');
  }

  setTerminated() {
    this.clearAckTimer();
    this.transition('TERMINATED');
    this.emit('terminated');
  }

  setAckTimer(cb, ms) {
    this.clearAckTimer();
    this._ackTimer = setTimeout(() => {
      log.warn(`ACK timeout for dialog ${this.callId}`);
      cb();
    }, ms);
  }

  clearAckTimer() {
    if (this._ackTimer) {
      clearTimeout(this._ackTimer);
      this._ackTimer = null;
    }
  }

  /** True if we can send a BYE */
  canBye() {
    return this.state === 'CONFIRMED';
  }

  toJSON() {
    return {
      callId:        this.callId,
      state:         this.state,
      localTag:      this.localTag,
      remoteTag:     this.remoteTag,
      remoteAddr:    this.remoteAddr,
      remoteRtpAddr: this.remoteRtpAddr,
      remoteRtpPort: this.remoteRtpPort,
      codec:         this.negotiatedCodec,
      age:           (Date.now() - this._createdAt) + 'ms',
    };
  }
}

module.exports = { SipDialog };
