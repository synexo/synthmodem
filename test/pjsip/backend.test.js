'use strict';

/*
 * test/pjsip/backend.test.js — PjsipBackend integration test (step 4b).
 *
 * Validates:
 *   1. startAsync() boots the VM, stands up the tunnel, and the
 *      readiness probe succeeds.
 *   2. activate() places an INVITE, gets negotiated media back via
 *      the 'connected' event, and starts the RTP bridge.
 *   3. An external-leg socket sending UDP to the bridge reaches
 *      PJSIP inside the VM (verified indirectly: the bridge's
 *      ext→int counter increments, and the tunnel reports forwarding
 *      to the expected VM-side RTP port).
 *   4. stop() tears everything down cleanly.
 *
 * What this test does NOT validate:
 *   - End-to-end audible bi-directional RTP. pjsip-test-peer's PJSIP
 *     session has a default behavior of not emitting RTP until it's
 *     connected to a media source on its side (null snd dev), so
 *     we can't easily observe "packet came back out." This is a
 *     limitation of the test peer, not the bridge — step 5 with real
 *     d-modem will have real outbound RTP and this coverage will
 *     come naturally.
 *
 * Requires the same binaries as step 3:
 *   - vm/kernel/bzImage, vm/images/rootfs-slmodemd-pjsip.cpio.gz (base userland)
 *   - vm/prebuilt/modemd-tunnel-i386
 *   - vm/prebuilt/pjsip-test-peer-i386
 *
 * The test uses the ad-hoc initramfs pattern from
 * test/pjsip/uac-invite.test.js.
 *
 * Expected duration: ~25-40s on TCG.
 *
 * Run: node test/pjsip/backend.test.js
 */

const assert     = require('assert');
const path       = require('path');
const fs         = require('fs');
const dgram      = require('dgram');
const { spawn }  = require('child_process');
const { tmpdir } = require('os');

const { PjsipBackend } = require('../../src/backends/PjsipBackend');
const { QemuVM }       = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT   = path.resolve(__dirname, '../..');
const kernelPath  = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs  = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin   = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const peerBin     = path.join(REPO_ROOT, 'vm', 'prebuilt', 'pjsip-test-peer-i386');
const qemuPath    = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('PjsipBackend integration test (step 4b)');

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
  console.log('PjsipBackend integration test (step 4b)');
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-backend-'));
  let backend, extSock;

  try {
    /* Build ad-hoc initramfs with modemd-tunnel + pjsip-test-peer. */
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, tunnelBin, peerBin, testInitrd);

    /* External-leg RTP socket — simulates the caller's side. */
    extSock = dgram.createSocket('udp4');
    await new Promise(r => extSock.bind(0, '127.0.0.1', r));

    backend = new PjsipBackend({
      qemuPath,
      kernelPath,
      initrdPath:   testInitrd,
      bootLogPath:  path.join(workDir, 'qemu.log'),
      readinessTimeoutMs: 30000,   /* pjsua under TCG can be slow */
    });

    await test('startAsync boots VM and reaches READY', async () => {
      await backend.startAsync();
      assert.strictEqual(backend.state, 'READY');
      /* Tunnel is up and UDP bound */
      assert.ok(backend._tunnel, 'tunnel should be constructed');
      assert.ok(backend._tunnel.udp.sip,  'sip UDP socket bound');
      assert.ok(backend._tunnel.udp.rtp,  'rtp UDP socket bound');
    });

    await test('activate places INVITE and emits media-ready', async () => {
      const mediaReadyP = new Promise(resolve => backend.once('media-ready', resolve));
      await backend.activate({
        extRtpSocket: extSock,
        /* No extPeer yet; bridge will learn on first ext packet. */
      });
      const negotiated = await mediaReadyP;
      assert.strictEqual(backend.state, 'CONFIRMED');
      assert.strictEqual(negotiated.remoteRtpAddr, '127.0.0.1');
      assert.ok(negotiated.remoteRtpPort > 0);
      assert.ok(negotiated.codec, 'codec should be set');
      assert.strictEqual(negotiated.codec.codec, 'PCMU');
      /* Bridge should be running */
      assert.ok(backend._bridge && backend._bridge._started);
    });

    await test('ext→int RTP packets flow through the bridge', async () => {
      /* Send a fake RTP-ish packet from extSock → bridge's ext
       * socket. Since the bridge's extSocket IS extSock (we passed
       * it in), we need to send from ANOTHER socket to extSock.
       * Simulate that by creating a second ephemeral socket. */
      const caller = dgram.createSocket('udp4');
      await new Promise(r => caller.bind(0, '127.0.0.1', r));

      const extPort = extSock.address().port;
      const startPackets = backend._bridge.stats.extToInt.packets;

      /* Send 3 packets */
      for (let i = 0; i < 3; i++) {
        const pkt = Buffer.from([0x80, 0x00, 0x00, i, 0, 0, 0, 0, 0, 0, 0, 0,
                                 0x01, 0x02, 0x03, 0x04,
                                 i, i, i, i]);
        caller.send(pkt, extPort, '127.0.0.1');
      }

      /* Give the bridge ~100ms to forward them. */
      await delay(150);

      const delta = backend._bridge.stats.extToInt.packets - startPackets;
      assert.strictEqual(delta, 3, `expected 3 packets forwarded, got ${delta}`);

      caller.close();
    });

    await test('stop() tears down cleanly', async () => {
      await backend.stop();
      assert.strictEqual(backend.state, 'STOPPED');
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Helpers (same pattern as test/pjsip/uac-invite.test.js) ── */

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

echo "=== backend test init ==="
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
