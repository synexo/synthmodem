'use strict';

/*
 * test/session/auto.test.js — CallSession auto-mode swap orchestration.
 *
 * Exercises the swap path added for backend === 'auto':
 *
 *   1. Calls start in b2bua (PjsipBackend) mode for V.8 + high-rate.
 *   2. If the backend emits 'silenceHangup' WITHOUT having emitted
 *      'connected' first (the deterministic 12-second V.8 timeout
 *      pattern from vintage non-V.8 callers), CallSession swaps to a
 *      fresh in-process ModemDSP that takes over via skipV8/skipAnsam.
 *   3. The local RTP socket is adopted by the new RtpSession without
 *      rebinding (no port-reuse race).
 *   4. If 'connected' fires first, a later 'silenceHangup' tears down
 *      the call normally — no second swap.
 *
 * Everything except CallSession itself is stubbed: SIP server, dialog,
 * pool, backend. We do allocate a real dgram socket so adoptSocket has
 * something concrete to take over.
 *
 * Run: node test/session/auto.test.js
 */

const assert = require('assert');
const dgram  = require('dgram');
const { EventEmitter } = require('events');

/* CRITICAL: override config BEFORE requiring CallSession. */
const config = require('../../config');
config.modem.backend       = 'auto';
config.modem.captureAudio  = false;
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

/** Stub PjsipBackend with the b2bua interface. */
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
  }
  async stop() { this.stopped = true; }
}

/** Stub pool — exposes the methods CallSession uses. */
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
  recycle(bk) { this.recycled.push(bk); }
}

/** Stub SipServer. */
class StubSipServer extends EventEmitter {
  constructor() {
    super();
    this.answered = null;
    this.sentBye = null;
  }
  answerCall(dialog, port) { this.answered = { dialog, port }; }
  sendBye(dialog) { this.sentBye = dialog; }
}

function makeDialog({ callId = 'auto-1', remoteRtpAddr = '127.0.0.1',
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
  console.log('CallSession auto-mode swap test');
  console.log('');

  await test('constructor: auto starts in b2bua mode with swap flags reset', async () => {
    const sess = new CallSession(new StubSipServer(), makeDialog(),
                                 { modemPool: new StubPool() });
    assert.strictEqual(sess._mode, 'b2bua', 'auto starts as b2bua');
    assert.strictEqual(sess._everConnected, false);
    assert.strictEqual(sess._swapping, false);
    assert.strictEqual(sess._dspIsPooled, false);
    assert.strictEqual(sess._rtp, null, 'no RtpSession yet (b2bua phase)');
  });

  await test('activate: pool checkout sets _dspIsPooled=true', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    assert.strictEqual(pool.checkedOut.length, 1);
    assert.strictEqual(sess._dspIsPooled, true);
    assert.strictEqual(sess._dsp, pool.checkedOut[0]);

    const endedP = new Promise(r => sess.once('ended', r));
    sess.hangup('test-cleanup');
    await endedP;
  });

  await test('connected → later silenceHangup tears down (no swap)', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    const bk = pool.checkedOut[0];
    bk.emit('connected', { protocol: 'V32bis', bps: 14400 });
    assert.strictEqual(sess._everConnected, true,
      '_everConnected should be true after connected');

    /* Now emit silenceHangup. Should hang up, NOT swap. */
    const endedP = new Promise(r => sess.once('ended', r));
    bk.emit('silenceHangup');
    const result = await endedP;
    assert.strictEqual(sess._mode, 'b2bua',
      'mode should still be b2bua — no swap happened');
    assert.strictEqual(pool.recycled.length, 1, 'backend recycled on hangup');
    assert.ok(sip.sentBye, 'BYE sent on real hangup');
    assert.strictEqual(result.reason, 'silence');
  });

  await test('silenceHangup BEFORE connected → swaps to native', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    const oldBk = pool.checkedOut[0];
    const oldRtpSock = sess._rtpSock;
    assert.ok(oldRtpSock, 'pre-swap raw socket exists');

    /* Emit silenceHangup without ever firing 'connected' — vintage
     * caller pattern. Should swap, NOT hang up. */
    let endedFired = false;
    sess.once('ended', () => { endedFired = true; });
    oldBk.emit('silenceHangup');

    /* Swap is async (recycle, adoptSocket, ModemDSP construction).
     * Yield to microtasks so it completes. */
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(endedFired, false, 'session should NOT have ended');
    assert.strictEqual(sess._active, true, 'session still active');
    assert.strictEqual(sess._mode, 'pcm', 'mode swapped to pcm');
    assert.strictEqual(pool.recycled.length, 1, 'old backend recycled');
    assert.strictEqual(pool.recycled[0], oldBk);
    assert.strictEqual(sess._rtpSock, null, '_rtpSock transferred to RtpSession');
    assert.ok(sess._rtp, 'fresh RtpSession created');
    assert.strictEqual(sess._dspIsPooled, false,
      'post-swap DSP is not pooled');
    /* New DSP should be a real ModemDSP — has receiveAudio + audioOut. */
    assert.strictEqual(typeof sess._dsp.receiveAudio, 'function',
      'post-swap DSP exposes receiveAudio (native ModemDSP)');
    assert.strictEqual(sess._swapping, false, '_swapping reset after swap');

    /* Verify the adopted socket is the same object the bridge used. */
    /* (RtpSession owns it now via adoptSocket; we can't easily reach
     * into it, but it shouldn't have been closed yet.) */

    /* Cleanup. */
    const endedP = new Promise(r => sess.once('ended', r));
    sess.hangup('test-cleanup');
    await endedP;
  });

  await test('post-swap silenceHangup tears down normally (no second swap)', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    /* Trigger the swap. */
    pool.checkedOut[0].emit('silenceHangup');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.strictEqual(sess._mode, 'pcm', 'swap completed');

    /* Now emit silenceHangup from the post-swap DSP — should hang up
     * the call, NOT attempt another swap. */
    const endedP = new Promise(r => sess.once('ended', r));
    sess._dsp.emit('silenceHangup');
    const result = await endedP;
    assert.strictEqual(result.reason, 'silence');
    assert.ok(sip.sentBye, 'BYE sent on post-swap hangup');
  });

  await test('hangup during b2bua phase suppresses swap', async () => {
    const sip = new StubSipServer();
    const pool = new StubPool();
    const dialog = makeDialog();
    const sess = new CallSession(sip, dialog, { modemPool: pool });

    await sess.setup();
    await sess.activate();
    await new Promise(r => setImmediate(r));

    const bk = pool.checkedOut[0];

    /* Hang up explicitly. The backend then emits a stale silenceHangup
     * (race during teardown). The CallSession should NOT swap — it's
     * already torn down. */
    const endedP = new Promise(r => sess.once('ended', r));
    sess.hangup('test-explicit');
    bk.emit('silenceHangup');   /* stale event during teardown */
    await endedP;

    assert.strictEqual(sess._mode, 'b2bua', 'no swap happened');
    assert.strictEqual(pool.recycled.length, 1,
      'exactly one recycle (from hangup, not from swap)');
  });

  console.log('');
  console.log(`${passed}/${passed + failed} passed${failed ? ', ' + failed + ' FAILED' : ''}`);
  process.exit(failed ? 1 : 0);
}

run();
