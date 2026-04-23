'use strict';

/*
 * test/slmodem/smoke.test.js — M1 end-to-end smoke test.
 *
 * Validates the full AT command round trip:
 *
 *   Node (SlmodemVM.sendAT)  ─► wire frame on control socket
 *                                    │
 *                                    ▼
 *                             modemd-shim (writes to its PTY_PATH)
 *                                    │
 *                                    ▼
 *                             mock-slmodemd's PTS (they're the same
 *                             file because the mock symlinks its
 *                             PTS to the shared path and the shim
 *                             opens that symlink)
 *                                    │
 *                                    ▼
 *                             mock's AT parser responds
 *                                    │
 *                                    ▼
 *                             PTS bytes → shim's PTY reader
 *                                    │
 *                                    ▼
 *   Node <──  WIRE_TYPE_AT_RESPONSE frame on control socket
 *
 * We check both:
 *   (a) HELLO arrives shortly after start (proves shim connected and
 *       wire framing works)
 *   (b) AT → OK round trip completes (proves PTY path works end-to-end)
 *
 * Run:  node test/slmodem/smoke.test.js
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const { SlmodemVM } = require('../../vm/qemu-runner/SlmodemVM');

const REPO_ROOT   = path.resolve(__dirname, '../..');
const MOCK_PATH   = path.join(REPO_ROOT, 'test/mock-slmodemd/mock-slmodemd');
const SHIM_PATH   = path.join(REPO_ROOT, 'vm/shim/modemd-shim');
// Stable per-test symlink path. The mock's -L creates this; the shim's
// SYNTHMODEM_PTY_PATH reads from it. Same file, two openers.
const PTY_SYMLINK = `/tmp/synthmodem-smoke-${process.pid}-ttySL0`;

// Quick sanity: both binaries exist
for (const p of [MOCK_PATH, SHIM_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL: required binary missing: ${p}`);
    console.error('      build first:');
    console.error('        make -C vm/shim');
    console.error('        make -C test/mock-slmodemd');
    process.exit(1);
  }
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

/*
 * Helper: wait for a predicate with a timeout. Returns a promise
 * that resolves when the predicate returns truthy, or rejects on
 * timeout. Polls every 20ms. Keeps the test runner free of pollers.
 */
