'use strict';

/*
 * test/slmodem/wire.test.js — unit tests for the Node-side wire parser.
 *
 * Tests cover:
 *   - round-trip encode → parse for every message type
 *   - byte-for-byte frame layout matches wire.h
 *   - correct handling of chunked input (byte-at-a-time feeds)
 *   - correct handling of multiple frames in a single chunk
 *   - framing error on bogus length
 *   - empty-payload frames (SILENCE, HANGUP)
 *   - large audio frame at exactly WIRE_AUDIO_BYTES
 *   - oversized payload rejected at encode time
 *
 * Run:  node test/slmodem/wire.test.js
 *
 * No test framework dependency — we're only adding code the product
 * doesn't need. Tiny assert + manual fail collection suffices for the
 * volume of tests we have here.
 */

const assert = require('assert');
const {
  WIRE_VERSION, WIRE_HEADER_SIZE, WIRE_MAX_PAYLOAD, WIRE_AUDIO_BYTES,
  TYPE, typeName, encode, Parser,
} = require('../../vm/qemu-runner/wire');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

console.log('wire.js unit tests');
console.log('==================');

// ─── Constants ─────────────────────────────────────────────────────────────

test('constants match wire.h', () => {
  assert.strictEqual(WIRE_VERSION, 1);
  assert.strictEqual(WIRE_HEADER_SIZE, 3);
  assert.strictEqual(WIRE_MAX_PAYLOAD, 4093);
  assert.strictEqual(WIRE_AUDIO_BYTES, 320);
});

test('type values match wire.h', () => {
  assert.strictEqual(TYPE.AUDIO,        0x01);
  assert.strictEqual(TYPE.SILENCE,      0x02);
  assert.strictEqual(TYPE.HELLO,        0x10);
  assert.strictEqual(TYPE.AT,           0x11);
  assert.strictEqual(TYPE.AT_RESPONSE,  0x12);
  assert.strictEqual(TYPE.MODEM_STATUS, 0x13);
  assert.strictEqual(TYPE.DATA_TX,      0x14);
  assert.strictEqual(TYPE.DATA_RX,      0x15);
  assert.strictEqual(TYPE.HANGUP,       0x16);
  assert.strictEqual(TYPE.DUMP_REQUEST, 0x17);
  assert.strictEqual(TYPE.DUMP_DATA,    0x18);
  assert.strictEqual(TYPE.DUMP_DONE,    0x19);
});

test('typeName returns readable strings', () => {
  assert.strictEqual(typeName(TYPE.AUDIO), 'AUDIO');
  assert.strictEqual(typeName(TYPE.HELLO), 'HELLO');
  assert.strictEqual(typeName(0xff), '0xff');
});

// ─── Encode ────────────────────────────────────────────────────────────────

test('encode: AT command has correct byte layout', () => {
  const f = encode(TYPE.AT, 'ATI');
  // length = type(1) + payload(3) = 4 → [04, 00]
  assert.strictEqual(f.length, 3 + 3);
  assert.strictEqual(f.readUInt16LE(0), 4);
  assert.strictEqual(f.readUInt8(2), TYPE.AT);
  assert.strictEqual(f.slice(3).toString('utf8'), 'ATI');
});

test('encode: empty payload (HANGUP) has length 1', () => {
  const f = encode(TYPE.HANGUP);
  assert.strictEqual(f.length, 3);
  assert.strictEqual(f.readUInt16LE(0), 1);
  assert.strictEqual(f.readUInt8(2), TYPE.HANGUP);
});

test('encode: null payload works', () => {
  const f = encode(TYPE.SILENCE, null);
  assert.strictEqual(f.length, 3);
  assert.strictEqual(f.readUInt16LE(0), 1);
  assert.strictEqual(f.readUInt8(2), TYPE.SILENCE);
});

test('encode: Buffer payload passes through', () => {
  const audio = Buffer.alloc(WIRE_AUDIO_BYTES);
  for (let i = 0; i < audio.length; i++) audio[i] = i & 0xff;
  const f = encode(TYPE.AUDIO, audio);
  assert.strictEqual(f.length, 3 + WIRE_AUDIO_BYTES);
  assert.strictEqual(f.readUInt16LE(0), 1 + WIRE_AUDIO_BYTES);
  assert.deepStrictEqual(f.slice(3), audio);
});

test('encode: Uint8Array payload works', () => {
  const u = new Uint8Array([1, 2, 3]);
  const f = encode(TYPE.DATA_TX, u);
  assert.deepStrictEqual(f.slice(3), Buffer.from([1, 2, 3]));
});

test('encode: rejects oversized payload', () => {
  const huge = Buffer.alloc(WIRE_MAX_PAYLOAD + 1);
  assert.throws(() => encode(TYPE.AUDIO, huge), /exceeds/);
});

test('encode: accepts exactly WIRE_MAX_PAYLOAD', () => {
  const max = Buffer.alloc(WIRE_MAX_PAYLOAD);
  const f = encode(TYPE.AUDIO, max);
  assert.strictEqual(f.length, 3 + WIRE_MAX_PAYLOAD);
});

test('encode: rejects invalid payload type', () => {
  assert.throws(() => encode(TYPE.AT, 42), /unsupported/);
});

// ─── Parser: round-trip ────────────────────────────────────────────────────

