'use strict';

const dgram        = require('dgram');
const net          = require('net');
const { EventEmitter } = require('events');
const config       = require('../../config');
const { makeLogger } = require('../logger');
const parser       = require('./SipParser');
const { SipDialog } = require('./SipDialog');

const { PublicHostResolver } = require('./PublicHostResolver');

const log = makeLogger('SipServer');
const cfg = config.sip;

/**
 * SipServer
 *
 * Listens on UDP and TCP for SIP messages.
 * Emits 'invite' with a SipDialog when a new INVITE arrives.
 * Emits 'bye'    with dialog when a BYE arrives.
 * Emits 'cancel' with dialog when a CANCEL arrives.
 *
 * Callers (CallSession) drive the dialog state (ring, answer, bye).
 */
class SipServer extends EventEmitter {

  constructor() {
    super();
    this._dialogs   = new Map();   // callId → SipDialog
    this._udpSocket = null;
    this._tcpServer = null;
    this._tcpConnections = new Map(); // remoteKey → net.Socket
    this._started   = false;

    /* publicHost resolution. Either pinned (config.sip.publicHost is
     * a non-empty string) or auto-resolved per call. The resolver is
     * always instantiated; we just bypass it when the static value
     * is set. See PublicHostResolver for the resolution chain. */
    this._publicHostResolver = new PublicHostResolver();
    this._staticPublicHost   = (typeof cfg.publicHost === 'string'
                                && cfg.publicHost.trim().length > 0)
      ? cfg.publicHost.trim()
      : null;
    if (this._staticPublicHost) {
      log.info(`publicHost pinned via config: ${this._staticPublicHost}`);
    } else {
      const def = this._publicHostResolver.resolveDefault();
      log.info(`publicHost will auto-resolve per call ` +
               `(default fallback: ${def.address}, ` +
               `source: ${def.source}${def.interface ? ', iface ' + def.interface : ''})`);
    }
  }

  /**
   * Resolve the publicHost for a given caller. Returns the static
   * configured value if set; otherwise consults PublicHostResolver
   * with the caller's source IP.
   *
   * Returned object: { address, source, interface }.
   * `source === 'static'`         — config.sip.publicHost was pinned
   * `source === 'subnet'`         — caller IP matched a local subnet
   * `source === 'fallback-first-nonloop'` — no subnet match, used first non-loopback IPv4
   * `source === 'fallback-loopback'`      — no non-loopback at all
   *
   * @param {string} [callerAddr] — Caller's source IPv4. Optional;
   *     when omitted (or for non-call contexts like outbound BYE
   *     after dialog termination), the resolver uses its default
   *     non-call path.
   */
  _resolvePublicHost(callerAddr) {
    if (this._staticPublicHost) {
      return { address: this._staticPublicHost, source: 'static', interface: null };
    }
    return callerAddr
      ? this._publicHostResolver.resolveFor(callerAddr)
      : this._publicHostResolver.resolveDefault();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    if (this._started) return;
    await Promise.all([this._startUdp(), this._startTcp()]);
    this._started = true;
    log.info(`SIP server listening on ${cfg.host}:${cfg.port} (UDP+TCP)`);
  }

  async stop() {
    for (const dlg of this._dialogs.values()) {
      dlg.setTerminated();
    }
    this._dialogs.clear();

    await new Promise(r => {
      if (this._udpSocket) this._udpSocket.close(r); else r();
    });
    await new Promise(r => {
      if (this._tcpServer) this._tcpServer.close(r); else r();
    });
    for (const sock of this._tcpConnections.values()) sock.destroy();
    this._tcpConnections.clear();
    this._started = false;
    log.info('SIP server stopped');
  }

  // ─── Transport setup ────────────────────────────────────────────────────────

  _startUdp() {
    return new Promise((resolve, reject) => {
      this._udpSocket = dgram.createSocket('udp4');
      this._udpSocket.on('error', err => {
        log.error('UDP socket error', { err: err.message });
        this.emit('error', err);
      });
      this._udpSocket.on('message', (msg, rinfo) => {
        this._handleRaw(msg, rinfo.address, rinfo.port, 'udp', null);
      });
      this._udpSocket.bind(cfg.port, cfg.host, () => {
        log.debug(`UDP bound to ${cfg.host}:${cfg.port}`);
        resolve();
      });
      this._udpSocket.on('error', reject);
    });
  }

