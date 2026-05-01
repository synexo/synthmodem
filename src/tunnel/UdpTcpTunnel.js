'use strict';

/**
 * UdpTcpTunnel
 *
 * Node-side host counterpart to vm/tunnel/modemd-tunnel.c. Bridges:
 *
 *   Three loopback UDP sockets (SIP, RTP, RTCP)
 *     ⇄
 *   One TCP byte stream carrying framed datagrams (the host side of
 *   the virtio-serial chardev that the VM accesses via
 *   /dev/virtio-ports/synthmodem.tunnel).
 *
 * The wire protocol is specified in vm/tunnel/PROTOCOL.md and is
 * shared with the C implementation. Any changes require updates in
 * both places.
 *
 * USAGE
 *
 *   const tunnel = new UdpTcpTunnel({
 *     tcp:  { host: '127.0.0.1', port: 9001 },  // chardev TCP socket
 *     sipPort:  5062,                           // host-side bindings
 *     rtpPort:  10002,
 *     rtcpPort: 10003,
 *   });
 *   await tunnel.start();
 *   // Node consumers now bind to the host-side ports directly:
 *   //   SIP  → 127.0.0.1:5062
 *   //   RTP  → 127.0.0.1:10002
 *   //   RTCP → 127.0.0.1:10003
 *   // Traffic to those sockets is forwarded into the tunnel and
 *   // delivered on the VM side to 127.0.0.1:5060 / 10000 / 10001.
 *   ...
 *   await tunnel.stop();
 *
 * EVENTS
 *
 *   'ready'          tunnel connected and all sockets bound
 *   'error'          fatal error — tunnel should be discarded
 *   'echo-reply'     echo-channel frame received; payload as Buffer
 *                    (primarily used by tests)
 *   'frame-rx'       (channel, srcPort, dstPort, payload) — low-level
 *                    observer for debugging
 *
 * MODE
 *
 *   The tunnel has two TCP modes:
 *     - 'connect' (default): opens an outbound TCP connection to
 *        opts.tcp.host:port. Used when the VM's chardev is configured
 *        as a server.
 *     - 'listen': binds and listens on opts.tcp.host:port, accepts
 *        one connection. Used for tests where we want to be the
 *        server (the peer connects to us).
 */

const net    = require('net');
const dgram  = require('dgram');
const { EventEmitter } = require('events');
const { makeLogger } = require('../logger');

const log = makeLogger('tunnel');

/* ─── Wire protocol constants (mirrors vm/tunnel/modemd-tunnel.c) ──── */

const CH_SIP    = 0;
const CH_RTP    = 1;
const CH_RTCP   = 2;
const CH_ECHO   = 255;

const FRAME_HDR_FIXED = 5;     // channel(1) + src_port(2) + dst_port(2)
const FRAME_LEN_BYTES = 2;
const MAX_PAYLOAD     = 8192;  // matches C side
const MAX_FRAME       = FRAME_HDR_FIXED + MAX_PAYLOAD;

/* Default VM-side ports (what the C side binds to). The tunnel frames
 * include src_port/dst_port so this is mostly informational, but we
 * use it as the dst_port on frames we build for host→VM traffic. */
const DEFAULT_VM_SIP_PORT  = 5060;
const DEFAULT_VM_RTP_PORT  = 10000;
const DEFAULT_VM_RTCP_PORT = 10001;

class UdpTcpTunnel extends EventEmitter {

