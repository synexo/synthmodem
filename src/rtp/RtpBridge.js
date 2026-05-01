'use strict';

/**
 * RtpBridge — forward raw RTP packets between two UDP endpoints.
 *
 * Used by backend B's B2BUA mode to connect the external SIP leg's
 * RTP session to the internal (in-VM PJSIP) leg's RTP session. No
 * decoding, no jitter buffering, no SSRC rewriting: just a pump.
 *
 *     External leg                         Internal leg
 *     ------------                         ------------
 *     Caller's RTP ──► extSocket ──┐    ┌──► tunnel → PJSIP
 *                                   │    │
 *                               (bridge)
 *                                   │    │
 *                     extSocket ◄──┘    └──── tunnel ← PJSIP
 *                                                    (intSocket)
 *
 * ─── Why it's a separate class ──────────────────────────────────
 *
 * The existing RtpSession class does jitter-buffering, codec
 * decoding, playout timing — all of which are exactly wrong for a
 * B2BUA bridge. We want the RTP packets to arrive at PJSIP with
 * their original sequence numbers, timestamps, and inter-arrival
 * timing so PJSIP's own jitter buffer (and slmodemd/d-modem's
 * careful clock management) sees the real pattern the caller is
 * sending. Decoding to PCM and re-encoding to RTP would defeat
 * the entire reason we're bothering with a tunnel.
 *
 * ─── What this class is NOT ─────────────────────────────────────
 *
 * - Not a congestion manager. Packets are forwarded whenever they
 *   arrive; no rate limiting, no overflow discard, no smoothing.
 *   On loopback both ways this is fine.
 * - Not a jitter buffer. The PJSIP side provides its own.
 * - Not an RTP validator. If something non-RTP arrives, it gets
 *   forwarded as-is. If you need stricter checks, add them above
 *   this class.
 * - Not a multi-stream demux. One bridge = one external/internal
 *   pair. For multiple concurrent calls we'd instantiate multiple
 *   bridges, each with its own socket pair.
 *
 * ─── Peer learning ──────────────────────────────────────────────
 *
 * Both endpoints use the same address-learning approach:
 *   - On creation, extPeer / intPeer may be null (unknown).
 *   - On first received packet, the source address is remembered
 *     and subsequent outbound packets target it.
 *   - Later packets from different sources are accepted (updates
 *     the peer), but don't panic if that happens — just a relearn.
 *
 * In practice:
 *   - `extPeer` is known from the SDP in the external leg's INVITE
 *     (caller's RTP address). Usually set up front via setExtPeer().
 *   - `intPeer` is the tunnel's host-side RTP port (127.0.0.1:10002
 *     by default) and is also known up front.
 *
 * Learning is a fallback for NAT / symmetric-RTP scenarios where
 * the advertised port doesn't match the actual source. We don't
 * need it for our purely-loopback case but cheap to keep.
 *
 * ─── Usage ──────────────────────────────────────────────────────
 *
 *   const dgram = require('dgram');
 *   const ext = dgram.createSocket('udp4');
 *   const intr = dgram.createSocket('udp4');
 *   await new Promise(r => ext.bind(0, '127.0.0.1', r));
 *   await new Promise(r => intr.bind(0, '127.0.0.1', r));
 *
 *   const bridge = new RtpBridge({
 *     extSocket: ext,
 *     intSocket: intr,
 *     extPeer:  { address: callerAddr, port: callerPort },   // optional
 *     intPeer:  { address: '127.0.0.1', port: 10002 },
 *   });
 *   bridge.start();
 *   // ... call runs ...
 *   bridge.stop();
 */

const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');

const log = makeLogger('RtpBridge');

class RtpBridge extends EventEmitter {

  /**
   * @param {object} opts
   * @param {dgram.Socket} opts.extSocket  Bound external-leg UDP socket.
   * @param {dgram.Socket} opts.intSocket  Bound internal-leg UDP socket.
   * @param {{address,port}} [opts.extPeer]  Caller's RTP endpoint.
   * @param {{address,port}} [opts.intPeer]  Internal RTP endpoint
   *                                          (typically the tunnel's
   *                                          host-side RTP port).
   * @param {boolean} [opts.logFirstPacket=true]  Info-log the first
   *                                              packet in each direction
   *                                              for quick debugging.
   * @param {number}  [opts.statsIntervalMs=5000]  Emit periodic stats
   *                                               heartbeat at this
   *                                               cadence while
   *                                               started. 0 disables.
   */
  constructor(opts) {
    super();
    if (!opts || !opts.extSocket || !opts.intSocket) {
      throw new Error('RtpBridge: extSocket and intSocket are required');
    }
    this.extSocket = opts.extSocket;
    this.intSocket = opts.intSocket;
    this.extPeer   = opts.extPeer || null;
    this.intPeer   = opts.intPeer || null;
    this.logFirstPacket   = opts.logFirstPacket !== false;
    this.statsIntervalMs  = opts.statsIntervalMs != null
      ? opts.statsIntervalMs : 5000;

    this._started = false;
    this._heartbeat = null;

    /* Stats the tests / diagnostics will want. */
    this.stats = {
      extToInt: { packets: 0, bytes: 0 },
      intToExt: { packets: 0, bytes: 0 },
      extToIntDrops: 0,   /* incremented when intPeer is unknown */
      intToExtDrops: 0,   /* incremented when extPeer is unknown */
      extFirstSrc: null,
      intFirstSrc: null,
    };

    /* Snapshot at last heartbeat, for computing per-interval rates. */
    this._lastStats = { extToInt: 0, intToExt: 0 };

    /* Bound handlers so stop() can remove them precisely. */
    this._onExtMsg = (msg, rinfo) => this._forward('ext', msg, rinfo);
    this._onIntMsg = (msg, rinfo) => this._forward('int', msg, rinfo);
  }

