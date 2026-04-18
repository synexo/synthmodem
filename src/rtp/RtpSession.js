'use strict';

const dgram          = require('dgram');
const { EventEmitter } = require('events');
const config         = require('../../config');
const { makeLogger } = require('../logger');
const codec          = require('./Codec');

const log = makeLogger('RTP');
const cfg = config.rtp;

/**
 * RtpSession
 *
 * Manages one RTP UDP socket for send and receive.
 * Emits 'audio' events with Float32Array decoded samples.
 * Call send(Float32Array) to transmit audio.
 *
 * Includes a simple jitter buffer (reorder + hold-off).
 */
class RtpSession extends EventEmitter {

  constructor() {
    super();
    this._socket       = null;
    this._localPort    = null;
    this._remoteAddr   = null;
    this._remotePort   = null;
    this._codecName    = 'PCMU';
    this._payloadType  = 0;

    // Sequence and timestamp tracking
    this._sendSeq      = Math.floor(Math.random() * 65535);
    this._sendTs       = Math.floor(Math.random() * 0xFFFFFFFF);
    this._ssrc         = cfg.outboundSsrc || (Math.random() * 0xFFFFFFFF | 0);
    this._tsIncrement  = cfg.packetIntervalMs * cfg.sampleRate / 1000; // 160 @ 20ms / 8kHz

    // Jitter buffer: Map of seqNo → {payload, timestamp, received}
    this._jitterBuf    = new Map();
    this._nextPlaySeq  = null;
    this._jitterTimer  = null;
    this._lastSeq      = null;

    this._running      = false;
    this._silenceCount = 0;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async open(localPort) {
    this._localPort = localPort;
    await new Promise((resolve, reject) => {
      this._socket = dgram.createSocket('udp4');
      this._socket.on('error', err => {
        log.error('RTP socket error', { err: err.message });
        this.emit('error', err);
      });
      this._socket.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
      this._socket.bind(localPort, () => {
        log.debug(`RTP socket bound to port ${localPort}`);
        resolve();
      });
      this._socket.once('error', reject);
    });
    this._running = true;
  }

  setRemote(addr, port) {
    this._remoteAddr = addr;
    this._remotePort = port;
    log.debug(`RTP remote set to ${addr}:${port}`);
  }

  setCodec(codecName, payloadType) {
    this._codecName   = codecName;
    this._payloadType = payloadType;
    log.debug(`RTP codec set to ${codecName} PT=${payloadType}`);
  }

  close() {
    this._running = false;
    if (this._jitterTimer) { clearInterval(this._jitterTimer); this._jitterTimer = null; }
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
  }

  // ─── Receive ────────────────────────────────────────────────────────────────

  _onPacket(msg, rinfo) {
    if (msg.length < 12) return; // Too short for RTP header

    // Parse RTP header
    const version  = (msg[0] >> 6) & 0x03;
    if (version !== 2) return;

    const hasExt   = (msg[0] >> 4) & 0x01;
    const csrcCount = msg[0] & 0x0f;
    const marker   = (msg[1] >> 7) & 0x01;
    const pt       = msg[1] & 0x7f;
    const seq      = msg.readUInt16BE(2);
    const timestamp = msg.readUInt32BE(4);
    const ssrc     = msg.readUInt32BE(8);

    let offset = 12 + csrcCount * 4;
    if (hasExt) {
      const extLen = msg.readUInt16BE(offset + 2);
      offset += 4 + extLen * 4;
    }
    if (offset >= msg.length) return;

    const payload = msg.slice(offset);

    if (config.logging.logRtpPackets) {
      log.trace(`RTP ← seq=${seq} ts=${timestamp} pt=${pt} len=${payload.length}`);
    }

    // Auto-detect remote if not set
    if (!this._remoteAddr) {
      this.setRemote(rinfo.address, rinfo.port);
    }

    // Jitter buffer insert
    this._jitterBuf.set(seq & 0xffff, { payload, timestamp, pt, received: Date.now() });

    // Initialise play-out pointer on first packet
    if (this._nextPlaySeq === null) {
      this._nextPlaySeq = seq;
      this._startPlayoutTimer();
    }

    // Drop stale packets
    if (this._jitterBuf.size > cfg.jitterBufferMaxPackets) {
      this._flushOldest();
    }
  }

  _startPlayoutTimer() {
    const intervalMs = cfg.packetIntervalMs;
    this._jitterTimer = setInterval(() => this._playoutTick(), intervalMs);
  }

  _playoutTick() {
    if (!this._running) return;

    const seq  = this._nextPlaySeq & 0xffff;
    const pkt  = this._jitterBuf.get(seq);

    if (pkt) {
      this._jitterBuf.delete(seq);
      this._nextPlaySeq = (this._nextPlaySeq + 1) & 0xffff;
      this._deliverAudio(pkt.payload, pkt.pt);
      this._silenceCount = 0;
    } else {
      // Packet loss or not yet arrived — check if we should skip ahead
      const buffered = this._jitterBuf.size;
      if (buffered >= cfg.jitterBufferPackets) {
        // Find nearest future seq
        let next = this._nextPlaySeq;
        for (let i = 1; i <= cfg.maxSeqGap; i++) {
          if (this._jitterBuf.has((next + i) & 0xffff)) {
            log.debug(`Jitter: skipping ${i} packet(s)`);
            this._nextPlaySeq = (next + i) & 0xffff;
            break;
          }
        }
      }
      // Emit concealment silence
      this._silenceCount++;
      const samples = this._tsIncrement | 0;
      this.emit('audio', new Float32Array(samples));
    }
  }

  _deliverAudio(payload, pt) {
    // Determine codec from PT
    let codecName = this._codecName;
    // Attempt PT match from our codec list
    const match = config.rtp.preferredCodecs.find(c => c.payloadType === pt);
    if (match) codecName = match.name;

    try {
      const samples = codec.decode(payload, codecName);
      this.emit('audio', samples);
    } catch (e) {
      log.warn(`RTP decode error PT=${pt}`, { err: e.message });
    }
  }

  _flushOldest() {
    let oldest = Infinity;
    let oldestKey;
    for (const [seq, pkt] of this._jitterBuf) {
      if (pkt.received < oldest) { oldest = pkt.received; oldestKey = seq; }
    }
    if (oldestKey !== undefined) this._jitterBuf.delete(oldestKey);
  }

  // ─── Send ────────────────────────────────────────────────────────────────────

  /**
   * Send a Float32Array of audio samples as an RTP packet.
   * @param {Float32Array} samples
   */
  send(samples) {
    if (!this._running || !this._remoteAddr || !this._socket) return;

    const payload  = codec.encode(samples, this._codecName);
    const pktLen   = 12 + payload.length;
    const pkt      = Buffer.allocUnsafe(pktLen);

    // RTP header
    pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
    pkt[1] = this._payloadType & 0x7f;
    pkt.writeUInt16BE(this._sendSeq & 0xffff, 2);
    pkt.writeUInt32BE(this._sendTs >>> 0, 4);
    pkt.writeUInt32BE(this._ssrc >>> 0, 8);
    payload.copy(pkt, 12);

    this._sendSeq = (this._sendSeq + 1) & 0xffff;
    this._sendTs  = (this._sendTs + (this._tsIncrement | 0)) >>> 0;

    if (config.logging.logRtpPackets) {
      log.trace(`RTP → seq=${this._sendSeq} len=${payload.length}`);
    }

    this._socket.send(pkt, 0, pkt.length, this._remotePort, this._remoteAddr, err => {
      if (err) log.warn('RTP send error', { err: err.message });
    });
  }

  /**
   * Send a buffer of silence.
   */
  sendSilence(numSamples) {
    this.send(new Float32Array(numSamples));
  }

  get localPort() { return this._localPort; }
  get silenceCount() { return this._silenceCount; }
}

// ─── Port allocator ──────────────────────────────────────────────────────────

const _usedPorts = new Set();

async function allocateRtpPort() {
  for (let p = cfg.portMin; p <= cfg.portMax; p += 2) {
    if (_usedPorts.has(p)) continue;
    // Try to actually bind it
    const ok = await new Promise(resolve => {
      const s = dgram.createSocket('udp4');
      s.bind(p, () => { s.close(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) {
      _usedPorts.add(p);
      return p;
    }
  }
  throw new Error('No RTP ports available');
}

function releaseRtpPort(port) {
  _usedPorts.delete(port);
}

module.exports = { RtpSession, allocateRtpPort, releaseRtpPort };