  _startTcp() {
    return new Promise((resolve, reject) => {
      this._tcpServer = net.createServer(socket => {
        const key = `${socket.remoteAddress}:${socket.remotePort}`;
        this._tcpConnections.set(key, socket);
        log.debug(`TCP connection from ${key}`);

        let buf = '';
        socket.on('data', chunk => {
          buf += chunk.toString('utf8');
          // SIP messages are delimited by CRLFCRLF; handle fragmentation
          let boundary;
          while ((boundary = buf.indexOf('\r\n\r\n')) !== -1) {
            const headerPart = buf.slice(0, boundary + 4);
            const msg = parser.parse(headerPart);
            if (msg) {
              const cl = msg.contentLength;
              if (buf.length < boundary + 4 + cl) break; // wait for body
              msg.body = buf.slice(boundary + 4, boundary + 4 + cl);
              buf = buf.slice(boundary + 4 + cl);
              this._handleMessage(msg, socket.remoteAddress, socket.remotePort, 'tcp', socket);
            } else {
              buf = buf.slice(boundary + 4);
            }
          }
        });
        socket.on('close', () => this._tcpConnections.delete(key));
        socket.on('error', err => {
          log.warn(`TCP socket error from ${key}`, { err: err.message });
          this._tcpConnections.delete(key);
        });
      });

      this._tcpServer.listen(cfg.port, cfg.host, () => {
        log.debug(`TCP listening on ${cfg.host}:${cfg.port}`);
        resolve();
      });
      this._tcpServer.on('error', reject);
    });
  }

  // ─── Message dispatch ────────────────────────────────────────────────────────

  _handleRaw(buf, addr, port, transport, socket) {
    // Quick check: ignore keep-alive packets (CRLF pairs)
    if (buf.length <= 4) return;

    const msg = parser.parse(buf);
    if (!msg) {
      log.warn(`Failed to parse SIP message from ${addr}:${port}`);
      return;
    }
    this._handleMessage(msg, addr, port, transport, socket);
  }

  _handleMessage(msg, addr, port, transport, socket) {
    if (config.logging.logSipMessages) {
      log.debug(`← ${transport.toUpperCase()} ${addr}:${port} | ${msg.isRequest ? msg.method : msg.statusCode}`);
      log.trace(msg.toString());
    }

    if (msg.isRequest) {
      this._handleRequest(msg, addr, port, transport, socket);
    } else {
      this._handleResponse(msg, addr, port, transport, socket);
    }
  }

  _handleRequest(msg, addr, port, transport, socket) {
    const method = msg.method;

    // Add received / rport to Via per RFC 3261 §18.2.1
    const topVia = msg.getHeader('via');
    if (topVia) {
      let updatedVia = topVia;
      if (!updatedVia.includes('received=')) {
        updatedVia += `;received=${addr}`;
      }
      const viaPort = topVia.match(/rport=(\d+)/);
      if (!viaPort && topVia.includes('rport')) {
        updatedVia = updatedVia.replace('rport', `rport=${port}`);
      }
      const vias = msg.getHeaders('via');
      vias[0] = updatedVia;
      msg.headers['via'] = vias.length === 1 ? vias[0] : vias;
      msg.rawHeaders = msg.rawHeaders.filter(h => h.name.toLowerCase() !== 'via');
      msg.rawHeaders.unshift({ name: 'Via', value: vias.length === 1 ? vias[0] : vias });
    }

    switch (method) {
      case 'INVITE':  return this._handleInvite(msg, addr, port, transport, socket);
      case 'ACK':     return this._handleAck(msg, addr, port, transport, socket);
      case 'BYE':     return this._handleBye(msg, addr, port, transport, socket);
      case 'CANCEL':  return this._handleCancel(msg, addr, port, transport, socket);
      case 'OPTIONS': return this._handleOptions(msg, addr, port, transport, socket);
      case 'REGISTER':return this._handleRegister(msg, addr, port, transport, socket);
      default:
        this._send(parser.buildResponse(msg, 405, 'Method Not Allowed',
          { Allow: 'INVITE, ACK, BYE, CANCEL, OPTIONS' }), addr, port, transport, socket);
    }
  }

  _handleResponse(msg, addr, port, transport, socket) {
    // Responses are mostly relevant to UAC mode (test client)
    const callId = msg.getHeader('call-id');
    const dlg = this._dialogs.get(callId);
    if (dlg) {
      this.emit('response', { msg, dialog: dlg, addr, port, transport, socket });
    }
  }