  /* Register the socket listeners and begin forwarding. */
  start() {
    if (this._started) return;
    this._started = true;
    this.extSocket.on('message', this._onExtMsg);
    this.intSocket.on('message', this._onIntMsg);
    log.info(`RTP bridge started (extPeer=${this._peerStr(this.extPeer)}, intPeer=${this._peerStr(this.intPeer)})`);
    if (this.statsIntervalMs > 0) {
      this._heartbeat = setInterval(() => this._emitHeartbeat(),
                                    this.statsIntervalMs);
      /* Don't hold the event loop open for this alone. */
      if (this._heartbeat.unref) this._heartbeat.unref();
    }
  }

  /**
   * Unregister listeners. Does not close the sockets — the caller
   * owns them and may reuse them (e.g. for a subsequent call).
   */
  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    this.extSocket.removeListener('message', this._onExtMsg);
    this.intSocket.removeListener('message', this._onIntMsg);
    log.info(`RTP bridge stopped: ${JSON.stringify(this.stats)}`);
  }

  _peerStr(p) {
    return p ? `${p.address}:${p.port}` : 'learning';
  }

  _emitHeartbeat() {
    const extDelta = this.stats.extToInt.packets - this._lastStats.extToInt;
    const intDelta = this.stats.intToExt.packets - this._lastStats.intToExt;
    this._lastStats.extToInt = this.stats.extToInt.packets;
    this._lastStats.intToExt = this.stats.intToExt.packets;
    /* A healthy PCMU call is ~50 pkts/sec each way (20ms frames).
     * So over a 5s heartbeat we expect ~250 in each direction once
     * the handshake is past the initial silence. Zero on either
     * side is a clear red flag.
     *
     * Logged at debug — useful for diagnosing media-plane stalls
     * but too chatty for normal INFO operation (50+ lines per
     * minute per call). */
    log.debug(
      `RTP heartbeat: ext→int ${this.stats.extToInt.packets} (+${extDelta}), ` +
      `int→ext ${this.stats.intToExt.packets} (+${intDelta}), ` +
      `drops ext→int=${this.stats.extToIntDrops} int→ext=${this.stats.intToExtDrops}, ` +
      `extPeer=${this._peerStr(this.extPeer)}, intPeer=${this._peerStr(this.intPeer)}`);
  }

  setExtPeer(peer) { this.extPeer = peer; }
  setIntPeer(peer) { this.intPeer = peer; }

  /* ─── Internals ──────────────────────────────────────────────── */

  _forward(side, msg, rinfo) {
    if (!this._started) return;
    if (side === 'ext') {
      /* Inbound from external caller. Learn source if unknown. */
      if (!this.extPeer) this.extPeer = { address: rinfo.address, port: rinfo.port };
      if (!this.stats.extFirstSrc) {
        this.stats.extFirstSrc = `${rinfo.address}:${rinfo.port}`;
        if (this.logFirstPacket) {
          log.info(`first ext→int packet (from ${this.stats.extFirstSrc}, ${msg.length} bytes)`);
        }
      }
      this.stats.extToInt.packets++;
      this.stats.extToInt.bytes += msg.length;
      if (!this.intPeer) { this.stats.extToIntDrops++; return; }
      this.intSocket.send(msg, this.intPeer.port, this.intPeer.address, (err) => {
        if (err) log.warn(`int send failed: ${err.message}`);
      });
      return;
    }
    /* side === 'int': inbound from PJSIP side. */
    if (!this.intPeer) this.intPeer = { address: rinfo.address, port: rinfo.port };
    if (!this.stats.intFirstSrc) {
      this.stats.intFirstSrc = `${rinfo.address}:${rinfo.port}`;
      if (this.logFirstPacket) {
        log.info(`first int→ext packet (from ${this.stats.intFirstSrc}, ${msg.length} bytes)`);
      }
    }
    this.stats.intToExt.packets++;
    this.stats.intToExt.bytes += msg.length;
    if (!this.extPeer) { this.stats.intToExtDrops++; return; }
    this.extSocket.send(msg, this.extPeer.port, this.extPeer.address, (err) => {
      if (err) log.warn(`ext send failed: ${err.message}`);
    });
  }
}

module.exports = { RtpBridge };
