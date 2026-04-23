'use strict';

/*
 * test/slmodem/backend.test.js — unit tests for SlmodemBackend pure
 * helpers. Keeps fast, no subprocess required.
 */

const assert = require('assert');
const {
  pcmToFloat, floatToPcm, parseResultLine, RATE_TO_PROTOCOL,
} = require('../../src/backends/SlmodemBackend');
const wire = require('../../vm/qemu-runner/wire');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log('SlmodemBackend unit tests');
console.log('=========================');

// ─── PCM conversion ───

test('floatToPcm: zero in → zero out', () => {
  const f = new Float32Array(160);
  const p = floatToPcm(f);
  assert.strictEqual(p.length, wire.WIRE_AUDIO_BYTES);
  for (let i = 0; i < 160; i++) {
    assert.strictEqual(p.readInt16LE(i * 2), 0);
  }
});

test('floatToPcm: +1.0 → 32767', () => {
  const f = new Float32Array(160).fill(1.0);
  const p = floatToPcm(f);
  for (let i = 0; i < 160; i++) {
    assert.strictEqual(p.readInt16LE(i * 2), 32767);
  }
});

test('floatToPcm: -1.0 → -32767', () => {
  const f = new Float32Array(160).fill(-1.0);
  const p = floatToPcm(f);
  for (let i = 0; i < 160; i++) {
    assert.strictEqual(p.readInt16LE(i * 2), -32767);
  }
});

test('floatToPcm: values outside [-1,1] are clipped', () => {
  const f = new Float32Array([1.5, -1.5, 2.0, -2.0]);
  const p = floatToPcm(f);
  assert.strictEqual(p.readInt16LE(0), 32767);
  assert.strictEqual(p.readInt16LE(2), -32767);
  assert.strictEqual(p.readInt16LE(4), 32767);
  assert.strictEqual(p.readInt16LE(6), -32767);
});

test('floatToPcm: NaN → 0', () => {
  const f = new Float32Array([NaN, 0.5, NaN]);
  const p = floatToPcm(f);
  assert.strictEqual(p.readInt16LE(0), 0);
  assert.ok(Math.abs(p.readInt16LE(2) - 16383) < 2);
  assert.strictEqual(p.readInt16LE(4), 0);
});

test('pcmToFloat: round-trip is near-lossless', () => {
  const orig = new Float32Array(160);
  for (let i = 0; i < 160; i++) orig[i] = Math.sin(i * 0.1);
  const pcm = floatToPcm(orig);
  const back = pcmToFloat(pcm);
  assert.strictEqual(back.length, 160);
  for (let i = 0; i < 160; i++) {
    // 16-bit quantization error is bounded by 2^-15 ≈ 3e-5.
    assert.ok(Math.abs(back[i] - orig[i]) < 1e-4,
      `sample ${i} drifted: ${orig[i]} → ${back[i]}`);
  }
});

// ─── Result code parsing ───

test('parseResultLine: CONNECT with rate', () => {
  assert.deepStrictEqual(parseResultLine('CONNECT 33600'),
    { event: 'connect', rate: 33600 });
});

test('parseResultLine: CONNECT without rate', () => {
  assert.deepStrictEqual(parseResultLine('CONNECT'),
    { event: 'connect', rate: 0 });
});

test('parseResultLine: NO CARRIER', () => {
  assert.deepStrictEqual(parseResultLine('NO CARRIER'), { event: 'nocarrier' });
  assert.deepStrictEqual(parseResultLine('NOCARRIER'),  { event: 'nocarrier' });
  assert.deepStrictEqual(parseResultLine('no carrier'), { event: 'nocarrier' });
});

test('parseResultLine: BUSY / NO DIALTONE / ERROR / RING', () => {
  assert.deepStrictEqual(parseResultLine('BUSY'),        { event: 'busy' });
  assert.deepStrictEqual(parseResultLine('NO DIALTONE'), { event: 'nodialtone' });
  assert.deepStrictEqual(parseResultLine('ERROR'),       { event: 'error' });
  assert.deepStrictEqual(parseResultLine('RING'),        { event: 'ring' });
});

test('parseResultLine: unrelated lines return null', () => {
  assert.strictEqual(parseResultLine('OK'),             null);   // OK isn't stateful on its own
  assert.strictEqual(parseResultLine(''),               null);
  assert.strictEqual(parseResultLine('mock-slmodemd v0'), null);
  assert.strictEqual(parseResultLine('+MS: 132,1,,14400'), null);
});

// ─── Protocol mapping ───

test('RATE_TO_PROTOCOL: common rates mapped correctly', () => {
  assert.strictEqual(RATE_TO_PROTOCOL[300],   'V21');
  assert.strictEqual(RATE_TO_PROTOCOL[2400],  'V22bis');
  assert.strictEqual(RATE_TO_PROTOCOL[14400], 'V32bis');
  assert.strictEqual(RATE_TO_PROTOCOL[33600], 'V34');
  assert.strictEqual(RATE_TO_PROTOCOL[56000], 'V90');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
