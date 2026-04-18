'use strict';

/**
 * SipClient (UAC)
 *
 * Outbound SIP User Agent Client.
 * Places a call to SynthModem server and manages the dialog.
 *
 * States: IDLE → CALLING → RINGING → CONNECTED → TERMINATED
 */

const dgram            = require('dgram');
const net              = require('net');
const { EventEmitter } = require('events');
const config           = require('../config');
const { makeLogger }   = require('../src/logger');
const parser           = require('../src/sip/SipParser');
const { SipDialog }    = require('../src/sip/SipDialog');

const log = makeLogger('SipClient');
const tc  = config.testClient;
const sc  = config.sip;

const CRLF = '\r\n';

class SipClient extends EventEmitter {

  constructor() {
    super();
    this._dialog       = null;
    this._state        = 'IDLE';
    this._udpSocket    = null;
    this._tcpSocket    = null;
    this._localIp      = '127.0.0.1';
    this._localSipPort = tc.localSipPort;
    this._localRtpPort = tc.localRtpPort;
    this._cseq         = Math.floor(Math.random() * 10000) + 1;
    this._callId       = null;
    this._localTag     = null;
    this._retryTimer   = null;
    this._inviteMsg    = null;  // kept for ACK construction
    this._response200  = null;
    this._tcpBuf       = '';
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    this._localIp = await this._getLocalIp();
    await this._openSocket();
    log.info(`SIP client ready on ${this._localIp}:${this._localSipPort} (${tc.serverTransport.toUpperCase()})`);
  }