  /**
   * @param {object} opts
   * @param {object} opts.tcp              TCP endpoint descriptor.
   * @param {string} opts.tcp.host         Address to connect to / listen on.
   * @param {number} opts.tcp.port         TCP port.
   * @param {'connect'|'listen'} [opts.tcp.mode='connect']
   * @param {number} [opts.sipPort=5062]   Host-side SIP bind port.
   * @param {number} [opts.rtpPort=10002]  Host-side RTP bind port.
   * @param {number} [opts.rtcpPort=10003] Host-side RTCP bind port.
   * @param {number} [opts.vmSipPort=5060] VM-side SIP port for dst.
   * @param {number} [opts.vmRtpPort=10000]
   * @param {number} [opts.vmRtcpPort=10001]
   */
  constructor(opts) {
    super();
    if (!opts || !opts.tcp) {
      throw new Error('UdpTcpTunnel: opts.tcp is required');
    }
    this.tcpOpts = {
      host: opts.tcp.host || '127.0.0.1',
      port: opts.tcp.port,
      mode: opts.tcp.mode || 'connect',
    };
    if (!this.tcpOpts.port) {
      throw new Error('UdpTcpTunnel: opts.tcp.port is required');
    }

    this.hostPorts = {
      sip:  opts.sipPort  || 5062,
      rtp:  opts.rtpPort  || 10002,
      rtcp: opts.rtcpPort || 10003,
    };
    this.vmPorts = {
      sip:  opts.vmSipPort  || DEFAULT_VM_SIP_PORT,
      rtp:  opts.vmRtpPort  || DEFAULT_VM_RTP_PORT,
      rtcp: opts.vmRtcpPort || DEFAULT_VM_RTCP_PORT,
    };

    // TCP state
    this.tcpSocket = null;
    this.tcpServer = null;
    this.stage = Buffer.alloc(0);

    // UDP sockets. Keys match the channel names.
    this.udp = { sip: null, rtp: null, rtcp: null };

    // Learned host-side peer (where to deliver VM→host datagrams).
    // Populated on first datagram from each host-side consumer.
    this.learnedPeer = { sip: null, rtp: null, rtcp: null };

    this.state = 'idle';   // 'idle' → 'starting' → 'ready' → 'stopped'
  }

  /**
   * Start the tunnel: establish/await TCP, bind UDP sockets.
   * Resolves once everything is ready.
   */
  async start() {
    if (this.state !== 'idle') {
      throw new Error(`UdpTcpTunnel.start: invalid state ${this.state}`);
    }
    this.state = 'starting';

    try {
      await Promise.all([
        this._openTcp(),
        this._bindUdp('sip',  this.hostPorts.sip),
        this._bindUdp('rtp',  this.hostPorts.rtp),
        this._bindUdp('rtcp', this.hostPorts.rtcp),
      ]);
    } catch (err) {
      await this.stop();
      throw err;
    }

    this.state = 'ready';
    log.info(`tunnel ready (tcp ${this.tcpOpts.mode} ${this.tcpOpts.host}:${this.tcpOpts.port}; ` +
             `host sip=${this.hostPorts.sip} rtp=${this.hostPorts.rtp} rtcp=${this.hostPorts.rtcp})`);
    this.emit('ready');
  }

  /**
   * Close everything. Safe to call from any state.
   */
  async stop() {
    this.state = 'stopped';
    const closers = [];

    if (this.tcpSocket) {
      const s = this.tcpSocket;
      this.tcpSocket = null;
      closers.push(new Promise(resolve => {
        s.once('close', resolve);
        s.destroy();
      }));
    }
    if (this.tcpServer) {
      const srv = this.tcpServer;
      this.tcpServer = null;
      closers.push(new Promise(resolve => srv.close(resolve)));
    }
    for (const key of Object.keys(this.udp)) {
      const s = this.udp[key];
      if (s) {
        this.udp[key] = null;
        closers.push(new Promise(resolve => {
          try { s.close(resolve); } catch (_) { resolve(); }
        }));
      }
    }
    await Promise.all(closers);
  }

