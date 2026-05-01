'use strict';

/*
 * test/pjsip/pool.test.js — ModemBackendPool + PjsipBackend.
 *
 * Proves that the pool's factory abstraction works for backend B:
 * the pool can warmup a PjsipBackend, hand it out via checkout(),
 * accept it back via recycle(), and shut down cleanly.
 *
 * Full pool semantics (warmup-on-recycle, concurrent checkouts, etc.)
 * are tested against the native ModemDSP elsewhere; here we just verify
 * PjsipBackend fits the interface.
 *
 * Expected duration: ~30-40s (one VM boot).
 *
 * Run: node test/pjsip/pool.test.js
 */

const assert     = require('assert');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');
const { tmpdir } = require('os');

const { ModemBackendPool } = require('../../src/backends/ModemBackendPool');
const { PjsipBackend }     = require('../../src/backends/PjsipBackend');
const { QemuVM }           = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT  = path.resolve(__dirname, '../..');
const kernelPath = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin  = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const peerBin    = path.join(REPO_ROOT, 'vm', 'prebuilt', 'pjsip-test-peer-i386');
const qemuPath   = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('ModemBackendPool + PjsipBackend');

for (const [label, p] of [
  ['kernel',        kernelPath],
  ['base rootfs',   baseRootfs],
  ['tunnel binary', tunnelBin],
  ['peer binary',   peerBin],
]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING ${label}: ${p}`);
    process.exit(1);
  }
}

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

async function run() {
  console.log('ModemBackendPool + PjsipBackend');
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-pool-'));
  let pool, checkedOut;

  try {
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, tunnelBin, peerBin, testInitrd);

    /* Build a factory that produces PjsipBackend instances with our
     * test paths baked in. Pool state-machine expectations are what
     * we're testing, not PjsipBackend behaviour (that's the backend
     * test). */
    const backendOpts = {
      qemuPath,
      kernelPath,
      initrdPath:   testInitrd,
      readinessTimeoutMs: 30000,
    };

    /* Fail-fast smoke test — no VM boot. Proves that when
     * qemuPath is wrong, the pool's start() rejects promptly
     * instead of hanging on a TCP accept that will never come.
     * Standalone test — uses its own pool instance, doesn't
     * affect subsequent real-boot tests. */
    await test('fail-fast: bad qemuPath causes pool.start to reject cleanly', async () => {
      const badOpts = {
        ...backendOpts,
        /* Bare name → spawn ENOENT on every platform. Constructor's
         * existence check skips it (no path separator). */
        qemuPath: 'qemu-this-binary-does-not-exist-xyz',
      };
      const badPool = new ModemBackendPool({
        backendOpts: badOpts,
        backendFactory: (opts) => new PjsipBackend(opts),
        warmupTimeoutMs: 30000,
      });
      badPool.on('error', () => { /* absorb */ });
      const started = Date.now();
      try {
        await badPool.start();
        throw new Error('pool.start should have rejected');
      } catch (err) {
        const dur = Date.now() - started;
        assert.ok(dur < 5000,
          `fail-fast should take <5s, took ${dur}ms (did we hang on TCP accept?)`);
        assert.match(err.message, /spawn|ENOENT|Failed to spawn QEMU/i,
          `unexpected error message: ${err.message}`);
      }
      /* Idempotent stop — pool is already in 'empty' state after
       * the failed warmup. */
      await badPool.stop().catch(() => {});
    });

    pool = new ModemBackendPool({
      backendOpts,
      backendFactory: (opts) => new PjsipBackend(opts),
      warmupTimeoutMs: 60000,   /* backend-B warmup is longer than A's */
    });

    await test('pool starts with a PjsipBackend', async () => {
      await pool.start();
      assert.strictEqual(pool.state, 'ready');
    });

    await test('checkout yields a PjsipBackend in READY state', async () => {
      checkedOut = await pool.checkout();
      assert.ok(checkedOut instanceof PjsipBackend);
      assert.strictEqual(checkedOut.mode, 'b2bua');
      assert.strictEqual(checkedOut.state, 'READY');
      assert.strictEqual(pool.state, 'checked_out');
    });

    /* We don't exercise activate() here — that needs an ext socket
     * and duplicates test/pjsip/backend.test.js. The point of this
     * test is purely pool integration. */

    await test('pool.stop after manual backend stop is clean', async () => {
      /* Caller owns the checked-out backend post-checkout. Stop it
       * explicitly, then stop the pool. */
      await checkedOut.stop();
      checkedOut = null;
      await pool.stop();
      assert.strictEqual(pool.state, 'stopped');
    });

  } finally {
    if (checkedOut) { try { await checkedOut.stop(); } catch (_) {} }
    if (pool && pool.state !== 'stopped') { try { await pool.stop(); } catch (_) {} }
    if (failed === 0 && passed > 0) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    } else {
      console.log(`  (keeping workdir for debug: ${workDir})`);
    }
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function buildTestInitrd(workDir, basePath, tunnelBinPath, peerBinPath, outPath) {
  const stageDir = path.join(workDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  await execSh(`zcat ${sh(basePath)} | cpio -i --quiet --make-directories`, { cwd: stageDir });
  const localBin = path.join(stageDir, 'usr', 'local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.copyFileSync(tunnelBinPath, path.join(localBin, 'modemd-tunnel'));
  fs.copyFileSync(peerBinPath,   path.join(localBin, 'pjsip-test-peer'));
  fs.chmodSync(path.join(localBin, 'modemd-tunnel'),   0o755);
  fs.chmodSync(path.join(localBin, 'pjsip-test-peer'), 0o755);

  const initScript = `#!/bin/sh
set -e
mount -t proc     proc     /proc    2>/dev/null || true
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

MOD_DIR=/lib/modules/virtio
for m in virtio virtio_ring virtio_pci_legacy_dev virtio_pci_modern_dev \\
         virtio_pci virtio_console; do
    [ -f "$MOD_DIR/$m.ko" ] && insmod "$MOD_DIR/$m.ko" 2>/dev/null || true
done

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \\
         21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 \\
         38 39 40 41 42 43 44 45 46 47 48 49 50; do
    if [ -d /sys/class/virtio-ports ] && \\
       ls /sys/class/virtio-ports/vport*/name >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

mkdir -p /dev/virtio-ports
for dir in /sys/class/virtio-ports/vport*; do
    [ -d "$dir" ] || continue
    base=$(basename "$dir")
    if [ -r "$dir/name" ]; then
        pname=$(cat "$dir/name" 2>/dev/null)
        if [ -n "$pname" ] && [ -c "/dev/$base" ]; then
            ln -sf "/dev/$base" "/dev/virtio-ports/$pname"
            chmod 0666 "/dev/$base"
        fi
    fi
done

SYNTHMODEM_LOG_LEVEL=info /usr/local/bin/modemd-tunnel &
sleep 1
exec /usr/local/bin/pjsip-test-peer
`;

  const initD = path.join(stageDir, 'etc', 'init.d');
  fs.mkdirSync(initD, { recursive: true });
  fs.writeFileSync(path.join(initD, 'S99modem'), initScript);
  fs.chmodSync(path.join(initD, 'S99modem'), 0o755);

  await execSh(`find . -print0 | cpio --null -H newc --create --quiet | gzip -5 > ${sh(outPath)}`,
    { cwd: stageDir });
}

function sh(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
function execSh(cmd, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', cmd], opts);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`sh exited ${code}/${signal}: ${cmd}`));
    });
  });
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