function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v;
      try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`waitFor(${label || 'predicate'}) timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/*
 * Spin up a fresh SlmodemVM pointing at mock+shim with a per-test
 * PTY symlink. Returns { vm, ptsName } after start() resolves.
 */
async function spinUp(verbose = false) {
  // Clean any leftover symlink from a prior test run.
  try { fs.unlinkSync(PTY_SYMLINK); } catch (_) {}

  const vm = new SlmodemVM({
    slmodemdPath: MOCK_PATH,
    shimPath:     SHIM_PATH,
    slmodemdArgs: ['-L', PTY_SYMLINK],
    ptyPath:      PTY_SYMLINK,    // shim opens this; mock creates this
    logLevel:     verbose ? 'debug' : 'info',
  });

  if (verbose) {
    vm.on('stderr', text => process.stderr.write(`[child] ${text}`));
  }

  await vm.start();
  return vm;
}

// ─── Tests ─────────────────────────────────────────────────────────────

(async () => {
  console.log('SlmodemVM smoke tests');
  console.log('=====================');

  await test('start() resolves with HELLO info', async () => {
    const vm = await spinUp();
    try {
      assert.strictEqual(vm.state, 'ready');
      assert.match(vm.helloInfo, /^modemd-shim v\d+/,
        `unexpected HELLO: '${vm.helloInfo}'`);
    } finally {
      await vm.stop();
    }
  });

  await test('AT round-trip: AT → OK via PTY through shim', async () => {
    const vm = await spinUp();
    try {
      const seen = [];
      vm.on('at-response', buf => seen.push(buf.toString('utf8')));

      // Send a plain AT; mock responds with OK.
      vm.sendAT('AT');

      // Wait up to 2s for OK to appear.
      await waitFor(() => seen.join('').includes('OK'), 2000, 'OK response');

      const joined = seen.join('');
      assert.ok(joined.includes('OK'), `no OK in response: ${JSON.stringify(joined)}`);
    } finally {
      await vm.stop();
    }
  });

  await test('AT round-trip: ATI3 → version line', async () => {
    const vm = await spinUp();
    try {
      const seen = [];
      vm.on('at-response', buf => seen.push(buf.toString('utf8')));

      vm.sendAT('ATI3');

      await waitFor(() => {
        const s = seen.join('');
        return s.includes('mock-slmodemd') && s.includes('OK');
      }, 2000, 'ATI3 response');

      const joined = seen.join('');
      assert.ok(joined.includes('mock-slmodemd'),
        `no version string: ${JSON.stringify(joined)}`);
      assert.ok(joined.includes('OK'),
        `no OK after version: ${JSON.stringify(joined)}`);
    } finally {
      await vm.stop();
    }
  });

  await test('AT round-trip: unknown command → ERROR', async () => {
    const vm = await spinUp();
    try {
      const seen = [];
      vm.on('at-response', buf => seen.push(buf.toString('utf8')));

      vm.sendAT('ATZZQ');       // nonsense command

      await waitFor(() => seen.join('').includes('ERROR'), 2000, 'ERROR response');
      const joined = seen.join('');
      assert.ok(joined.includes('ERROR'),
        `no ERROR: ${JSON.stringify(joined)}`);
    } finally {
      await vm.stop();
    }
  });

  await test('stop() is idempotent', async () => {
    const vm = await spinUp();
    await vm.stop();
    await vm.stop();          // second call should not throw
    assert.strictEqual(vm.state, 'dead');
  });

  await test('start() rejects if the child binary is bogus', async () => {
    const vm = new SlmodemVM({
      slmodemdPath: '/no/such/path/slmodemd',
      shimPath:     SHIM_PATH,
      ptyPath:      PTY_SYMLINK,
      timeouts:     { connectTimeoutMs: 500, helloTimeoutMs: 500, stopGraceMs: 500 },
    });
    // A fatal error is expected here — attach a listener so the
    // emitted 'error' doesn't crash Node.
    vm.on('error', () => {});
    let threw = false;
    try { await vm.start(); } catch (e) { threw = true; }
    assert.ok(threw, 'expected start() to reject');
    await vm.stop();
  });

  // ── SlmodemBackend integration ──

  console.log('\nSlmodemBackend integration');
  console.log('==========================');
  const { SlmodemBackend } = require('../../src/backends/SlmodemBackend');

  await test('SlmodemBackend.startAsync() reaches ready', async () => {
    const backend = new SlmodemBackend({
      vmOpts: {
        slmodemdPath: MOCK_PATH,
        shimPath:     SHIM_PATH,
        slmodemdArgs: ['-L', PTY_SYMLINK],
        ptyPath:      PTY_SYMLINK,
        logLevel:     'info',
      },
      role: 'answer',
    });
    try {
      await backend.startAsync();
      assert.strictEqual(backend.state, 'ready');
    } finally {
      await backend.stop();
    }
  });

  await test('SlmodemBackend emits audioOut for initial silence frame', async () => {
    // When the mock writes its startup AUDIO silence frame, the shim
    // converts it to WIRE_TYPE_SILENCE, SlmodemVM expands that to a
    // 320-byte zero buffer, and SlmodemBackend should emit audioOut
    // with a 160-sample Float32Array of zeros.
    const backend = new SlmodemBackend({
      vmOpts: {
        slmodemdPath: MOCK_PATH,
        shimPath:     SHIM_PATH,
        slmodemdArgs: ['-L', PTY_SYMLINK],
        ptyPath:      PTY_SYMLINK,
        logLevel:     'info',
      },
    });
    const frames = [];
    backend.on('audioOut', f => frames.push(f));
    try {
      await backend.startAsync();
      // Wait briefly for the initial audio frames to propagate.
      await waitFor(() => frames.length > 0, 1000, 'first audioOut');
      assert.ok(frames[0] instanceof Float32Array);
      assert.strictEqual(frames[0].length, 160);
      // It's the silence frame, so all values should be zero.
      for (let i = 0; i < frames[0].length; i++) {
        assert.strictEqual(frames[0][i], 0, `sample ${i} != 0`);
      }
    } finally {
      await backend.stop();
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  // Clean up the symlink from the last test
  try { fs.unlinkSync(PTY_SYMLINK); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
