'use strict';

/*
 * test/slmodem/pool.test.js — unit tests for ModemBackendPool
 *
 * Uses a fake SlmodemBackend injected via rewiring so we don't
 * actually boot QEMU. Exercises the pool's state machine:
 *
 *   - start() boots a backend and transitions to 'ready'
 *   - checkout() transitions to 'checked_out' and returns the backend
 *   - recycle() drops the backend, triggers background warmup
 *   - stop() tears down a ready backend cleanly
 *   - checkout() on empty/stopped pool throws
 *   - checkout() during warming waits for warmup to complete
 *   - warmup failure propagates via start() rejection
 *
 * Run:
 *   node test/slmodem/pool.test.js
 */

const assert = require('assert');
const path   = require('path');
const EventEmitter = require('events');

// We rewire the SlmodemBackend require inside ModemBackendPool.js by
// stubbing the module cache entry before first require.
const backendModulePath = require.resolve(
  path.resolve(__dirname, '../../src/backends/SlmodemBackend.js'));

/**
 * A fake SlmodemBackend that behaves enough like the real one for
 * the pool's purposes:
 *   - new Fake({startDelayMs, startFails})
 *   - startAsync() resolves after startDelayMs (or rejects if startFails)
 *   - stop() returns a resolved promise, records that it was called
 *   - on('error', ...) works (it's an EventEmitter)
 *
 * Each construction is counted in Fake.constructed; each startAsync
 * in Fake.startCount; each stop in Fake.stopCount.
 */
class FakeSlmodemBackend extends EventEmitter {
  constructor(opts) {
    super();
    FakeSlmodemBackend.constructed.push(this);
    this.opts = opts || {};
    this._startDelayMs = this.opts.startDelayMs ?? 5;
    this._startFails   = !!this.opts.startFails;
    this.stopped = false;
  }
  startAsync(activateOpts) {
    FakeSlmodemBackend.startCount++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this._startFails) reject(new Error('boot failed (fake)'));
        else resolve();
      }, this._startDelayMs);
    });
  }
  stop() {
    FakeSlmodemBackend.stopCount++;
    this.stopped = true;
    return Promise.resolve();
  }
  activate() { return Promise.resolve(); }
  static reset() {
    FakeSlmodemBackend.constructed = [];
    FakeSlmodemBackend.startCount = 0;
    FakeSlmodemBackend.stopCount = 0;
  }
}
FakeSlmodemBackend.reset();

// Stub the backend module before ModemBackendPool requires it.
require.cache[backendModulePath] = {
  id: backendModulePath,
  filename: backendModulePath,
  loaded: true,
  exports: { SlmodemBackend: FakeSlmodemBackend },
};

const { ModemBackendPool } = require('../../src/backends/ModemBackendPool');

