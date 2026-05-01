'use strict';

/*
 * test/slmodem-pjsip/at.test.js — step-5b AT smoke test, extended
 * in step 5c to cover d-modem registration.
 *
 * Boots the PRODUCTION backend-B rootfs (real S99modem-pjsip +
 * slmodemd + d-modem + modemd-tunnel + modemd-ctrl) via PjsipBackend
 * with useRegistrar:true. This is the full production stack:
 *
 *   - d-modem is invoked with --sip-server/--sip-user/--sip-password
 *     (via slmodemd -S/-U/-P pass-through) so it enters registered
 *     mode instead of dying on empty-dialstr.
 *   - PJSIP initializes with all D-Modem media optimizations
 *     (software clock, fixed jitter buffer, PLC/VAD/EC off, etc.)
 *     then REGISTERs its Contact at 127.0.0.1:5060.
 *   - modemd-tunnel (bound to 5060) frames the REGISTER over the
 *     virtio-serial chardev to Node.
 *   - Node's VmRegistrar 200-OKs and learns d-modem's ephemeral
 *     PJSIP port. PjsipBackend exposes this as the new targetUri.
 *   - modemd-ctrl connects to slmodemd's PTY and forwards AT
 *     commands Node sends over the control chardev.
 *
 * Coverage
 * ────────
 *
 *   1. Production rootfs boots; S99modem-pjsip runs all four
 *      helpers.
 *   2. d-modem REGISTERs with VmRegistrar; PjsipBackend's
 *      targetUri is updated from the learned Contact binding.
 *   3. modemd-ctrl connects to its chardev and emits HELLO.
 *   4. slmodemd creates /tmp/ttySL0, modemd-ctrl opens it
 *      (the retry loop in open_host_path handles the race).
 *   5. Node sends AT commands via the control wire protocol;
 *      slmodemd responds through the same path.
 *   6. Clean teardown.
 *
 * What this test does NOT cover
 * ─────────────────────────────
 *
 *   - INVITE / media flow against real d-modem. The readiness gate
 *     proves SIGNALING reachability (REGISTER round-trip), but
 *     actual INVITE-to-d-modem and RTP bridging is the next step
 *     (CallSession B2BUA wiring).
 *   - Actual modem handshake. That needs hardware; this is still
 *     just a stack-alive smoke test.
 *
 * Expected duration: ~30-50s under TCG (kernel boot + slmodemd
 * startup + PJSIP init + REGISTER roundtrip + modemd-ctrl PTY open).
 *
 * Run: node test/slmodem-pjsip/at.test.js
 */

const assert   = require('assert');
const path     = require('path');
const fs       = require('fs');
const { tmpdir } = require('os');

const { PjsipBackend } = require('../../src/backends/PjsipBackend');
const { QemuVM }       = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT  = path.resolve(__dirname, '../..');
const kernelPath = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const initrdPath = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const qemuPath   = QemuVM.resolveQemuPath();

