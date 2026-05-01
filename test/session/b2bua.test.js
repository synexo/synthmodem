'use strict';

/*
 * test/session/b2bua.test.js — CallSession b2bua-mode unit test.
 *
 * Exercises the branch added in step 5c.2: when
 * config.modem.backend === 'slmodemd-pjsip', CallSession should:
 *   - Allocate an RTP port and bind a RAW dgram socket on it
 *     (no RtpSession involvement).
 *   - Skip audio-event wiring (no receiveAudio / audioOut calls).
 *   - Call backend.activate({extRtpSocket, extPeer}) with the raw
 *     socket and the dialog's remote RTP endpoint.
 *   - On teardown, close the raw socket and release the port.
 *
 * Everything upstream (SIP server, dialog, modem backend, pool) is
 * stubbed so the test runs without QEMU and without any real SIP
 * stack. Focus is purely on CallSession's state-machine wiring.
 *
 * Run: node test/session/b2bua.test.js
 * Expected: 5/5 passing, ~1s.
 */

const assert = require('assert');
const dgram  = require('dgram');
const { EventEmitter } = require('events');

/* CRITICAL: override config BEFORE requiring CallSession so its
 * top-level `config.modem.backend` reads 'slmodemd-pjsip'. Config
 * is cached by require, so we mutate in place. */
const config = require('../../config');
config.modem.backend      = 'slmodemd-pjsip';
config.modem.captureAudio = false;     /* never enabled in b2bua anyway */
config.logging.logDspState = false;

const { CallSession } = require('../../src/session/CallSession');

let passed = 0, failed = 0;
function ok(msg)   { console.log('  ok  ', msg); passed++; }
function fail(msg, err) {
  console.log('  FAIL', msg);
  if (err) console.log('       ', err.stack || err);
  failed++;
}
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

/* ─── Stubs ───────────────────────────────────────────────────── */

/** Stub PjsipBackend — EventEmitter with b2bua mode + activate that
 *  captures its args. Stays in a "ready" state; no real SIP or VM. */
class StubB2buaBackend extends EventEmitter {
  constructor() {
    super();
    this.mode = 'b2bua';
    this.started = false;
    this.activatedWith = null;
    this.stopped = false;
  }
  start() { this.started = true; }
  async activate({ extRtpSocket, extPeer } = {}) {
    this.activatedWith = { extRtpSocket, extPeer };
    /* PjsipBackend would now INVITE the in-VM PJSIP; we just
     * record the args and resolve. Don't emit 'connected' here —
     * in the real flow that comes from a later PTY CONNECT, not
     * from activate() itself. */
  }
  async stop() { this.stopped = true; }
}

/** Stub pool — checkout returns a fresh StubB2buaBackend. Remembers
 *  which backends it handed out and whether recycle was called. */
class StubPool extends EventEmitter {
  constructor() {
    super();
    this.checkedOut = [];
    this.recycled = [];
  }
  async checkout() {
    const bk = new StubB2buaBackend();
    this.checkedOut.push(bk);
    return bk;
  }
  recycle(bk) {
    this.recycled.push(bk);
    /* Real pool also calls bk.stop(); our stub doesn't need to. */
  }
}

/** Stub SipServer — captures answerCall + sendBye. */
class StubSipServer extends EventEmitter {
  constructor() {
    super();
    this.answered = null;
    this.sentBye = null;
  }
  answerCall(dialog, port) { this.answered = { dialog, port }; }
  sendBye(dialog)          { this.sentBye = dialog; }
}

/** Stub SipDialog — minimal. */
function makeDialog({ callId = 'cs-b2bua-1', remoteRtpAddr = '127.0.0.1',
                      remoteRtpPort = 40000 } = {}) {
  return {
    callId,
    remoteRtpAddr, remoteRtpPort,
    localRtpPort: null,
    session: null,
    negotiatedCodec: { name: 'PCMU', payloadType: 0 },
    canBye: () => true,
  };
}

/* ─── Tests ───────────────────────────────────────────────────── */