// ─── tiny harness ──────────────────────────────────────────────────
const results = { pass: 0, fail: 0 };
async function test(name, fn) {
  FakeSlmodemBackend.reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
    results.pass++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.stack || e.message}`);
    results.fail++;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── tests ────────────────────────────────────────────────────────
(async () => {
  console.log('ModemBackendPool tests');
  console.log('======================');

  await test('start() boots a backend and transitions to ready', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    assert.strictEqual(pool.state, 'empty');
    await pool.start();
    assert.strictEqual(pool.state, 'ready');
    assert.strictEqual(FakeSlmodemBackend.constructed.length, 1);
    assert.strictEqual(FakeSlmodemBackend.startCount, 1);
    await pool.stop();
  });

  await test('start() is idempotent when already warm', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    await pool.start();  // should be a no-op, not another boot
    assert.strictEqual(FakeSlmodemBackend.constructed.length, 1);
    await pool.stop();
  });

  await test('checkout() returns the backend and transitions to checked_out', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    const bk = await pool.checkout();
    assert.ok(bk instanceof FakeSlmodemBackend);
    assert.strictEqual(pool.state, 'checked_out');
    await pool.stop();
  });

  await test('checkout() on empty pool throws', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    // not started yet
    await assert.rejects(() => pool.checkout(),
      /state empty/);
  });

  await test('checkout() on stopped pool throws', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    await pool.stop();
    await assert.rejects(() => pool.checkout(),
      /stopped/);
  });

  await test('recycle() triggers background warmup', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    const bk = await pool.checkout();
    assert.strictEqual(pool.state, 'checked_out');

    pool.recycle(bk);

    // recycle is fire-and-forget; state should immediately leave
    // checked_out. Either 'warming' (we haven't yielded yet) or
    // 'ready' (super fast fake boot finished synchronously is
    // unlikely but possible).
    assert.ok(['empty', 'warming', 'ready'].includes(pool.state),
      `unexpected state after recycle: ${pool.state}`);

    // Wait enough time for the fake warmup to finish.
    await sleep(50);
    assert.strictEqual(pool.state, 'ready');
    // Total constructions: first at start + second at recycle = 2.
    assert.strictEqual(FakeSlmodemBackend.constructed.length, 2);
    // Recycled backend should have been stopped.
    assert.strictEqual(bk.stopped, true);
    await pool.stop();
  });

  await test('checkout() waits for in-flight warmup', async () => {
    // Longer boot delay so we can reliably catch the 'warming' state.
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 40 } });
    // Don't await start() — let it run concurrently.
    const startPromise = pool.start();
    // Give the event loop one tick to enter 'warming'.
    await sleep(1);
    assert.strictEqual(pool.state, 'warming');
    // checkout() should not throw; it should wait for warmup.
    const checkoutPromise = pool.checkout();
    // The startPromise should resolve first (warmup → ready), then
    // the checkout grabs the backend.
    await startPromise;
    const bk = await checkoutPromise;
    assert.ok(bk instanceof FakeSlmodemBackend);
    assert.strictEqual(pool.state, 'checked_out');
    await pool.stop();
  });

  await test('start() rejects on warmup failure', async () => {
    const pool = new ModemBackendPool({
      backendOpts: { startDelayMs: 5, startFails: true },
    });
    await assert.rejects(() => pool.start(), /boot failed/);
    assert.strictEqual(pool.state, 'empty');
  });

  await test('stop() cleans up a ready backend', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    await pool.stop();
    assert.strictEqual(pool.state, 'stopped');
    // The warm backend should have been stopped.
    assert.strictEqual(FakeSlmodemBackend.constructed[0].stopped, true);
  });

  await test('stop() waits for in-flight warmup', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 30 } });
    // Start but don't await.
    pool.start().catch(() => {});
    await sleep(1);
    assert.strictEqual(pool.state, 'warming');
    // Stop now — should gracefully wait for warmup to finish and
    // then tear the backend down.
    await pool.stop();
    assert.strictEqual(pool.state, 'stopped');
    // The backend that finished warming should have been stopped
    // during pool.stop().
    assert.strictEqual(FakeSlmodemBackend.stopCount, 1);
  });

  await test('error event is emitted on background warmup failure', async () => {
    const pool = new ModemBackendPool({ backendOpts: { startDelayMs: 5 } });
    await pool.start();
    const bk = await pool.checkout();
    let errorSeen = null;
    pool.on('error', err => { errorSeen = err; });

    // Make the NEXT constructed backend fail. We can't mutate opts
    // after the fact, but we can monkey-patch the constructor.
    const origCtor = FakeSlmodemBackend.prototype.startAsync;
    FakeSlmodemBackend.prototype.startAsync = function () {
      return Promise.reject(new Error('boot failed (fake-next)'));
    };

    pool.recycle(bk);
    await sleep(20);

    // Restore
    FakeSlmodemBackend.prototype.startAsync = origCtor;

    assert.ok(errorSeen, 'expected error event');
    assert.match(errorSeen.message, /boot failed/);
    assert.strictEqual(pool.state, 'empty');
    await pool.stop();
  });

  console.log();
  console.log(`${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST HARNESS ERROR:', err);
  process.exit(2);
});