for (const [label, p] of [
  ['kernel', kernelPath],
  ['initrd', initrdPath],
]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING ${label}: ${p}`);
    if (label === 'initrd') {
      console.error('Run `make -C vm rootfs-pjsip`. Depends on');
      console.error('  vm/prebuilt/d-modem, modemd-tunnel-i386, modemd-ctrl-i386');
      console.error('— all produced by scripts/build-pjsip-in-vm.sh.');
    }
    process.exit(1);
  }
}

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Poll a predicate against accumulated text; resolves on match,
 * rejects on timeout. Used for waiting on AT response fragments
 * aggregated via PjsipBackend's 'at-response' events. */
async function waitForAtText(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
}

async function run() {
  console.log('Backend-B AT smoke test (step 5b)');
  console.log(`  qemu:    ${qemuPath}`);
  console.log(`  kernel:  ${kernelPath}`);
  console.log(`  initrd:  ${initrdPath}`);
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-5b-'));
  const bootLog = path.join(workDir, 'qemu.log');
  let backend;

  try {
    backend = new PjsipBackend({
      qemuPath,
      kernelPath,
      initrdPath,                  /* the production rootfs */
      bootLogPath: bootLog,
      enableControl: true,         /* step 5b needs modemd-ctrl */
      useRegistrar: true,          /* step 5c: gate READY on REGISTER */
      readinessTimeoutMs: 60000,
    });

    /* Subscribe to backend events so tests can verify HELLO arrival,
     * AT-response text, etc. without racing the raw byte stream —
     * Node stream 'data' events aren't replayed to late listeners,
     * and PjsipBackend's internal parser now consumes the stream,
     * so we use its emitted events instead. */
    const helloSeen = new Promise(resolve => backend.once('hello', resolve));
    let atResponseText = '';
    backend.on('at-response', txt => { atResponseText += txt; });

    await test('startAsync boots production rootfs and reaches READY', async () => {
      await backend.startAsync();
      assert.strictEqual(backend.state, 'READY');
      assert.ok(backend.controlSocket, 'controlSocket should be exposed');
    });

    await test('d-modem registered with VmRegistrar (real PJSIP REGISTER round-trip)', async () => {
      /* If startAsync reached READY with useRegistrar:true, a REGISTER
       * must have arrived and been 200-OKed. Verify the binding is
       * exposed and the targetUri was updated away from the default. */
      assert.ok(backend._registrar, 'registrar should exist');
      const binding = backend._registrar.currentBinding;
      assert.ok(binding, 'registrar should have a binding');
      assert.strictEqual(binding.host, '127.0.0.1',
        `expected loopback host, got ${binding.host}`);
      assert.ok(binding.port > 0 && binding.port < 65536,
        `binding port should be a valid UDP port, got ${binding.port}`);
      assert.notStrictEqual(binding.port, 5060,
        'binding port should NOT be 5060 (that is modemd-tunnel\'s bind)');
      assert.notStrictEqual(binding.port, 5090,
        'binding port should NOT be 5090 (that is pjsip-test-peer\'s port)');
      /* PjsipBackend should have rewritten targetUri to point at
       * the learned Contact (including any PJSIP-specific params
       * like ;ob). */
      assert.strictEqual(backend.targetUri, binding.contactUri,
        'backend.targetUri should match learned contactUri');
      assert.match(backend.targetUri, /^sip:modem@127\.0\.0\.1:\d+/,
        `unexpected targetUri format: ${backend.targetUri}`);
    });

    await test('modemd-ctrl connects and emits HELLO (proves slmodemd + ctrl coming up)', async () => {
      /* PjsipBackend's wire-parser emits 'hello' when modemd-ctrl's
       * HELLO frame arrives on the control channel. That firing
       * proves: VM booted, slmodemd created /tmp/ttySL0,
       * modemd-ctrl opened it (open_host_path's re-stat retries
       * handled the slmodemd startup race), and the full control
       * path is alive. */
      const msg = await Promise.race([
        helloSeen,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout waiting for HELLO')), 20000)),
      ]);
      assert.match(msg, /^modemd-ctrl v1 build=/,
        `unexpected HELLO payload: ${JSON.stringify(msg)}`);
    });

    await test('AT command roundtrips: ATE0 -> OK', async () => {
      /* ATE0 turns off command echo; chosen because it's a single
       * simple command that returns just "OK" without verbose
       * output. Some slmodemd builds echo the command back by
       * default, which complicates response parsing — ATE0 gets us
       * to a clean echo-off state right away.
       *
       * slmodemd may emit the response as "\r\nOK\r\n" or
       * "ATE0\r\n\r\nOK\r\n" (with echo). Poll the accumulated
       * at-response text until we see OK or time out. */
      atResponseText = '';  /* reset after HELLO-era noise */
      backend.sendAt('ATE0');
      await waitForAtText(() => /\bOK\b/.test(atResponseText),
        10000, 'AT_RESPONSE containing OK');
      assert.match(atResponseText, /\bOK\b/,
        `expected OK in response: ${JSON.stringify(atResponseText)}`);
    });

    await test('follow-up AT command works after echo-off: ATI -> identification string', async () => {
      /* ATI — modem identification. Returns some kind of info
       * string followed by OK. Mainly validates that we can do more
       * than one command in the same call. */
      atResponseText = '';
      backend.sendAt('ATI');
      await waitForAtText(() => /\bOK\b/.test(atResponseText),
        10000, 'AT_RESPONSE with OK after ATI');
      assert.match(atResponseText, /\bOK\b/);
      assert.ok(atResponseText.length > 3,
        `ATI response suspiciously short: ${JSON.stringify(atResponseText)}`);
    });

    await test('stop() tears down the VM cleanly', async () => {
      await backend.stop();
      assert.strictEqual(backend.state, 'STOPPED');
    });

  } finally {
    if (backend && backend.state !== 'STOPPED') {
      try { await backend.stop(); } catch (_) {}
    }
    if (failed === 0 && passed > 0) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    } else {
      console.log(`  (keeping workdir for debug: ${workDir})`);
      console.log(`    qemu.log at ${bootLog}`);
    }
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
