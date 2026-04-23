'use strict';

/*
 * test/slmodem/vm-smoke.test.js — M2 end-to-end smoke through QEMU.
 *
 * Validates the full stack with a real VM: Node spawns
 * qemu-system-i386, the VM boots the runtime kernel + initramfs,
 * S99modem launches slmodemd which fork-execs modemd-shim, the
 * shim connects back to Node via virtio-serial, AT commands
 * round-trip through the host↔VM boundary.
 *
 * Hardware-bound stages:
 *
 *   Node (QemuVM.start)
 *      │  spawns qemu-system-i386 with:
 *      │    -kernel vm/images/bzImage
 *      │    -initrd vm/images/rootfs.cpio.gz
 *      │    two virtio-serial chardev-socket client connections to
 *      │      host Unix sockets (one audio, one control)
 *      ▼
 *   QEMU/guest
 *      │  kernel boots, busybox init runs /etc/init.d/rcS (mounts)
 *      │  then runs /etc/init.d/S99modem (loads virtio modules,
 *      │  symlinks /dev/virtio-ports/synthmodem.{audio,control},
 *      │  execs slmodemd as user 'slmodemd')
 *      ▼
 *   slmodemd in guest
 *      │  socket_start() fork+execs modemd-shim with:
 *      │    audio_fd + sip_fd inherited as numbers in argv
 *      │    SYNTHMODEM_{AUDIO,CONTROL,PTY}_PATH in env
 *      ▼
 *   modemd-shim in guest
 *      │  opens the two virtio-serial char devices → they are full-
 *      │  duplex byte streams wired to the host sockets
 *      │  emits HELLO on the control stream
 *      ▼
 *   Host wire-frame parser (shared with M1)
 *      HELLO received → QemuVM.start() resolves
 *      sendAT('AT') → wire frame WIRE_TYPE_AT_COMMAND
 *      shim writes AT to PTY
 *      slmodemd AT parser responds 'OK'
 *      shim reads PTY output → WIRE_TYPE_AT_RESPONSE frame
 *      QemuVM emits 'atResponse' event with 'OK'
 *
 * Assertions:
 *   (a) QEMU spawns and boots inside the timeout window.
 *   (b) HELLO arrives on the control channel (proves virtio-serial
 *       plumbing works end-to-end, in both directions — shim sends,
 *       host receives).
 *   (c) AT → OK round-trip completes (proves the PTY path inside the
 *       VM is wired correctly and slmodemd's AT parser is reachable).
 *
 * Run with:
 *
 *   node test/slmodem/vm-smoke.test.js
 *
 * Requires:
 *   - qemu-system-i386 on PATH (or $QEMU_SYSTEM_I386 set)
 *   - vm/images/bzImage and vm/images/rootfs.cpio.gz built
 *     (run `make -C vm` first)
 *
 * Expected duration:
 *   ~8-12 seconds under TCG (no KVM). ~3-5 seconds with KVM.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const { QemuVM } = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT = path.resolve(__dirname, '../..');
const { kernelPath, initrdPath } = QemuVM.defaultImagePaths(REPO_ROOT);

// Pre-flight checks so the failure message points at the right thing
// when one of the inputs is missing.
for (const p of [kernelPath, initrdPath]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING: ${p}`);
    console.error('Run `make -C vm` first to build the VM images.');
    process.exit(1);
  }
}

const qemuPath = QemuVM.resolveQemuPath();
// We don't strictly require qemu-system-i386 to be invokable to
// construct a QemuVM (the spawn will just fail later), but it's
// nicer to fail up-front with a clear error.
//   (A proper `which`-equivalent in Node is awkward; spawning a
//   throwaway child would work but costs a fork. Skip for now.)

let passed = 0;
let failed = 0;
function ok(msg)    { console.log('  ok  ', msg); passed++; }
function fail(msg, err) {
  console.log('  FAIL', msg);
  if (err) console.log('       ', err && err.stack ? err.stack : err);
  failed++;
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}

async function run() {
  console.log('M2 VM smoke test');
  console.log(`  qemu:     ${qemuPath}`);
  console.log(`  kernel:   ${kernelPath}`);
  console.log(`  initrd:   ${initrdPath}`);
  console.log('');

  // Tunable but generous default. TCG without KVM on a busy machine
  // can easily take 10 seconds to get to HELLO. Multiple tests reuse
  // one VM instance to avoid paying the boot cost N times.
  const vm = new QemuVM({
    qemuPath,
    kernelPath,
    initrdPath,
    memoryMb: 256,
  });

  // Capture stderr + boot log for post-mortem on failure.
  let boot = '';
  vm.on('stderr', chunk => { boot += chunk; });

  await test('start() boots VM and receives HELLO', async () => {
    await vm.start();
    assert.strictEqual(vm.state, 'ready', 'state should be "ready" after start');
    assert.ok(vm.helloInfo, 'helloInfo should be populated');
    assert.match(vm.helloInfo, /^modemd-shim /,
      `HELLO should start with "modemd-shim ": got "${vm.helloInfo}"`);
  });

  await test('AT → OK round-trip', async () => {
    const response = await sendAtAndWait(vm, 'AT', 3000);
    assert.match(response, /\bOK\b/,
      `AT should produce OK somewhere in response; got: ${JSON.stringify(response)}`);
    assert.doesNotMatch(response, /\bERROR\b/,
      `AT should not produce ERROR; got: ${JSON.stringify(response)}`);
  });

  await test('ATI3 → version line', async () => {
    const response = await sendAtAndWait(vm, 'ATI3', 3000);
    // slmodemd's ATI3 returns the modem device path and driver type
    // ("socket driver"). Response format ends with OK.
    assert.match(response, /\bOK\b/,
      `ATI3 should end with OK; got: ${JSON.stringify(response)}`);
    assert.doesNotMatch(response, /\bERROR\b/,
      `ATI3 should not produce ERROR; got: ${JSON.stringify(response)}`);
  });

  await test('unknown command → ERROR or OK', async () => {
    // slmodemd's AT parser is permissive — it silently ignores
    // unrecognized suffixes and treats ATZZZZZ as a reset command
    // returning OK (see the boot log showing "modem reset... OK").
    // So we just verify we get SOME terminator, not specifically ERROR.
    const response = await sendAtAndWait(vm, 'ATZZZZZ', 3000);
    assert.match(response, /\b(OK|ERROR)\b/,
      `ATZZZZZ should terminate with OK or ERROR; got: ${JSON.stringify(response)}`);
  });

  await test('stop() is clean', async () => {
    await vm.stop();
    assert.strictEqual(vm.state, 'dead', 'state should be "dead" after stop');
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('');
    console.log('─── Last 2000 chars of boot log ───');
    console.log(boot.slice(-2000));
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Send an AT command and wait up to timeoutMs for the response.
 * Returns the response string (without trailing CRLF noise).
 *
 * Implementation: subscribe to 'at-response' events, send, resolve on
 * first response payload that looks "complete". The shim forwards
 * raw PTY bytes as they arrive, so we may see multiple small frames
 * in sequence ('A', 'T\r\r\r\nOK\r', '\r\r\n' for example). We
 * accumulate bytes until we see OK or ERROR in the buffer, then
 * return what we have.
 *
 * Multiple concurrent AT commands aren't supported by slmodemd, so
 * this single-shot pattern is fine.
 */
function sendAtAndWait(vm, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let acc = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      vm.off('at-response', onResp);
      if (acc) {
        // We timed out but had partial data — surface it; some tests
        // treat this as success (e.g. an ATI3 response that never
        // ends with the exact "OK" we expected).
        reject(new Error(`timeout waiting for response to "${cmd}" after ${timeoutMs}ms; partial: ${JSON.stringify(acc)}`));
      } else {
        reject(new Error(`timeout waiting for response to "${cmd}" after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function onResp(payload) {
      // Payload is a Buffer per wire.js
      acc += payload.toString('utf8');
      if (done) return;
      // Look for the terminator. slmodemd wraps responses in
      // CR LF OK CR LF or CR LF ERROR CR LF. The leading echo of
      // the command also appears in the stream.
      if (/\b(OK|ERROR)\b/.test(acc)) {
        done = true;
        clearTimeout(timer);
        vm.off('at-response', onResp);
        resolve(acc);
      }
    }

    vm.on('at-response', onResp);
    vm.sendAT(cmd);
  });
}

run().catch(err => {
  console.error('fatal in test runner:', err);
  process.exit(2);
});