  // ─── INVITE ─────────────────────────────────────────────────────────────────

  _handleInvite(msg, addr, port, transport, socket) {
    const callId = msg.getHeader('call-id');

    // Re-INVITE on existing dialog
    if (this._dialogs.has(callId)) {
      const dlg = this._dialogs.get(callId);
      if (config.sip.acceptReInvite) {
        log.info(`Re-INVITE on dialog ${callId}`);
        this._processInviteSdp(msg, dlg);
        const ok = this._build200Ok(msg, dlg);
        this._send(ok, addr, port, transport, socket);
        dlg.lastInvite = msg;
        dlg.last200    = ok;
      } else {
        this._send(parser.buildResponse(msg, 488, 'Not Acceptable Here'), addr, port, transport, socket);
      }
      return;
    }

    // Enforce single active session
    const active = [...this._dialogs.values()].find(d => d.state !== 'TERMINATED');
    if (active) {
      log.warn(`Rejecting INVITE ${callId} — session already active`);
      this._send(parser.buildResponse(msg, 486, 'Busy Here'), addr, port, transport, socket);
      return;
    }

    // New dialog
    const from   = msg.fromParsed;
    const to     = msg.toParsed;
    const dlg    = new SipDialog({
      callId,
      localTag:   parser.generateTag(),
      remoteTag:  from.tag,
      localUri:   to.uri,
      remoteUri:  from.uri,
      transport,
      remoteAddr: addr,
      remotePort: port,
    });

    dlg.lastInvite = msg;
    this._dialogs.set(callId, dlg);

    // Parse remote SDP
    this._processInviteSdp(msg, dlg);

    // Send 100 Trying
    const trying = parser.buildResponse(msg, 100, 'Trying');
    this._send(trying, addr, port, transport, socket);

    // Resolve publicHost for this dialog. Done once at INVITE time
    // so 180 / 200 / BYE all advertise the same address. The resolved
    // value is stashed on the dialog so later sends don't need to
    // re-resolve (and BYE works after dialog termination, when we
    // may not have reliable access to the caller addr anymore).
    const ph = this._resolvePublicHost(addr);
    dlg.localPublicHost       = ph.address;
    dlg.localPublicHostSource = ph.source;
    dlg.localPublicHostIface  = ph.interface;

    // Send 180 Ringing
    const ringing = parser.buildResponse(msg, 180, 'Ringing', {
      To: `${msg.getHeader('to')};tag=${dlg.localTag}`,
      Contact: `<sip:synthmodem@${dlg.localPublicHost}:${cfg.port}>`,
    });
    this._send(ringing, addr, port, transport, socket);
    dlg.setEarly();

    log.info(`New INVITE from ${from.uri} — dialog ${callId}`);
    this.emit('invite', dlg, msg);
  }

  _processInviteSdp(msg, dlg) {
    const sdp = parser.parseSdp(msg.body);
    if (!sdp) return;

    const audio = sdp.media.find(m => m.type === 'audio');
    if (!audio) return;

    const connAddr = (audio.connection || sdp.connection || {}).address;
    dlg.remoteRtpAddr = connAddr || dlg.remoteAddr;
    dlg.remoteRtpPort = audio.port;

    // Negotiate codec — find first match from our preference list
    const ourCodecs  = config.rtp.preferredCodecs;
    const theirFmts  = audio.formats;
    for (const ours of ourCodecs) {
      if (theirFmts.includes(String(ours.payloadType))) {
        dlg.negotiatedCodec = ours;
        log.debug(`Codec negotiated: ${ours.name} PT=${ours.payloadType}`);
        break;
      }
    }
  }

  // ─── 200 OK builder (answer) ─────────────────────────────────────────────────

  _build200Ok(request, dlg) {
    const toHeader = `${request.getHeader('to')};tag=${dlg.localTag}`;
    const codec    = dlg.negotiatedCodec || config.rtp.preferredCodecs[0];
    const sdpBody  = parser.buildSdp({
      addr:    dlg.localPublicHost,
      port:    dlg.localRtpPort || config.rtp.portMin,
      codecs:  [codec],
    });

    return parser.buildResponse(request, 200, 'OK', {
      To:             toHeader,
      Contact:        `<sip:synthmodem@${dlg.localPublicHost}:${cfg.port};transport=${dlg.transport}>`,
      'Content-Type': 'application/sdp',
      Allow:          'INVITE, ACK, BYE, CANCEL, OPTIONS',
      Supported:      'replaces',
      'User-Agent':   cfg.userAgent,
    }, sdpBody);
  }

