'use strict';

/*
 * test/rtp/bridge.test.js — RtpBridge unit tests.
 *
 * Three UDP sockets on loopback: ext-peer, int-peer, and the bridge
 * (which owns two sockets itself). Send a packet from each peer and
 * verify it comes out the other side byte-identical.
 *
 * No VM, no tunnel. ~200ms total.
 *
 * Run: node test/rtp/bridge.test.js
 */

const assert = require('assert');
const dgram  = require('dgram');
const { RtpBridge } = require('../../src/rtp/RtpBridge');

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

function bindLoopback() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, '127.0.0.1', () => {
      s.removeListener('error', reject);
      resolve(s);
    });
  });
}

function waitMessage(sock, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message within ${timeoutMs}ms`)), timeoutMs);
    sock.once('message', (msg, rinfo) => {
      clearTimeout(timer);
      resolve({ msg, rinfo });
    });
  });
}

async function run() {
  console.log('RtpBridge unit tests');
  console.log('');

  // ─── Happy path: explicit peers set on creation ────────────────
  await test('forwards ext→int and int→ext with explicit peers', async () => {
    const extPeer = await bindLoopback();
    const intPeer = await bindLoopback();
    const brExt   = await bindLoopback();
    const brInt   = await bindLoopback();

    try {
      const bridge = new RtpBridge({
        extSocket: brExt,
        intSocket: brInt,
        extPeer:  { address: '127.0.0.1', port: extPeer.address().port },
        intPeer:  { address: '127.0.0.1', port: intPeer.address().port },
      });
      bridge.start();

      /* ext → int: caller sends to brExt, should reach intPeer */
      const payload1 = Buffer.from('abcdefghij');
      extPeer.send(payload1, brExt.address().port, '127.0.0.1');
      const rx1 = await waitMessage(intPeer);
      assert.deepStrictEqual(rx1.msg, payload1);

      /* int → ext: PJSIP side sends to brInt, should reach extPeer */
      const payload2 = Buffer.from([1, 2, 3, 4, 5]);
      intPeer.send(payload2, brInt.address().port, '127.0.0.1');
      const rx2 = await waitMessage(extPeer);
      assert.deepStrictEqual(rx2.msg, payload2);

      assert.strictEqual(bridge.stats.extToInt.packets, 1);
      assert.strictEqual(bridge.stats.intToExt.packets, 1);
      assert.strictEqual(bridge.stats.extToInt.bytes, 10);
      assert.strictEqual(bridge.stats.intToExt.bytes, 5);

      bridge.stop();
    } finally {
      extPeer.close(); intPeer.close(); brExt.close(); brInt.close();
    }
  });

  // ─── Ext peer learned from first packet ─────────────────────────
  await test('learns extPeer from first ext-side packet', async () => {
    const extPeer = await bindLoopback();
    const intPeer = await bindLoopback();
    const brExt   = await bindLoopback();
    const brInt   = await bindLoopback();

    try {
      const bridge = new RtpBridge({
        extSocket: brExt,
        intSocket: brInt,
        /* no extPeer */
        intPeer:  { address: '127.0.0.1', port: intPeer.address().port },
      });
      bridge.start();

      /* Before learning: int→ext should drop (no ext peer) */
      intPeer.send(Buffer.from('nope'), brInt.address().port, '127.0.0.1');
      await new Promise(r => setTimeout(r, 50));
      assert.strictEqual(bridge.stats.intToExtDrops, 1);

      /* Send ext→int — bridge learns extPeer from source */
      extPeer.send(Buffer.from('first'), brExt.address().port, '127.0.0.1');
      await waitMessage(intPeer);
      assert.ok(bridge.extPeer);
      assert.strictEqual(bridge.extPeer.port, extPeer.address().port);

      /* Now int→ext should work */
      intPeer.send(Buffer.from('reply'), brInt.address().port, '127.0.0.1');
      const rx = await waitMessage(extPeer);
      assert.deepStrictEqual(rx.msg, Buffer.from('reply'));

      bridge.stop();
    } finally {
      extPeer.close(); intPeer.close(); brExt.close(); brInt.close();
    }
  });

  // ─── stop() stops forwarding ────────────────────────────────────
  await test('stop() halts forwarding', async () => {
    const extPeer = await bindLoopback();
    const intPeer = await bindLoopback();
    const brExt   = await bindLoopback();
    const brInt   = await bindLoopback();

    try {
      const bridge = new RtpBridge({
        extSocket: brExt,
        intSocket: brInt,
        extPeer:  { address: '127.0.0.1', port: extPeer.address().port },
        intPeer:  { address: '127.0.0.1', port: intPeer.address().port },
      });
      bridge.start();
      bridge.stop();

      /* After stop, packets shouldn't be forwarded */
      extPeer.send(Buffer.from('silent'), brExt.address().port, '127.0.0.1');
      await new Promise(r => setTimeout(r, 100));
      /* intPeer should have received nothing — verified by timeout */
      let got = null;
      intPeer.once('message', m => { got = m; });
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(got, null);
    } finally {
      extPeer.close(); intPeer.close(); brExt.close(); brInt.close();
    }
  });

  // ─── Large payload (typical RTP is ~160 bytes; prove no cap) ────
  await test('forwards large payloads byte-identically', async () => {
    const extPeer = await bindLoopback();
    const intPeer = await bindLoopback();
    const brExt   = await bindLoopback();
    const brInt   = await bindLoopback();

    try {
      const bridge = new RtpBridge({
        extSocket: brExt,
        intSocket: brInt,
        extPeer:  { address: '127.0.0.1', port: extPeer.address().port },
        intPeer:  { address: '127.0.0.1', port: intPeer.address().port },
      });
      bridge.start();

      /* 1200 bytes — larger than real RTP, smaller than MTU */
      const payload = Buffer.alloc(1200);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xFF;
      extPeer.send(payload, brExt.address().port, '127.0.0.1');
      const rx = await waitMessage(intPeer);
      assert.deepStrictEqual(rx.msg, payload);

      bridge.stop();
    } finally {
      extPeer.close(); intPeer.close(); brExt.close(); brInt.close();
    }
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
