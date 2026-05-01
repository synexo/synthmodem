'use strict';

/*
 * test/tunnel/framing.test.js — UdpTcpTunnel framing unit tests.
 *
 * Validates the Node-side frame layout matches PROTOCOL.md byte-for-
 * byte, and that the staged-read parser correctly reassembles frames
 * split across multiple read() calls.
 *
 * No VM, no real sockets — the tunnel is handed a stub "socket" that
 * captures writes. These tests are fast (~100ms total) and catch the
 * kind of off-by-one bugs that would otherwise require a 15-second VM
 * boot to find.
 *
 * Run: node test/tunnel/framing.test.js
 */

const assert = require('assert');
const { UdpTcpTunnel, CH_ECHO } = require('../../src/tunnel/UdpTcpTunnel');

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

/**
 * Minimal stub that looks enough like a net.Socket for the tunnel's
 * write path. Captures all bytes written to `captured`.
 */
function makeSocketStub() {
  return {
    captured: Buffer.alloc(0),
    write(buf) {
      this.captured = Buffer.concat([this.captured, Buffer.from(buf)]);
      return true;
    },
    destroy() {},
    on() {},
  };
}

function makeTunnel() {
  const t = new UdpTcpTunnel({ tcp: { host: '127.0.0.1', port: 9999 } });
  const stub = makeSocketStub();
  t.tcpSocket = stub;
  return { tunnel: t, stub };
}

async function run() {
  console.log('Tunnel framing unit tests');
  console.log('');

  await test('frame byte layout matches PROTOCOL.md spec (SIP "hello")', async () => {
    const { tunnel, stub } = makeTunnel();
    tunnel._sendFrame(0 /* SIP */, 5060, 5062, Buffer.from('hello'));

    const expected = Buffer.from([
      0x0A, 0x00,                              // length = 10
      0x00,                                     // channel = SIP
      0xC4, 0x13,                              // src_port = 5060 LE
      0xC6, 0x13,                              // dst_port = 5062 LE
      0x68, 0x65, 0x6C, 0x6C, 0x6F,           // "hello"
    ]);
    assert.deepStrictEqual(stub.captured, expected,
      `got ${stub.captured.toString('hex')}, want ${expected.toString('hex')}`);
  });

  await test('zero-length ECHO frame', async () => {
    const { tunnel, stub } = makeTunnel();
    tunnel._sendFrame(CH_ECHO, 0, 0, Buffer.alloc(0));

    const expected = Buffer.from([
      0x05, 0x00,             // length = 5 (header only)
      0xFF,                    // channel = 255 (ECHO)
      0x00, 0x00, 0x00, 0x00, // src=0, dst=0
    ]);
    assert.deepStrictEqual(stub.captured, expected);
  });

  await test('sendEcho API builds correct frame', async () => {
    const { tunnel, stub } = makeTunnel();
    tunnel.sendEcho('ping', 1234, 5678);

    const expected = Buffer.from([
      0x09, 0x00,                 // length = 9
      0xFF,                        // channel = ECHO
      0xD2, 0x04,                 // src = 1234
      0x2E, 0x16,                 // dst = 5678
      0x70, 0x69, 0x6E, 0x67,     // "ping"
    ]);
    assert.deepStrictEqual(stub.captured, expected);
  });

  await test('parser extracts channel/src/dst/payload from two frames', async () => {
    const { tunnel } = makeTunnel();
    const events = [];
    tunnel.on('frame-rx', (channel, src, dst, payload) => {
      events.push({ channel, src, dst, payload: payload.toString('utf8') });
    });

    const frame1 = Buffer.from([
      0x0A, 0x00, 0x00, 0xC4, 0x13, 0xC6, 0x13,
      0x68, 0x65, 0x6C, 0x6C, 0x6F,   // "hello"
    ]);
    const frame2 = Buffer.from([
      0x08, 0x00, 0x01, 0x10, 0x27, 0x12, 0x27,
      0x77, 0x6F, 0x72,               // "wor"
    ]);
    tunnel._onTcpData(Buffer.concat([frame1, frame2]));

    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[0],
      { channel: 0, src: 5060, dst: 5062, payload: 'hello' });
    assert.deepStrictEqual(events[1],
      { channel: 1, src: 10000, dst: 10002, payload: 'wor' });
  });

  await test('parser reassembles frames split across reads', async () => {
    const { tunnel } = makeTunnel();
    const payloads = [];
    tunnel.on('frame-rx', (_c, _s, _d, payload) => payloads.push(payload.toString('utf8')));

    const frame = Buffer.from([
      0x0A, 0x00, 0x00, 0xC4, 0x13, 0xC6, 0x13,
      0x68, 0x65, 0x6C, 0x6C, 0x6F,
    ]);
    for (let i = 0; i < frame.length; i++) {
      tunnel._onTcpData(frame.slice(i, i + 1));
    }
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0], 'hello');
  });

  await test('echo frames surface via echo-reply event', async () => {
    const { tunnel } = makeTunnel();
    const replies = [];
    tunnel.on('echo-reply', (payload, srcPort, dstPort) => {
      replies.push({ payload: payload.toString('utf8'), srcPort, dstPort });
    });

    const frame = Buffer.from([
      0x09, 0x00, 0xFF, 0x2E, 0x16, 0xD2, 0x04,
      0x70, 0x69, 0x6E, 0x67,
    ]);
    tunnel._onTcpData(frame);

    assert.strictEqual(replies.length, 1);
    assert.deepStrictEqual(replies[0],
      { payload: 'ping', srcPort: 5678, dstPort: 1234 });
  });

  await test('unknown channel IDs are dropped silently', async () => {
    const { tunnel } = makeTunnel();
    let echoCount = 0;
    tunnel.on('echo-reply', () => echoCount++);
    tunnel.on('error', () => { throw new Error('should not emit error'); });

    // channel = 99 (unknown), payload = "X"
    const frame = Buffer.from([
      0x06, 0x00, 0x63, 0x00, 0x00, 0x00, 0x00, 0x58,
    ]);
    tunnel._onTcpData(frame);
    assert.strictEqual(echoCount, 0);
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
