'use strict';

/*
 * test/slmodem/pool-vm-integration.test.js — pool + real VM end-to-end
 *
 * Validates that the pool correctly boots a real QEMU VM at start(),
 * hands it out via checkout(), recycles it (boot a fresh replacement),
 * and stops cleanly.
 *
 * This is slower than the pure-unit pool tests (~20-30s total for two
 * full VM boots) but is the only thing that exercises the full
 * integration — pool → SlmodemBackend → QemuVM → transport.js →
 * QEMU → guest init → slmodemd → shim → HELLO.
 *
 * Run:
 *   node test/slmodem/pool-vm-integration.test.js
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const REPO_ROOT = path.resolve(__dirname, '../..');
const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
const { ModemBackendPool } = require('../../src/backends/ModemBackendPool');

const { kernelPath, initrdPath } = QemuVM.defaultImagePaths(REPO_ROOT);
for (const p of [kernelPath, initrdPath]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING: ${p}`);
    console.error('Run `make -C vm` first.');
    process.exit(1);
  }
}

const results = { pass: 0, fail: 0 };
async function test(name, fn) {
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

// Use non-default ports to avoid conflicting with a running synthmodem
// process on the same machine. The test allocates from a range well
// away from the production defaults.
const TEST_AUDIO_PORT   = 28800;
const TEST_CONTROL_PORT = 28801;

function makePool() {
  return new ModemBackendPool({
    backendOpts: {
      role: 'answer',
      modemCfg: {
        backend: 'slmodemd',
        role: 'answer',
        slmodemd: {
          mode: 'qemu',
          kernelPath: kernelPath,
          initrdPath: initrdPath,
          logLevel: 'error',
          transport: {
            audioPort:   TEST_AUDIO_PORT,
            controlPort: TEST_CONTROL_PORT,
            bindHost:    '127.0.0.1',
          },
        },
      },
    },
    // Generous timeout since TCG boot is slow in sandboxes.
    warmupTimeoutMs: 60000,
  });
}

(async () => {
  console.log('Pool + real VM integration tests');
  console.log(`  audioPort=${TEST_AUDIO_PORT} controlPort=${TEST_CONTROL_PORT}`);
  console.log('');

  await test('pool.start() boots a real VM via TCP transport', async () => {
    const pool = makePool();
    try {
      await pool.start();
      assert.strictEqual(pool.state, 'ready');
    } finally {
      await pool.stop();
    }
  });

  await test('checkout() hands out a ready backend; recycle() replaces', async () => {
    const pool = makePool();
    try {
      await pool.start();
      const bk1 = await pool.checkout();
      assert.ok(bk1, 'checkout returned a backend');
      assert.strictEqual(pool.state, 'checked_out');

      // Recycle: pool should boot a fresh replacement VM.
      pool.recycle(bk1);

      // Wait up to 30s for the replacement warmup.
      const deadline = Date.now() + 30000;
      while (pool.state !== 'ready' && Date.now() < deadline) {
        await sleep(100);
      }
      assert.strictEqual(pool.state, 'ready',
        `pool did not re-warm within 30s (state=${pool.state})`);

      // Second checkout should succeed on the fresh VM.
      const bk2 = await pool.checkout();
      assert.ok(bk2, 'second checkout returned a backend');
      assert.notStrictEqual(bk2, bk1, 'recycled backend is a new instance');
    } finally {
      await pool.stop();
    }
  });

  console.log();
  console.log(`${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST HARNESS ERROR:', err);
  process.exit(2);
});