  async stop() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._udpSocket) this._udpSocket.close();
    if (this._tcpSocket) this._tcpSocket.destroy();
    this._state = 'IDLE';
  }

  // ─── Place a call ─────────────────────────────────────────────────────────────

  async call() {
    if (this._state !== 'IDLE') {
      log.warn('call() called but not IDLE');
      return;
    }

    this._callId   = parser.generateCallId(this._localIp);
    this._localTag = parser.generateTag();
    this._cseq     = Math.floor(Math.random() * 10000) + 1;
    this._state    = 'CALLING';

    const sdpBody = parser.buildSdp({
      addr:            this._localIp,
      port:            this._localRtpPort,
      codecs:          config.rtp.preferredCodecs,
      sessionId:       Date.now() % 1e9 | 0,
      sessionVersion:  1,
    });

    const branch   = parser.generateBranch();
    const fromUri  = `sip:${tc.fromUser}@${tc.fromDomain}`;
    const toUri    = `sip:${tc.toUser}@${tc.toDomain}`;
    const reqUri   = `sip:${tc.toUser}@${tc.serverHost}:${tc.serverPort}`;
    const contact  = `<sip:${tc.fromUser}@${this._localIp}:${this._localSipPort}>`;
    const via      = `SIP/2.0/${tc.serverTransport.toUpperCase()} ${this._localIp}:${this._localSipPort};branch=${branch};rport`;

    const invite = new parser.SipMessage();
    invite.isRequest  = true;
    invite.method     = 'INVITE';
    invite.requestUri = reqUri;
    invite.setHeader('Via',            via);
    invite.setHeader('Max-Forwards',   '70');
    invite.setHeader('From',           `<${fromUri}>;tag=${this._localTag}`);
    invite.setHeader('To',             `<${toUri}>`);
    invite.setHeader('Call-ID',        this._callId);
    invite.setHeader('CSeq',           `${this._cseq} INVITE`);
    invite.setHeader('Contact',        contact);
    invite.setHeader('Content-Type',   'application/sdp');
    invite.setHeader('Allow',          'INVITE, ACK, BYE, CANCEL, OPTIONS');
    invite.setHeader('User-Agent',     'SynthModem-TestClient/1.0');
    invite.body = sdpBody;

    this._inviteMsg = invite;
    this._send(invite);

    log.info(`INVITE sent to ${tc.serverHost}:${tc.serverPort} — calling ${toUri}`);
    log.debug(`Local RTP port: ${this._localRtpPort}`);

    // Timeout for connect
    this._retryTimer = setTimeout(() => {
      if (this._state !== 'CONNECTED') {
        log.error(`Call connect timeout after ${tc.connectTimeoutMs}ms`);
        this.emit('failed', 'timeout');
        this._state = 'IDLE';
      }
    }, tc.connectTimeoutMs);
  }

  // ─── Hang up ──────────────────────────────────────────────────────────────────

  hangup() {
    if (this._state !== 'CONNECTED' && this._state !== 'RINGING') return;
    if (!this._dialog) return;

    if (this._state === 'RINGING') {
      this._sendCancel();
      return;
    }

    const bye = new parser.SipMessage();
    bye.isRequest  = true;
    bye.method     = 'BYE';
    bye.requestUri = this._dialog.remoteUri;
    const branch   = parser.generateBranch();
    const via      = `SIP/2.0/${tc.serverTransport.toUpperCase()} ${this._localIp}:${this._localSipPort};branch=${branch}`;
    bye.setHeader('Via',           via);
    bye.setHeader('Max-Forwards',  '70');
    bye.setHeader('From',          `<sip:${tc.fromUser}@${tc.fromDomain}>;tag=${this._localTag}`);
    bye.setHeader('To',            `<sip:${tc.toUser}@${tc.toDomain}>;tag=${this._dialog.remoteTag}`);
    bye.setHeader('Call-ID',       this._callId);
    bye.setHeader('CSeq',          `${++this._cseq} BYE`);
    bye.setHeader('User-Agent',    'SynthModem-TestClient/1.0');

    this._send(bye);
    this._state = 'TERMINATED';
    log.info('BYE sent');
    this.emit('hungup');
  }

  _sendCancel() {
    const cancel = new parser.SipMessage();
    cancel.isRequest  = true;
    cancel.method     = 'CANCEL';
    cancel.requestUri = this._inviteMsg.requestUri;
    cancel.setHeader('Via',          this._inviteMsg.getHeader('via'));
    cancel.setHeader('Max-Forwards', '70');
    cancel.setHeader('From',         this._inviteMsg.getHeader('from'));
    cancel.setHeader('To',           this._inviteMsg.getHeader('to'));
    cancel.setHeader('Call-ID',      this._callId);
    cancel.setHeader('CSeq',         `${this._cseq} CANCEL`);
    this._send(cancel);
    this._state = 'TERMINATED';
    log.info('CANCEL sent');
  }

  // ─── Message handling ─────────────────────────────────────────────────────────

  _onMessage(msg, addr, port) {
    if (config.logging.logSipMessages) {
      log.debug(`← ${addr}:${port} | ${msg.isRequest ? msg.method : msg.statusCode}`);
      log.trace(msg.toString());
    }

    if (!msg.isRequest) {
      this._onResponse(msg, addr, port);
    } else {
      this._onRequest(msg, addr, port);
    }
  }

  _onRequest(msg, addr, port) {
    // We can receive BYE from server
    if (msg.method === 'BYE') {
      const ok = parser.buildResponse(msg, 200, 'OK');
      this._send(ok);
      this._state = 'TERMINATED';
      log.info('BYE received from server');
      this.emit('hungup');
    }
  }

  _onResponse(msg, addr, port) {
    const sc = msg.statusCode;
    const callId = msg.getHeader('call-id');

    if (callId !== this._callId) return;

    if (sc === 100) {
      log.debug('100 Trying');
      return;
    }

    if (sc === 180 || sc === 183) {
      this._state = 'RINGING';
      log.info(`${sc} Ringing`);
      this.emit('ringing');
      return;
    }

    if (sc === 200) {
      const toHeader  = msg.getHeader('to') || '';
      const toTag     = (toHeader.match(/tag=([^\s;>]+)/) || [])[1] || '';

      if (!this._dialog) {
        this._dialog = new SipDialog({
          callId:      this._callId,
          localTag:    this._localTag,
          remoteTag:   toTag,
          localUri:    `sip:${tc.fromUser}@${tc.fromDomain}`,
          remoteUri:   `sip:${tc.toUser}@${tc.toDomain}`,
          transport:   tc.serverTransport,
          remoteAddr:  addr,
          remotePort:  port,
        });
      } else {
        this._dialog.remoteTag = toTag;
      }

      // Parse SDP for remote RTP info
      const sdp = parser.parseSdp(msg.body);
      if (sdp) {
        const audio = sdp.media.find(m => m.type === 'audio');
        if (audio) {
          const conn = audio.connection || sdp.connection || {};
          this._dialog.remoteRtpAddr = conn.address || addr;
          this._dialog.remoteRtpPort = audio.port;
        }
        // Negotiate codec
        for (const ours of config.rtp.preferredCodecs) {
          const fmt = audio && audio.formats.includes(String(ours.payloadType));
          if (fmt) { this._dialog.negotiatedCodec = ours; break; }
        }
      }

      // Send ACK
      this._sendAck(msg);

      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this._state = 'CONNECTED';
      this._dialog.setConfirmed(toTag);
      log.info(`200 OK — call connected (remote RTP ${this._dialog.remoteRtpAddr}:${this._dialog.remoteRtpPort})`);
      this._response200 = msg;
      this.emit('connected', this._dialog);
      return;
    }

    if (sc >= 300) {
      log.warn(`Call failed: ${sc} ${msg.reasonPhrase}`);
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this._state = 'IDLE';
      this.emit('failed', `${sc} ${msg.reasonPhrase}`);
    }
  }

  _sendAck(response200) {
    const toHeader = response200.getHeader('to') || '';
    const ack = new parser.SipMessage();
    ack.isRequest  = true;
    ack.method     = 'ACK';
    ack.requestUri = this._inviteMsg.requestUri;
    const branch   = parser.generateBranch();
    ack.setHeader('Via',          `SIP/2.0/${tc.serverTransport.toUpperCase()} ${this._localIp}:${this._localSipPort};branch=${branch}`);
    ack.setHeader('Max-Forwards', '70');
    ack.setHeader('From',         this._inviteMsg.getHeader('from'));
    ack.setHeader('To',           toHeader);
    ack.setHeader('Call-ID',      this._callId);
    ack.setHeader('CSeq',         `${this._cseq} ACK`);
    ack.setHeader('User-Agent',   'SynthModem-TestClient/1.0');
    this._send(ack);
    log.debug('ACK sent');
  }

  // ─── Transport ───────────────────────────────────────────────────────────────

  async _openSocket() {
    if (tc.serverTransport === 'tcp') {
      await this._openTcp();
    } else {
      await this._openUdp();
    }
  }

  _openUdp() {
    return new Promise((resolve, reject) => {
      this._udpSocket = dgram.createSocket('udp4');
      this._udpSocket.on('message', (buf, rinfo) => {
        const msg = parser.parse(buf);
        if (msg) this._onMessage(msg, rinfo.address, rinfo.port);
      });
      this._udpSocket.on('error', err => {
        log.error('UDP error', { err: err.message });
        this.emit('error', err);
      });
      this._udpSocket.bind(this._localSipPort, '0.0.0.0', () => resolve());
      this._udpSocket.once('error', reject);
    });
  }

  _openTcp() {
    return new Promise((resolve, reject) => {
      this._tcpSocket = net.connect(tc.serverPort, tc.serverHost, () => {
        log.debug(`TCP connected to ${tc.serverHost}:${tc.serverPort}`);
        resolve();
      });
      this._tcpSocket.on('data', chunk => {
        this._tcpBuf += chunk.toString('utf8');
        let boundary;
        while ((boundary = this._tcpBuf.indexOf('\r\n\r\n')) !== -1) {
          const headerPart = this._tcpBuf.slice(0, boundary + 4);
          const msg        = parser.parse(headerPart);
          if (msg) {
            const cl = msg.contentLength;
            if (this._tcpBuf.length < boundary + 4 + cl) break;
            msg.body       = this._tcpBuf.slice(boundary + 4, boundary + 4 + cl);
            this._tcpBuf   = this._tcpBuf.slice(boundary + 4 + cl);
            this._onMessage(msg, tc.serverHost, tc.serverPort);
          } else {
            this._tcpBuf = this._tcpBuf.slice(boundary + 4);
          }
        }
      });
      this._tcpSocket.on('error', err => {
        log.error('TCP error', { err: err.message });
        this.emit('error', err);
        reject(err);
      });
    });
  }

  _send(msg) {
    if (config.logging.logSipMessages) {
      log.debug(`→ ${tc.serverHost}:${tc.serverPort} | ${msg.isRequest ? msg.method : msg.statusCode}`);
      log.trace(msg.toString());
    }
    const buf = msg.toBuffer();
    if (tc.serverTransport === 'tcp' && this._tcpSocket) {
      this._tcpSocket.write(buf);
    } else if (this._udpSocket) {
      this._udpSocket.send(buf, 0, buf.length, tc.serverPort, tc.serverHost, err => {
        if (err) log.error('UDP send error', { err: err.message });
      });
    }
  }

  _getLocalIp() {
    return new Promise(resolve => {
      // Connect a UDP socket to determine outbound IP
      const s = require('dgram').createSocket('udp4');
      s.connect(tc.serverPort, tc.serverHost, () => {
        const addr = s.address().address;
        s.close();
        resolve(addr || '127.0.0.1');
      });
      s.on('error', () => resolve('127.0.0.1'));
    });
  }

  get state()  { return this._state; }
  get dialog() { return this._dialog; }
}

module.exports = { SipClient };