  /**
   * Called by CallSession once an RTP port is allocated.
   * Sends 200 OK with SDP and arms ACK timer.
   */
  answerCall(dlg, localRtpPort) {
    dlg.localRtpPort = localRtpPort;
    const ok = this._build200Ok(dlg.lastInvite, dlg);
    dlg.last200 = ok;

    const { remoteAddr, remotePort, transport } = dlg;
    const socket = this._getSocketForDialog(dlg);
    this._send(ok, remoteAddr, remotePort, transport, socket);

    // Arm ACK timer — resend 200 OK until ACK received
    let retries = 0;
    const resend = () => {
      retries++;
      if (retries > 6) {
        log.warn(`No ACK received for ${dlg.callId} after ${retries} 200 OK resends`);
        dlg.setTerminated();
        this.emit('bye', dlg);
        return;
      }
      log.debug(`Resending 200 OK for ${dlg.callId} (attempt ${retries})`);
      this._send(ok, remoteAddr, remotePort, transport, socket);
      dlg.setAckTimer(resend, 500 * Math.min(retries, 4));
    };
    dlg.setAckTimer(resend, cfg.ackTimeoutMs);

    log.info(`Sent 200 OK for ${dlg.callId} with RTP port ${localRtpPort} ` +
             `(publicHost=${dlg.localPublicHost})`);

    /* Single per-dialog WARN if the resolution had to fall back past
     * the per-call subnet match. Subnet match (the normal case) and
     * static config-pinned values are silent. */
    if (dlg.localPublicHostSource &&
        dlg.localPublicHostSource !== 'subnet' &&
        dlg.localPublicHostSource !== 'static') {
      log.warn(`publicHost resolution fell back for ${dlg.callId}: ` +
               `selected ${dlg.localPublicHost} via ${dlg.localPublicHostSource}` +
               `${dlg.localPublicHostIface ? ' (iface ' + dlg.localPublicHostIface + ')' : ''} — ` +
               `caller from ${dlg.remoteAddr} did not match any local subnet. ` +
               `If this is wrong for your deployment, set config.sip.publicHost.`);
    }
  }

  /**
   * Send a BYE to terminate a confirmed dialog.
   */
  sendBye(dlg) {
    if (!dlg.canBye()) return;
    const cseq = ++dlg.localSeq;
    const bye  = new parser.SipMessage();
    bye.isRequest  = true;
    bye.method     = 'BYE';
    bye.requestUri = dlg.remoteUri;
    bye.setHeader('Via',        `SIP/2.0/${dlg.transport.toUpperCase()} ${dlg.localPublicHost || cfg.publicHost || '127.0.0.1'}:${cfg.port};branch=${parser.generateBranch()}`);
    bye.setHeader('From',       `<${dlg.localUri}>;tag=${dlg.localTag}`);
    bye.setHeader('To',         `<${dlg.remoteUri}>;tag=${dlg.remoteTag}`);
    bye.setHeader('Call-ID',    dlg.callId);
    bye.setHeader('CSeq',       `${cseq} BYE`);
    bye.setHeader('Max-Forwards', '70');
    bye.setHeader('User-Agent', cfg.userAgent);

    const socket = this._getSocketForDialog(dlg);
    this._send(bye, dlg.remoteAddr, dlg.remotePort, dlg.transport, socket);
    dlg.setTerminated();
    log.info(`Sent BYE for ${dlg.callId}`);
  }

  // ─── ACK ────────────────────────────────────────────────────────────────────

  _handleAck(msg, addr, port, transport, socket) {
    const callId = msg.getHeader('call-id');
    const dlg = this._dialogs.get(callId);
    if (!dlg) return;

    dlg.clearAckTimer();
    if (dlg.state !== 'CONFIRMED') dlg.setConfirmed();
    log.info(`ACK received — dialog ${callId} confirmed`);
    this.emit('ack', dlg);
  }

  // ─── BYE ────────────────────────────────────────────────────────────────────

