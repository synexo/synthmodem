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

  /**
   * @param {object} [opts]
   * @param {'buffered'|'immediate'|'fixed-buffered'} [opts.playoutMode='buffered']
   *
   * 'buffered' — the default for voice. RTP packets go into a jitter buffer
   *    and are released at 20ms intervals by a setInterval-driven
   *    playout timer. If a packet isn't there at tick time, emit a
   *    zero-filled concealment frame. Good for human voice where
   *    20ms dropouts are imperceptible; the buffer smooths network
   *    jitter and packet reordering at the cost of ~40-80ms latency.
   *
   * 'immediate' — bypass the jitter buffer entirely. Emit 'audio'
   *    synchronously the moment a packet is decoded. No concealment
   *    frames are ever emitted. Out-of-order packets are delivered
   *    out-of-order (acceptable on LAN where reorder is rare).
   *    Originally used as a workaround for modem audio, where silence
   *    concealment actively destroys the signal.
   *
   * 'fixed-buffered' — D-Modem-style fixed-depth jitter buffer. Packets
   *    accumulate in a queue until `jitterBufferInitDepth` are held;
   *    playback then starts and releases one packet every 20ms. If
   *    the next sequence isn't there at tick time, we SKIP THE TICK
   *    rather than emit concealment silence — the expectation is that
   *    the packet will arrive soon and the buffer will absorb the
   *    jitter. Only on severe underrun (buffer drops to zero and stays
   *    empty for more than one tick) do we resync. On overflow past
   *    `jitterBufferMaxDepth`, the oldest packet is dropped. This is
   *    the approach the D-Modem project uses in their PJSIP-based
   *    implementation and is credited with enabling days-long modem
   *    connection stability. The tradeoff is fixed added latency equal
   *    to `jitterBufferInitDepth × packetIntervalMs` (e.g. 40 × 20ms
   *    = 800ms), which is imperceptible for modem protocols.
   */
  constructor(opts = {}) {
    super();
    this._playoutMode  = opts.playoutMode || 'buffered';
    if (this._playoutMode !== 'buffered' &&
        this._playoutMode !== 'immediate' &&
        this._playoutMode !== 'fixed-buffered') {
      throw new TypeError(
        `RtpSession: playoutMode must be 'buffered', 'immediate', or 'fixed-buffered', got ${this._playoutMode}`);
    }
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

    // Optional TX timing trace for diagnostics. Records the wall-clock
    // ns timestamp of every send() call, plus the RTP sequence number,
    // into a pre-allocated typed array. If set, the trace can be
    // dumped to disk via dumpTxTimingTrace() on session end. The
    // recorder is allocated once at start; if more sends than
    // _txTraceCapacity occur, later samples are dropped (we want
    // a fixed-size circular buffer's worth of evidence rather than
    // unbounded growth on multi-hour calls).
    //
    // Disabled by default — enable via opts.traceTxTiming. See
    // tools/analyze-tx-timing.js for the analysis side.
    this._txTraceEnabled = !!opts.traceTxTiming;
    this._txTraceCapacity = (opts.traceMaxPackets | 0) || 100_000;
    this._txTraceTimes = null;   // BigInt64Array allocated lazily
    this._txTraceSeqs  = null;   // Uint16Array
    this._txTraceCount = 0;
    this._txTraceStart = 0n;     // hrtime ns at first send (reference point)
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

  /**
   * Adopt an externally-bound dgram socket as our RTP socket.
   * Used by CallSession in `auto` backend mode when transitioning from
   * b2bua (PjsipBackend, which holds the socket) to pcm (RtpSession,
   * which now needs it). PjsipBackend's RtpBridge.stop() removes its
   * own 'message' listener but leaves the socket alive — adopting it
   * here installs RtpSession's listeners and starts processing.
   *
   * The caller is responsible for ensuring the socket is bound and
   * has no pre-existing 'message' listener (or accepts that any
   * other listener will see packets in parallel).
   *
   * Idempotent guards: must not have an existing socket. Throws if
   * `open()` already ran on this instance.
   *
   * @param {dgram.Socket} socket  Pre-bound UDP socket to take over.
   */
  adoptSocket(socket) {
    if (this._socket) {
      throw new Error('RtpSession.adoptSocket: already has a socket');
    }
    this._socket = socket;
    this._localPort = socket.address ? socket.address().port : null;
    this._socket.on('error', err => {
      log.error('RTP socket error (adopted)', { err: err.message });
      this.emit('error', err);
    });
    this._socket.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
    this._running = true;
    log.debug(`RTP socket adopted on port ${this._localPort}`);
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

    // Immediate mode: skip the jitter buffer entirely. Decode and
    // emit right now so modem DSPs see every real sample with no
    // concealment zeros inserted. Out-of-order packets arrive out
    // of order (acceptable on LAN). Duplicate packets also slip
    // through; they're rare, and a duplicate late-arriving packet
    // isn't as bad for a modem as a silence frame.
    if (this._playoutMode === 'immediate') {
      this._deliverAudio(payload, pt);
      return;
    }

    // Jitter buffer insert
    this._jitterBuf.set(seq & 0xffff, { payload, timestamp, pt, received: Date.now() });

    if (this._playoutMode === 'fixed-buffered') {
      // Fixed-buffered (D-Modem) mode: don't start the playout timer
      // until the buffer has accumulated jitterBufferInitDepth packets.
      // When we start, we set _nextPlaySeq to the EARLIEST seq we
      // currently hold, so playback begins with the oldest pre-buffered
      // packet (the whole buffer then drains over ~initDepth × 20ms
      // before new arrivals top it back up). Once started, we never
      // re-enter this branch because the timer just runs until close.
      if (this._nextPlaySeq === null) {
        const initDepth = cfg.jitterBufferInitDepth | 0;
        if (this._jitterBuf.size >= initDepth) {
          // Find the smallest seq in the buffer — that's where playout
          // begins. We use the RTP seq's natural 16-bit wrap-aware
          // "earliest" by picking the seq whose gap to the newest
          // arrival seq is largest (but still ≤ the buffer size).
          let earliest = null;
          for (const k of this._jitterBuf.keys()) {
            if (earliest === null) { earliest = k; continue; }
            // 16-bit signed distance k − earliest (positive = k is later)
            const d = ((k - earliest) << 16) >> 16;
            if (d < 0) earliest = k;
          }
          this._nextPlaySeq = earliest;
          log.debug(`Fixed jitter buffer filled to ${initDepth} pkts; starting playout at seq=${earliest}`);
          this._startPlayoutTimer();
        }
      }

      // Guard against runaway buffer growth.
      const maxDepth = cfg.jitterBufferMaxDepth | 0;
      if (maxDepth > 0 && this._jitterBuf.size > maxDepth) {
        this._flushOldest();
      }
      return;
    }

    // Initialise play-out pointer on first packet (legacy 'buffered' mode)
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
      return;
    }

    // Packet not present for this tick.
    //
    // Fixed-buffered (D-Modem) mode: this tick is a MISS, which in
    // modem-friendly terms means "the next packet in sequence hasn't
    // arrived yet." We do NOT emit concealment silence — that would
    // inject bogus samples into the modem DSP's input and break the
    // carrier lock. We simply skip this tick and wait for the packet.
    // The buffered-but-unplayed packets accumulate, which is fine:
    // that's the whole point of the fixed queue depth.
    //
    // Only if we've missed many ticks in a row AND the buffer has
    // clearly given up on that seq (later seqs have arrived and the
    // missing one is far behind) do we skip past it. That's
    // catastrophic loss recovery, not routine concealment.
    if (this._playoutMode === 'fixed-buffered') {
      this._silenceCount++;
      const missThreshold = (cfg.jitterBufferMissSkipTicks | 0) || 50; // 1s at 20ms
      if (this._silenceCount >= missThreshold && this._jitterBuf.size > 0) {
        // Give up on `seq`; advance to the smallest seq that IS in
        // the buffer, so long as the forward distance is bounded.
        let nearestFuture = null;
        let nearestDelta  = Infinity;
        for (const k of this._jitterBuf.keys()) {
          const d = ((k - seq) << 16) >> 16; // signed 16-bit delta
          if (d > 0 && d < nearestDelta) { nearestDelta = d; nearestFuture = k; }
        }
        if (nearestFuture !== null && nearestDelta <= cfg.maxSeqGap) {
          log.warn(`Fixed jitter: dropping missing seq=${seq}, resuming at seq=${nearestFuture} (lost ${nearestDelta} pkts)`);
          this._nextPlaySeq = nearestFuture;
          this._silenceCount = 0;
        }
      }
      return;
    }

    // Legacy 'buffered' (voice) behaviour: emit concealment silence
    // and speculatively skip ahead if the buffer is growing.
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

    // Record send timing (cheap: one hrtime call + one array store)
    if (this._txTraceEnabled) {
      if (this._txTraceTimes === null) {
        this._txTraceTimes = new BigInt64Array(this._txTraceCapacity);
        this._txTraceSeqs  = new Uint16Array(this._txTraceCapacity);
        this._txTraceStart = process.hrtime.bigint();
      }
      if (this._txTraceCount < this._txTraceCapacity) {
        this._txTraceTimes[this._txTraceCount] =
          process.hrtime.bigint() - this._txTraceStart;
        this._txTraceSeqs[this._txTraceCount] = this._sendSeq & 0xffff;
        this._txTraceCount++;
      }
    }

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
   * Dump the TX timing trace as a JSON-readable text file. Each line
   * is one packet: `<elapsed_us>\t<seq>` where elapsed_us is microseconds
   * since the first traced send. Returns true if anything was written
   * (false if trace was disabled or empty).
   *
   * @param {string} filepath  Absolute path to write the trace to.
   */
  dumpTxTimingTrace(filepath) {
    if (!this._txTraceEnabled || this._txTraceCount === 0) return false;
    const fs = require('fs');
    const lines = ['# elapsed_us\tseq'];
    for (let i = 0; i < this._txTraceCount; i++) {
      const us = Number(this._txTraceTimes[i] / 1000n);
      lines.push(`${us}\t${this._txTraceSeqs[i]}`);
    }
    fs.writeFileSync(filepath, lines.join('\n') + '\n');
    return true;
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