  /**
   * Send a test echo frame. The VM side should mirror it back and we'll
   * emit 'echo-reply' with the payload Buffer. Primarily used by tests.
   */
  sendEcho(payload, srcPort = 0, dstPort = 0) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this._sendFrame(CH_ECHO, srcPort, dstPort, buf);
  }

  /**
   * Inject a raw frame into the tunnel, bypassing the UDP-socket
   * delivery path. Used by VmRegistrar (and any other in-Node SIP
   * endpoint) that wants to respond to frames without owning a
   * host-side UDP socket.
   *
   * The 'frame-rx' event remains the canonical way to observe
   * inbound frames; callers that want to inject a reply use this.
   *
   * @param {number} channel   0=SIP, 1=RTP, 2=RTCP
   * @param {number} srcPort   frame.srcPort (informational)
   * @param {number} dstPort   frame.dstPort (VM side uses peer-learning
   *                           primarily; dst_port is the fallback)
   * @param {Buffer|string} payload
   */
  injectFrame(channel, srcPort, dstPort, payload) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this._sendFrame(channel, srcPort, dstPort, buf);
  }

  /* ─── Internals: TCP ───────────────────────────────────────────── */

  _openTcp() {
    if (this.tcpOpts.mode === 'listen') {
      return this._listenTcp();
    }
    return this._connectTcp();
  }

  _connectTcp() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({
        host: this.tcpOpts.host,
        port: this.tcpOpts.port,
      });
      let settled = false;
      s.once('connect', () => {
        settled = true;
        this._attachTcp(s);
        resolve();
      });
      s.once('error', err => {
        if (settled) return;
        settled = true;
        reject(new Error(`tunnel tcp connect failed: ${err.message}`));
      });
    });
  }

  _listenTcp() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(socket => {
        if (this.tcpSocket) {
          // Only accept one connection; slam any subsequent ones closed.
          log.info('extra inbound TCP connection closed');
          socket.destroy();
          return;
        }
        this._attachTcp(socket);
      });
      srv.once('error', err => reject(err));
      srv.listen(this.tcpOpts.port, this.tcpOpts.host, () => {
        this.tcpServer = srv;
        resolve();  // we resolve before any client connects; that's fine —
                    // the tunnel is "ready" in the sense that we're
                    // willing to accept. Frames won't flow until the
                    // peer connects, but that's the caller's problem.
      });
    });
  }

  _attachTcp(socket) {
    this.tcpSocket = socket;
    socket.on('data',  chunk => this._onTcpData(chunk));
    socket.on('error', err   => this._onTcpError(err));
    socket.on('close', ()    => this._onTcpClose());
    log.info(`tcp attached (${socket.remoteAddress || 'server-accepted'})`);
  }

  _onTcpData(chunk) {
    // Append to stage buffer and drain.
    this.stage = this.stage.length === 0
      ? chunk
      : Buffer.concat([this.stage, chunk]);
    this._drainStage();
  }

  _onTcpError(err) {
    log.error(`tcp error: ${err.message}`);
    if (this.state !== 'stopped') this.emit('error', err);
  }

  _onTcpClose() {
    log.info('tcp closed');
    if (this.state !== 'stopped') {
      this.emit('error', new Error('tunnel tcp closed'));
    }
  }

  /* Drain the staged bytes: while we have a full frame, process it. */
  _drainStage() {
    for (;;) {
      if (this.stage.length < FRAME_LEN_BYTES) return;
      const length = this.stage.readUInt16LE(0);
      if (length > MAX_PAYLOAD + FRAME_HDR_FIXED) {
        log.error(`tunnel framing error: length=${length}; closing`);
        this._fatal(new Error('framing error: length out of range'));
        return;
      }
      const total = FRAME_LEN_BYTES + length;
      if (this.stage.length < total) return;

      this._processFrame(this.stage.slice(0, total));
      this.stage = this.stage.slice(total);
    }
  }

  _processFrame(frame) {
    if (frame.length < FRAME_LEN_BYTES + FRAME_HDR_FIXED) {
      log.error(`tunnel short frame (${frame.length})`);
      return;
    }
    const channel  = frame.readUInt8(FRAME_LEN_BYTES + 0);
    const srcPort  = frame.readUInt16LE(FRAME_LEN_BYTES + 1);
    const dstPort  = frame.readUInt16LE(FRAME_LEN_BYTES + 3);
    const payload  = frame.slice(FRAME_LEN_BYTES + FRAME_HDR_FIXED);

    this.emit('frame-rx', channel, srcPort, dstPort, payload);

    if (channel === CH_ECHO) {
      this.emit('echo-reply', payload, srcPort, dstPort);
      return;
    }
    const key = this._channelKey(channel);
    if (!key) {
      // Unknown channel — drop per PROTOCOL.md.
      return;
    }
    // Deliver to the host-side consumer that's sending to us, if we've
    // learned where they are. If we haven't, drop.
    const peer = this.learnedPeer[key];
    if (!peer) {
      log.debug(`drop: ${key} inbound before host consumer seen`);
      return;
    }
    const sock = this.udp[key];
    if (!sock) return;
    sock.send(payload, peer.port, peer.address, err => {
      if (err) log.error(`udp send to host ${key}: ${err.message}`);
    });
  }

  /* ─── Internals: UDP ───────────────────────────────────────────── */

  _bindUdp(key, port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => this._onUdp(key, msg, rinfo));
      sock.bind(port, '127.0.0.1', () => {
        sock.removeListener('error', reject);
        sock.on('error', err => {
          log.error(`udp ${key} error: ${err.message}`);
        });
        this.udp[key] = sock;
        log.info(`udp ${key} bound 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  _onUdp(key, msg, rinfo) {
    // Learn the host-side consumer's source so we can reply to it
    // later. Consumers typically use a fixed ephemeral port for the
    // life of a call.
    this.learnedPeer[key] = { address: rinfo.address, port: rinfo.port };

    const channel = this._keyChannel(key);
    const dstPort = this.vmPorts[key];
    this._sendFrame(channel, rinfo.port, dstPort, msg);
  }

  /* ─── Framing ──────────────────────────────────────────────────── */

  _sendFrame(channel, srcPort, dstPort, payload) {
    if (!this.tcpSocket) {
      log.debug('drop tx: tcp not connected');
      return;
    }
    if (payload.length > MAX_PAYLOAD) {
      log.error(`frame too large: ${payload.length} > ${MAX_PAYLOAD}, drop`);
      return;
    }
    const length = FRAME_HDR_FIXED + payload.length;
    const hdr = Buffer.alloc(FRAME_LEN_BYTES + FRAME_HDR_FIXED);
    hdr.writeUInt16LE(length, 0);
    hdr.writeUInt8(channel, 2);
    hdr.writeUInt16LE(srcPort, 3);
    hdr.writeUInt16LE(dstPort, 5);
    this.tcpSocket.write(hdr);
    if (payload.length > 0) {
      this.tcpSocket.write(payload);
    }
  }

  _fatal(err) {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.emit('error', err);
    if (this.tcpSocket) {
      try { this.tcpSocket.destroy(); } catch (_) { /* ignore */ }
      this.tcpSocket = null;
    }
  }

  /* ─── Channel key mapping ──────────────────────────────────────── */

  _channelKey(channel) {
    switch (channel) {
      case CH_SIP:  return 'sip';
      case CH_RTP:  return 'rtp';
      case CH_RTCP: return 'rtcp';
      default:      return null;
    }
  }

  _keyChannel(key) {
    switch (key) {
      case 'sip':  return CH_SIP;
      case 'rtp':  return CH_RTP;
      case 'rtcp': return CH_RTCP;
      default: throw new Error(`UdpTcpTunnel: bad channel key ${key}`);
    }
  }
}

module.exports = {
  UdpTcpTunnel,
  // Exports for tests:
  CH_SIP, CH_RTP, CH_RTCP, CH_ECHO,
  FRAME_HDR_FIXED, FRAME_LEN_BYTES, MAX_PAYLOAD,
};