  _handleBye(msg, addr, port, transport, socket) {
    const callId = msg.getHeader('call-id');
    const dlg = this._dialogs.get(callId);

    // Always send 200 OK
    const ok = parser.buildResponse(msg, 200, 'OK');
    this._send(ok, addr, port, transport, socket);

    if (dlg) {
      dlg.setTerminated();
      this._dialogs.delete(callId);
      log.info(`BYE received — dialog ${callId} terminated`);
      this.emit('bye', dlg);
    }
  }

  // ─── CANCEL ─────────────────────────────────────────────────────────────────

  _handleCancel(msg, addr, port, transport, socket) {
    const callId = msg.getHeader('call-id');
    const dlg = this._dialogs.get(callId);

    this._send(parser.buildResponse(msg, 200, 'OK'), addr, port, transport, socket);

    if (dlg && dlg.state !== 'CONFIRMED') {
      // Also send 487 Request Terminated for the original INVITE
      if (dlg.lastInvite) {
        const term = parser.buildResponse(dlg.lastInvite, 487, 'Request Terminated', {
          To: `${dlg.lastInvite.getHeader('to')};tag=${dlg.localTag}`,
        });
        this._send(term, addr, port, transport, socket);
      }
      dlg.setTerminated();
      this._dialogs.delete(callId);
      this.emit('cancel', dlg);
      log.info(`CANCEL received — dialog ${callId} cancelled`);
    }
  }

  // ─── OPTIONS ────────────────────────────────────────────────────────────────

  _handleOptions(msg, addr, port, transport, socket) {
    if (!cfg.respondToOptions) return;
    const ok = parser.buildResponse(msg, 200, 'OK', {
      Allow:     'INVITE, ACK, BYE, CANCEL, OPTIONS',
      Accept:    'application/sdp',
      'User-Agent': cfg.userAgent,
    });
    this._send(ok, addr, port, transport, socket);
  }

  // ─── REGISTER ───────────────────────────────────────────────────────────────

  _handleRegister(msg, addr, port, transport, socket) {
    // We don't maintain a registrar — just acknowledge
    const ok = parser.buildResponse(msg, 200, 'OK', {
      Contact: msg.getHeader('contact') || '*',
      Expires: '3600',
    });
    this._send(ok, addr, port, transport, socket);
    log.debug(`REGISTER accepted (no-op) from ${addr}:${port}`);
  }

  // ─── Outbound send (for UAC use by test client) ──────────────────────────────

  sendRequest(msg, addr, port, transport) {
    const socket = transport === 'tcp' ? this._getTcpSocket(addr, port) : null;
    this._send(msg, addr, port, transport, socket);
  }

  registerDialog(dlg) {
    this._dialogs.set(dlg.callId, dlg);
  }

  // ─── Transport helpers ───────────────────────────────────────────────────────

  _send(msg, addr, port, transport, socket) {
    const buf = msg.toBuffer();
    if (config.logging.logSipMessages) {
      log.debug(`→ ${transport.toUpperCase()} ${addr}:${port} | ${msg.isRequest ? msg.method : msg.statusCode}`);
      log.trace(msg.toString());
    }
    if (transport === 'tcp' && socket) {
      socket.write(buf);
    } else {
      // UDP
      if (this._udpSocket) {
        this._udpSocket.send(buf, 0, buf.length, port, addr, err => {
          if (err) log.error(`UDP send error to ${addr}:${port}`, { err: err.message });
        });
      }
    }
  }

  _getSocketForDialog(dlg) {
    if (dlg.transport !== 'tcp') return null;
    const key = `${dlg.remoteAddr}:${dlg.remotePort}`;
    return this._tcpConnections.get(key) || null;
  }

  _getTcpSocket(addr, port) {
    const key = `${addr}:${port}`;
    if (this._tcpConnections.has(key)) return this._tcpConnections.get(key);

    const sock = net.connect(port, addr);
    this._tcpConnections.set(key, sock);
    sock.on('error', err => {
      log.warn(`TCP connect error to ${key}`, { err: err.message });
      this._tcpConnections.delete(key);
    });
    sock.on('close', () => this._tcpConnections.delete(key));
    return sock;
  }

  getDialog(callId) {
    return this._dialogs.get(callId);
  }

  get activeDialogs() {
    return [...this._dialogs.values()].filter(d => d.state !== 'TERMINATED');
  }
}

module.exports = { SipServer };