function collect(frames) {
  const out = [];
  const p = new Parser();
  p.on('frame', f => out.push(f));
  p.on('error', err => out.push({ error: err.message }));
  for (const chunk of frames) p.feed(chunk);
  return out;
}

test('parser: round-trips a single AT frame', () => {
  const enc = encode(TYPE.AT, 'ATDT5551212');
  const got = collect([enc]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].type, TYPE.AT);
  assert.strictEqual(got[0].payload.toString('utf8'), 'ATDT5551212');
});

test('parser: round-trips an audio frame', () => {
  const audio = Buffer.alloc(WIRE_AUDIO_BYTES);
  for (let i = 0; i < audio.length; i++) audio[i] = (i * 7) & 0xff;
  const enc = encode(TYPE.AUDIO, audio);
  const got = collect([enc]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].type, TYPE.AUDIO);
  assert.deepStrictEqual(got[0].payload, audio);
});

test('parser: round-trips empty-payload frames', () => {
  const enc = Buffer.concat([encode(TYPE.SILENCE), encode(TYPE.HANGUP)]);
  const got = collect([enc]);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].type, TYPE.SILENCE);
  assert.strictEqual(got[0].payload.length, 0);
  assert.strictEqual(got[1].type, TYPE.HANGUP);
  assert.strictEqual(got[1].payload.length, 0);
});

test('parser: handles multiple frames in one feed', () => {
  const buf = Buffer.concat([
    encode(TYPE.HELLO, 'modemd-shim v1 build=test'),
    encode(TYPE.AT_RESPONSE, '\r\nOK\r\n'),
    encode(TYPE.MODEM_STATUS, '{"event":"connect","rate":33600}'),
  ]);
  const got = collect([buf]);
  assert.strictEqual(got.length, 3);
  assert.strictEqual(got[0].type, TYPE.HELLO);
  assert.strictEqual(got[1].type, TYPE.AT_RESPONSE);
  assert.strictEqual(got[2].type, TYPE.MODEM_STATUS);
});

test('parser: handles byte-at-a-time feed (worst case chunking)', () => {
  const enc = encode(TYPE.AT, 'AT+MS=?');
  const chunks = [];
  for (let i = 0; i < enc.length; i++) chunks.push(enc.slice(i, i + 1));
  const got = collect(chunks);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].type, TYPE.AT);
  assert.strictEqual(got[0].payload.toString('utf8'), 'AT+MS=?');
});

test('parser: handles split-across-chunks frames', () => {
  const buf = Buffer.concat([
    encode(TYPE.AUDIO, Buffer.alloc(WIRE_AUDIO_BYTES, 0xAA)),
    encode(TYPE.AT_RESPONSE, 'CONNECT 9600\r\n'),
  ]);
  // Arbitrary split point in the middle of frame 1
  const splits = [
    buf.slice(0, 50),
    buf.slice(50, 100),
    buf.slice(100, 200),
    buf.slice(200),
  ];
  const got = collect(splits);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].type, TYPE.AUDIO);
  assert.strictEqual(got[0].payload.length, WIRE_AUDIO_BYTES);
  // spot-check payload
  for (let i = 0; i < WIRE_AUDIO_BYTES; i++) {
    if (got[0].payload[i] !== 0xAA) throw new Error(`payload byte ${i} != 0xAA`);
  }
  assert.strictEqual(got[1].type, TYPE.AT_RESPONSE);
  assert.strictEqual(got[1].payload.toString('utf8'), 'CONNECT 9600\r\n');
});

test('parser: payload data is copied, not aliased into parser buffer', () => {
  // Regression: if we slice without copying, a later feed() might
  // clobber data a consumer is still holding. We verify by sending a
  // second VALID frame after the first and checking the first
  // payload is unchanged.
  const enc1 = encode(TYPE.AT, 'ABC');
  const enc2 = encode(TYPE.AT, 'XYZ');
  const p = new Parser();
  let firstPayload = null;
  const all = [];
  p.on('frame', f => { all.push(f); if (!firstPayload) firstPayload = f.payload; });
  p.feed(enc1);
  p.feed(enc2);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(firstPayload.toString('utf8'), 'ABC',
    'first frame payload clobbered by subsequent feed');
});

// ─── Parser: errors ────────────────────────────────────────────────────────

test('parser: fatal on length == 0', () => {
  const bad = Buffer.from([0x00, 0x00, 0x11]);
  const got = collect([bad]);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].error && /< 1/.test(got[0].error));
});

test('parser: fatal on oversize length', () => {
  // Claim a payload of WIRE_MAX_PAYLOAD + 10
  const wlen = WIRE_MAX_PAYLOAD + 10;
  const bad = Buffer.alloc(3);
  bad.writeUInt16LE(wlen, 0);
  bad.writeUInt8(TYPE.AT, 2);
  const got = collect([bad]);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].error && /exceeds/.test(got[0].error));
});

test('parser: stays dead after error, then revives on reset', () => {
  const p = new Parser();
  const frames = [];
  const errors = [];
  p.on('frame', f => frames.push(f));
  p.on('error', e => errors.push(e));
  p.feed(Buffer.from([0x00, 0x00, 0x11]));            // bad
  p.feed(encode(TYPE.AT, 'hello'));                    // should be ignored
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(frames.length, 0);
  p.reset();
  p.feed(encode(TYPE.AT, 'hello'));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].payload.toString('utf8'), 'hello');
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
