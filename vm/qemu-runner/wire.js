'use strict';

/*
 * wire.js — Node side of the synthmodem ↔ modemd-shim wire protocol.
 *
 * Mirrors vm/shim/wire.h exactly. Any change to the protocol must be
 * made in BOTH places and exercised by the round-trip test in
 * test/slmodem/wire.test.js.
 *
 * Provides:
 *   TYPE                   object of message-type constants
 *   encode(type, payload)  → Buffer ready for socket.write()
 *   Parser                 class; feed it chunks with .feed(buf), it
 *                          emits 'frame' events with {type, payload}
 *
 * Design notes:
 *
 *   - Purely synchronous. No backpressure handling here — that's the
 *     caller's job on the socket level. Parser buffers internally
 *     until either a full frame is available or a hard cap is hit.
 *
 *   - Hard cap on payload size (WIRE_MAX_PAYLOAD) matches the C side.
 *     A framing desync that claims a >4 KiB payload is treated as a
 *     fatal protocol error — emits 'error' and refuses further bytes
 *     until .reset() is called.
 *
 *   - Unknown message types are emitted to the consumer (as {type,
 *     payload}) rather than silently dropped. This is the opposite
 *     choice from the C side. Rationale: Node consumers might log
 *     unknowns for debugging; unknown-type silent-ignore is the
 *     shim's responsibility for safety, not ours for visibility.
 */

const { EventEmitter } = require('events');

// ─── Protocol constants ────────────────────────────────────────────────────
// Must match wire.h byte-for-byte.

const WIRE_VERSION       = 1;
const WIRE_HEADER_SIZE   = 3;
const WIRE_MAX_PAYLOAD   = 4096 - WIRE_HEADER_SIZE;
const WIRE_AUDIO_BYTES   = 320;   // 160 int16LE samples @ 8 kHz = 20 ms
const WIRE_AUDIO_SAMPLES = 160;   // one audio frame = 160 samples

const TYPE = Object.freeze({
  AUDIO:         0x01,
  SILENCE:       0x02,
  HELLO:         0x10,
  AT:            0x11,
  AT_RESPONSE:   0x12,
  MODEM_STATUS:  0x13,
  DATA_TX:       0x14,
  DATA_RX:       0x15,
  HANGUP:        0x16,
  DUMP_REQUEST:  0x17,
  DUMP_DATA:     0x18,
  DUMP_DONE:     0x19,
});

/*
 * Reverse lookup for logging / debugging. Constructed once at module
 * load. Do not use in hot paths.
 */
const TYPE_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]))
);

function typeName(t) {
  return TYPE_NAME[t] || `0x${t.toString(16).padStart(2, '0')}`;
}

// ─── Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode a single wire frame.
 *
 * @param {number} type     one of TYPE.*
 * @param {Buffer|Uint8Array|string|null|undefined} payload
 *        Strings are encoded as UTF-8; null/undefined yields empty.
 * @returns {Buffer} ready-to-send frame (header + payload)
 * @throws {RangeError} if payload exceeds WIRE_MAX_PAYLOAD
 */
function encode(type, payload) {
  let body;
  if (payload == null) {
    body = Buffer.alloc(0);
  } else if (typeof payload === 'string') {
    body = Buffer.from(payload, 'utf8');
  } else if (Buffer.isBuffer(payload)) {
    body = payload;
  } else if (payload instanceof Uint8Array) {
    body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  } else {
    throw new TypeError(`encode: unsupported payload type ${typeof payload}`);
  }
  if (body.length > WIRE_MAX_PAYLOAD) {
    throw new RangeError(
      `encode: payload ${body.length} bytes exceeds WIRE_MAX_PAYLOAD (${WIRE_MAX_PAYLOAD})`);
  }
  const out = Buffer.allocUnsafe(WIRE_HEADER_SIZE + body.length);
  // length covers type + payload; type-only frame has length == 1
  out.writeUInt16LE(body.length + 1, 0);
  out.writeUInt8(type, 2);
  body.copy(out, WIRE_HEADER_SIZE);
  return out;
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Streaming frame parser.
 *
 * Usage:
 *   const p = new Parser();
 *   p.on('frame', ({type, payload}) => { ... });
 *   p.on('error', err => { ... });
 *   socket.on('data', chunk => p.feed(chunk));
 *
 * After emitting 'error', the parser is in a dead state. Call reset()
 * to clear and resume (destructive — will lose any buffered partial
 * frame). Typical consumer just tears down the connection instead.
 */
class Parser extends EventEmitter {
  constructor() {
    super();
    // Accumulator. Grown as needed; capped at WIRE_HEADER_SIZE +
    // WIRE_MAX_PAYLOAD so a bogus large-length header can't make us
    // allocate gigabytes.
    this._buf = Buffer.alloc(0);
    this._dead = false;
  }

  /**
   * Feed a chunk of bytes. Emits 'frame' for each complete frame
   * extracted. Emits 'error' (and enters dead state) on framing error.
   */
  feed(chunk) {
    if (this._dead) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    // Concatenate. For the traffic volumes we deal with (~16 KB/sec)
    // this is fine; no need for a ring buffer or chain structure.
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);

    // Extract as many complete frames as we can.
    while (this._buf.length >= WIRE_HEADER_SIZE) {
      const wlen = this._buf.readUInt16LE(0);
      if (wlen < 1) {
        this._fatal(new Error(`framing error: length ${wlen} < 1`));
        return;
      }
      if (wlen > WIRE_MAX_PAYLOAD + 1) {
        this._fatal(new Error(
          `framing error: length ${wlen} exceeds WIRE_MAX_PAYLOAD+1 (${WIRE_MAX_PAYLOAD + 1})`));
        return;
      }
      const frameSize = WIRE_HEADER_SIZE + (wlen - 1);
      if (this._buf.length < frameSize) break;  // need more bytes

      const type = this._buf.readUInt8(2);
      // Slice — shares memory with _buf, so we need to COPY if the
      // consumer might hold onto it past our next feed(). In practice
      // consumers process synchronously in the 'frame' handler, but
      // copying is cheap insurance and avoids a very subtle bug class.
      const payload = Buffer.from(this._buf.slice(WIRE_HEADER_SIZE, frameSize));

      // Advance buffer
      this._buf = this._buf.slice(frameSize);

      this.emit('frame', { type, payload });
    }
  }

  /** Clear all buffered state. Use after an error to resume (dangerous). */
  reset() {
    this._buf = Buffer.alloc(0);
    this._dead = false;
  }

  _fatal(err) {
    this._dead = true;
    this._buf = Buffer.alloc(0);
    this.emit('error', err);
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  WIRE_VERSION,
  WIRE_HEADER_SIZE,
  WIRE_MAX_PAYLOAD,
  WIRE_AUDIO_BYTES,
  WIRE_AUDIO_SAMPLES,
  TYPE,
  typeName,
  encode,
  Parser,
};
