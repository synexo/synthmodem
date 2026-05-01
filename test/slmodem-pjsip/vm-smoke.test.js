'use strict';

/*
 * test/slmodem-pjsip/vm-smoke.test.js — rootfs boot smoke test for
 * backend B (slmodemd-pjsip).
 *
 * What this test validates
 * ─────────────────────────
 *
 * The bare minimum that proves the backend-B rootfs is intact and
 * bootable:
 *
 *   (a) qemu-system-i386 is on PATH and usable.
 *   (b) vm/images/rootfs-slmodemd-pjsip.cpio.gz exists and boots
 *       against vm/kernel/bzImage.
 *   (c) busybox init runs rcS then S99modem-pjsip via inittab.
 *   (d) S99modem-pjsip detects that virtio-serial chardevs are absent
 *       when booted standalone (no host-side chardev wiring), printing
 *       its "virtio-serial devices not found" diagnostic. This is the
 *       correct behavior — S99modem-pjsip refuses to start slmodemd
 *       without its transport ports. Presence of this diagnostic
 *       proves the rootfs is intact AND that the init script ran far
 *       enough to make the fs/dev/sys checks.
 *
 * What this test does NOT validate
 * ────────────────────────────────
 *
 *   - Any SIP/RTP behavior. For that, the VM needs to be booted via
 *     `PjsipBackend(enableControl:true)` which wires both chardevs.
 *     See `test/slmodem-pjsip/boot.test.js` for the full-boot case.
 *   - slmodemd/d-modem actually running. Same reason — the init
 *     guards on chardev presence and short-circuits without them.
 *   - AT-command roundtrip. Covered by `at.test.js`.
 *
 * This split (smoke here, chardev-backed boot elsewhere) keeps a
 * basic "did our build produce something that boots" check runnable
 * without the full PjsipBackend orchestration stack.
 *
 * Run with:
 *
 *   node test/slmodem-pjsip/vm-smoke.test.js
 *
 * Expected duration: ~15-20s under TCG.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
const { QemuVM } = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT   = path.resolve(__dirname, '../..');
const kernelPath  = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const initrdPath  = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const qemuPath    = QemuVM.resolveQemuPath();

for (const [label, p] of [['kernel', kernelPath], ['initrd', initrdPath]]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING ${label}: ${p}`);
    if (label === 'initrd') {
      console.error('Run `make -C vm rootfs-pjsip` to build it.');
      console.error('That depends on vm/prebuilt/d-modem, modemd-tunnel-i386,');
      console.error('and modemd-ctrl-i386 — all produced by');
      console.error('scripts/build-pjsip-in-vm.sh.');
    }
    process.exit(1);
  }
}

const TEST_TIMEOUT_MS = 30_000;

const ANCHOR_STARTING      = 'S99modem-pjsip: virtio-serial devices not found';
/* Match the full status line — we need both "exists" or "missing" to
 * be present. The check below uses regex because the status word is
 * dynamic. Wait in runVm() for the second occurrence of that word
 * (one per chardev line). */
const CHARDEV_LINE_RE = /(TUNNEL_DEV|CONTROL_DEV)=\/dev\/virtio-ports\/synthmodem\.\w+ (exists|missing)/g;

let passed = 0;
let failed = 0;
function ok(msg)   { console.log('  ok  ', msg); passed++; }
function fail(msg, err) {
  console.log('  FAIL', msg);
  if (err) console.log('       ', err && err.stack ? err.stack : err);
  failed++;
}
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

function runVm() {
  return new Promise((resolve, reject) => {
    const args = [
      '-M', 'pc', '-m', '256', '-nographic',
      '-kernel', kernelPath, '-initrd', initrdPath,
      '-append', 'console=ttyS0 panic=-1 loglevel=3',
      '-no-reboot', '-accel', 'tcg',
    ];
    const qemu = spawn(qemuPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { qemu.kill('SIGKILL'); } catch (_) {}
      reject(new Error(
        `timeout after ${TEST_TIMEOUT_MS}ms; anchor texts not all seen.\n` +
        `last 1500 chars:\n${captured.slice(-1500)}`
      ));
    }, TEST_TIMEOUT_MS);

    function onData(chunk) {
      captured += chunk.toString('utf8');
      if (resolved) return;
      const plain = captured.replace(/\r/g, '');
      /* Count complete chardev status lines. We need both (tunnel +
       * control) fully printed including their trailing "missing" or
       * "exists" word, otherwise assertion regexes will clip early. */
      const matches = plain.match(CHARDEV_LINE_RE);
      if (plain.includes(ANCHOR_STARTING) && matches && matches.length >= 2) {
        resolved = true;
        clearTimeout(timer);
        try { qemu.kill('SIGKILL'); } catch (_) {}
        resolve(plain);
      }
    }

    qemu.stdout.on('data', onData);
    qemu.stderr.on('data', onData);
    qemu.on('error', err => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(`qemu spawn error: ${err.message}`));
    });
    qemu.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(
        `qemu exited early (code=${code} signal=${signal}); expected anchors never seen.\n` +
        `last 1500 chars:\n${captured.slice(-1500)}`
      ));
    });
  });
}

async function run() {
  console.log('Backend-B (slmodemd-pjsip) rootfs smoke test');
  console.log(`  qemu:     ${qemuPath}`);
  console.log(`  kernel:   ${kernelPath}`);
  console.log(`  initrd:   ${initrdPath}`);
  console.log('');

  let captured = '';

  await test('rootfs boots and S99modem-pjsip runs with missing-chardev diagnostic', async () => {
    captured = await runVm();
    assert.ok(captured.includes(ANCHOR_STARTING),
      `expected "${ANCHOR_STARTING}" in serial output`);
  });

  await test('diagnostic names both chardev paths correctly', async () => {
    assert.match(captured,
      /TUNNEL_DEV=\/dev\/virtio-ports\/synthmodem\.tunnel\b/,
      `expected tunnel chardev path in output`);
    assert.match(captured,
      /CONTROL_DEV=\/dev\/virtio-ports\/synthmodem\.control\b/,
      `expected control chardev path in output`);
  });

  await test('each chardev line reports "missing" (standalone-boot case)', async () => {
    const tunnelMatch = captured.match(
      /TUNNEL_DEV=\/dev\/virtio-ports\/synthmodem\.tunnel (exists|missing)/);
    const controlMatch = captured.match(
      /CONTROL_DEV=\/dev\/virtio-ports\/synthmodem\.control (exists|missing)/);
    assert.ok(tunnelMatch, `tunnel chardev status line not found`);
    assert.ok(controlMatch, `control chardev status line not found`);
    assert.strictEqual(tunnelMatch[1], 'missing',
      `expected tunnel chardev to be missing in standalone boot`);
    assert.strictEqual(controlMatch[1], 'missing',
      `expected control chardev to be missing in standalone boot`);
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('fatal in test runner:', err);
  process.exit(2);
});
