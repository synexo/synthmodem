'use strict';

/*
 * test/pjsip/ctrl.test.js — step-5a integration test.
 *
 * Boots a VM with BOTH modemd-tunnel AND modemd-ctrl active, verifies
 * the dual-chardev wiring in PjsipBackend works end-to-end:
 *
 *   1. Tunnel chardev accepts the VM's connection (step 4b works).
 *   2. Control chardev accepts the VM's connection (new in step 5a).
 *   3. modemd-ctrl emits its HELLO frame on the control channel
 *      immediately after startup.
 *   4. Full step-4b pipeline still works alongside: PjsipBackend
 *      reaches READY, places an INVITE, the RtpBridge forwards
 *      packets.
 *   5. Teardown closes both chardev listeners cleanly.
 *
 * What this test does NOT cover:
 *   - AT-command roundtrip through modemd-ctrl to a real PTY. That
 *     needs slmodemd (step 5b). modemd-ctrl runs without a PTY here
 *     and is tested only for the wire-protocol side.
 *
 * Requires the backend-B binaries including the new modemd-ctrl-i386:
 *   - vm/prebuilt/modemd-tunnel-i386
 *   - vm/prebuilt/modemd-ctrl-i386
 *   - vm/prebuilt/pjsip-test-peer-i386
 *
 * Expected duration: ~30-45s on TCG.
 *
 * Run: node test/pjsip/ctrl.test.js
 */

const assert     = require('assert');
const path       = require('path');
const fs         = require('fs');
const dgram      = require('dgram');
const { spawn }  = require('child_process');
const { tmpdir } = require('os');

const { PjsipBackend } = require('../../src/backends/PjsipBackend');
const { QemuVM }       = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT  = path.resolve(__dirname, '../..');
const kernelPath = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin  = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const ctrlBin    = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-ctrl-i386');
const peerBin    = path.join(REPO_ROOT, 'vm', 'prebuilt', 'pjsip-test-peer-i386');
const qemuPath   = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('PjsipBackend + modemd-ctrl (step 5a)');

for (const [label, p] of [
  ['kernel',        kernelPath],
  ['base rootfs',   baseRootfs],
  ['tunnel binary', tunnelBin],
  ['ctrl binary',   ctrlBin],
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
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('PjsipBackend + modemd-ctrl (step 5a)');
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-5a-'));
  let backend, extSock;

  try {
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, {
      'modemd-tunnel':   tunnelBin,
      'modemd-ctrl':     ctrlBin,
      'pjsip-test-peer': peerBin,
    }, testInitrd);

    /* External-leg RTP socket — unused by this test beyond activate
     * requiring one, but create it for realism. */
    extSock = dgram.createSocket('udp4');
    await new Promise(r => extSock.bind(0, '127.0.0.1', r));

    backend = new PjsipBackend({
      qemuPath,
      kernelPath,
      initrdPath:   testInitrd,
      bootLogPath:  path.join(workDir, 'qemu.log'),
      readinessTimeoutMs: 30000,
      enableControl: true,
    });

    /* Subscribe to backend events BEFORE startAsync — HELLO can
     * fire before startAsync resolves and Node's EventEmitter
     * doesn't replay past events to late listeners. PjsipBackend
     * owns the control-channel wire parser internally (since
     * step 5c.2) so this is the only way to observe HELLO. */
    const helloSeen = new Promise(resolve => backend.once('hello', resolve));

    await test('startAsync wires both chardevs and reaches READY', async () => {
      await backend.startAsync();
      assert.strictEqual(backend.state, 'READY');
      assert.ok(backend._tunnel,         'tunnel is up');
      assert.ok(backend.controlSocket,   'controlSocket is exposed');
      assert.ok(!backend.controlSocket.destroyed, 'controlSocket is alive');
    });

    await test('modemd-ctrl emits HELLO on the control channel', async () => {
      const msg = await Promise.race([
        helloSeen,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout waiting for HELLO')), 8000)),
      ]);
      assert.match(msg, /^modemd-ctrl v1 build=/,
        `HELLO payload should announce modemd-ctrl v1 (got ${JSON.stringify(msg)})`);
    });

    await test('step-4b flow still works: activate + RTP forwarding', async () => {
      const mediaReadyP = new Promise(resolve => backend.once('media-ready', resolve));
      await backend.activate({ extRtpSocket: extSock });
      const negotiated = await mediaReadyP;
      assert.strictEqual(backend.state, 'CONFIRMED');
      assert.strictEqual(negotiated.codec.codec, 'PCMU');

      const caller = dgram.createSocket('udp4');
      await new Promise(r => caller.bind(0, '127.0.0.1', r));
      try {
        const startPackets = backend._bridge.stats.extToInt.packets;
        for (let i = 0; i < 3; i++) {
          const pkt = Buffer.from([0x80, 0x00, 0x00, i, 0, 0, 0, 0, 0, 0, 0, 0,
                                   0x01, 0x02, 0x03, 0x04, i, i, i, i]);
          caller.send(pkt, extSock.address().port, '127.0.0.1');
        }
        await delay(150);
        const delta = backend._bridge.stats.extToInt.packets - startPackets;
        assert.strictEqual(delta, 3, `expected 3 packets forwarded, got ${delta}`);
      } finally {
        caller.close();
      }
    });

    await test('stop() tears down both chardevs cleanly', async () => {
      await backend.stop();
      assert.strictEqual(backend.state, 'STOPPED');
      assert.strictEqual(backend.controlSocket, null);
    });

  } finally {
    if (extSock) { try { extSock.close(); } catch (_) {} }
    if (backend && backend.state !== 'STOPPED') {
      try { await backend.stop(); } catch (_) {}
    }
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

/* ─── initramfs helpers ─────────────────────────────────────── */

async function buildTestInitrd(workDir, basePath, binMap, outPath) {
  const stageDir = path.join(workDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  await execSh(`zcat ${sh(basePath)} | cpio -i --quiet --make-directories`, { cwd: stageDir });

  const localBin = path.join(stageDir, 'usr', 'local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  for (const [name, src] of Object.entries(binMap)) {
    fs.copyFileSync(src, path.join(localBin, name));
    fs.chmodSync(path.join(localBin, name), 0o755);
  }

  /* Init: bring up lo, load virtio modules, create port symlinks,
   * start tunnel + ctrl + test-peer.
   *
   * Note on ordering: modemd-ctrl is started in the background BEFORE
   * pjsip-test-peer execs in the foreground. Without a PTY path
   * pointing anywhere useful, modemd-ctrl's PTY-open will degrade to
   * "no PTY" and the process stays up just servicing the control
   * channel (HELLO then idle poll). That's exactly what this test
   * wants: modemd-ctrl alive, wire protocol exercisable.
   */
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

echo "=== step-5a test init ==="
SYNTHMODEM_LOG_LEVEL=info /usr/local/bin/modemd-tunnel &

# modemd-ctrl: wire it to the control chardev. SYNTHMODEM_PTY_PATH
# intentionally points at /dev/null/nope — open_host_path will fail,
# modemd-ctrl logs "continuing without PTY" and stays up just for
# the control channel. Test only exercises HELLO + teardown.
SYNTHMODEM_LOG_LEVEL=info \\
  SYNTHMODEM_CONTROL_PATH=/dev/virtio-ports/synthmodem.control \\
  SYNTHMODEM_PTY_PATH=/tmp/no-pty-here \\
  SYNTHMODEM_BUILD_ID=test-5a \\
  /usr/local/bin/modemd-ctrl &

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