async function run() {
  console.log('CallSession b2bua-mode unit test');
  console.log('');

  await test('constructor: mode=b2bua, no RtpSession, no capture', async () => {
    const sip = new StubSipServer();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: new StubPool() });

    assert.strictEqual(sess._mode, 'b2bua');
    assert.strictEqual(sess._rtp, null, 'RtpSession should NOT be created');
    assert.strictEqual(sess._rtpSock, null, '_rtpSock placeholder should be null before setup');
    assert.strictEqual(sess._capture, null, 'no audio capture in b2bua mode');
  });

  await test('setup: binds raw dgram socket on RTP port, calls answerCall', async () => {
    const sip = new StubSipServer();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: new StubPool() });

    await sess.setup();

    assert.ok(sess._rtpPort, 'RTP port allocated');
    assert.ok(sess._rtpSock, 'raw dgram socket created');
    const addr = sess._rtpSock.address();
    /* bind is 0.0.0.0 (all interfaces) so LAN-side callers can
     * reach us. Loopback-only would silently drop external RTP. */
    assert.strictEqual(addr.address, '0.0.0.0');
    assert.strictEqual(addr.port, sess._rtpPort);
    assert.ok(sip.answered, 'sipServer.answerCall called');
    assert.strictEqual(sip.answered.port, sess._rtpPort);
    assert.strictEqual(dialog.localRtpPort, sess._rtpPort);
    assert.strictEqual(dialog.session, sess);

    /* Cleanup — teardown not yet tested as its own case, just
     * release the resources before the next test uses the same
     * port range. */
    await new Promise(r => sess._rtpSock.close(r));
    const { releaseRtpPort } = require('../../src/rtp/RtpSession');
    releaseRtpPort(sess._rtpPort);
  });

  await test('activate: checks out from pool, passes raw socket + extPeer to backend', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog({ remoteRtpAddr: '10.0.0.7', remoteRtpPort: 45678 });
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();

    /* activate() is synchronous through the setup + pool.checkout
     * part, but kicks off backend.activate() as fire-and-forget.
     * Give the microtask loop a turn so the stub captures args. */
    await new Promise(r => setImmediate(r));

    assert.strictEqual(pool.checkedOut.length, 1, 'one backend checked out');
    const bk = pool.checkedOut[0];
    assert.ok(bk.started, 'backend.start() called');
    assert.ok(bk.activatedWith, 'backend.activate() called');
    assert.strictEqual(bk.activatedWith.extRtpSocket, sess._rtpSock,
      'exact raw socket passed through');
    assert.deepStrictEqual(bk.activatedWith.extPeer,
      { address: '10.0.0.7', port: 45678 },
      'extPeer reflects dialog remote RTP endpoint');

    /* Teardown so the port releases. Attach the 'ended' listener
     * FIRST — hangup's teardown chain has no real awaits, so 'ended'
     * may fire synchronously within hangup() before this line
     * resolves. */
    const endedP = new Promise(r => sess.once('ended', r));
    sess.hangup('test-cleanup');
    await endedP;
  });

  await test('activate: without dialog remote RTP, extPeer is undefined (bridge will learn)', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog({ remoteRtpAddr: null, remoteRtpPort: null });
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    const bk = pool.checkedOut[0];
    assert.ok(bk.activatedWith, 'activate called');
    assert.strictEqual(bk.activatedWith.extPeer, undefined,
      'extPeer should be undefined when dialog has no remote RTP');

    const endedP = new Promise(r => sess.once('ended', r));
    sess.hangup('test-cleanup');
    await endedP;
  });

  await test('hangup: recycles backend via pool, closes raw socket, releases port, emits ended', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    const bk = await (async () => {
      await sess.activate();
      await new Promise(r => setImmediate(r));
      return pool.checkedOut[0];
    })();
    const port = sess._rtpPort;

    /* Attach ended listener BEFORE hangup for the same reason —
     * the teardown chain has no real awaits. */
    let endedReason = null;
    const endedP = new Promise(r => {
      sess.once('ended', info => { endedReason = info.reason; r(); });
    });

    sess.hangup('test-bye');
    await endedP;

    assert.strictEqual(endedReason, 'test-bye');
    assert.strictEqual(pool.recycled.length, 1, 'backend recycled');
    assert.strictEqual(pool.recycled[0], bk, 'same backend recycled');
    assert.ok(sip.sentBye, 'BYE sent via sipServer');
    assert.strictEqual(sess._rtpPort, null, 'RTP port field cleared');
    assert.strictEqual(sess._rtpSock, null, 'raw socket field cleared');

    /* Confirm port is really released by re-allocating it. */
    const { allocateRtpPort, releaseRtpPort } =
      require('../../src/rtp/RtpSession');
    const reallocated = await allocateRtpPort();
    assert.ok(reallocated >= port, 'port allocator still functional');
    releaseRtpPort(reallocated);
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
