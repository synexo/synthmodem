'use strict';

/*
 * test/pjsip/uac-invite.test.js — integration test for SipUacInternal.
 *
 * Boots a VM running modemd-tunnel + pjsip-test-peer, stands up a
 * UdpTcpTunnel on the host, and drives a full SIP dialog through
 * SipUacInternal:
 *
 *   1. probe() until peer is ready.
 *   2. invite() — expect CONFIRMED + negotiated media info.
 *   3. hangup() — expect clean teardown.
 *
 * This is the "step 3's test bytes are now reusable code" proof.
 * Unlike test/pjsip/signaling.test.js (which hand-crafts SIP
 * requests), this test uses the production SipUacInternal class
 * end-to-end.
 *
 * Requires:
 *   - qemu-system-i386
 *   - vm/images/bzImage
 *   - vm/images/rootfs-slmodemd-pjsip.cpio.gz
 *   - vm/prebuilt/modemd-tunnel-i386
 *   - vm/prebuilt/pjsip-test-peer-i386
 *
 * Expected duration: ~25-40s (pjsua startup dominates).
 *
 * Run: node test/pjsip/uac-invite.test.js
 */

const assert     = require('assert');
const path       = require('path');
const fs         = require('fs');
const net        = require('net');
const dgram      = require('dgram');
const { spawn }  = require('child_process');
const { tmpdir } = require('os');

const { UdpTcpTunnel }   = require('../../src/tunnel/UdpTcpTunnel');
const { SipUacInternal } = require('../../src/sip/SipUacInternal');
const { QemuVM }         = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT   = path.resolve(__dirname, '../..');
const kernelPath  = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs  = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin   = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const peerBin     = path.join(REPO_ROOT, 'vm', 'prebuilt', 'pjsip-test-peer-i386');
const qemuPath    = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('SipUacInternal integration test');

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
  console.log('SipUacInternal integration test');
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-uac-'));
  let vmChild, tunnel, uacSock, uac;

  try {
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, tunnelBin, peerBin, testInitrd);

    const { port: tcpPort, tcpServer, socketPromise } = await startTunnelListener();
    vmChild = spawnQemu(kernelPath, testInitrd, tcpPort, workDir);

    const tcpSocket = await socketPromise;
    tcpServer.close();

    /* Full tunnel start: binds UDP for real SIP forwarding.
     * vmSipPort=5090 matches pjsip-test-peer's default (step 5c). */
    tunnel = new UdpTcpTunnel({
      tcp: { host: '127.0.0.1', port: 1 },
      sipPort: 5062, rtpPort: 10002, rtcpPort: 10003,
      vmSipPort: 5090,
    });
    tunnel.tcpSocket = tcpSocket;
    tcpSocket.on('data', chunk => tunnel._onTcpData(chunk));
    await bindUdpChannels(tunnel);

    /* UAC's own UDP socket — separate from the tunnel's. */
    uacSock = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      uacSock.once('error', reject);
      uacSock.bind(0, '127.0.0.1', () => {
        uacSock.removeListener('error', reject);
        resolve();
      });
    });

    uac = new SipUacInternal({
      udpSocket:    uacSock,
      peerAddress:  '127.0.0.1',
      peerPort:     5062,                              /* tunnel host-side SIP port */
      localAddress: '127.0.0.1',
      targetUri:    'sip:modem@127.0.0.1:5090',       /* test peer port */
    });

    /* Readiness probe loop — pjsua takes several seconds to init. */
    const probeDeadline = Date.now() + 20000;
    let probeOk = false;
    while (Date.now() < probeDeadline) {
      try {
        await uac.probe({ timeoutMs: 1500 });
        probeOk = true;
        break;
      } catch (_) { /* retry */ }
    }
    assert.ok(probeOk, 'pjsip-test-peer did not respond to OPTIONS within 20s');

    await test('invite() returns negotiated media from pjsip-test-peer', async () => {
      const negotiated = await uac.invite({
        localRtpPort: 10002,
        offerCodecs: [
          { payloadType: 0, name: 'PCMU', clockRate: 8000 },
        ],
        timeoutMs: 10000,
      });
      assert.strictEqual(uac.state, 'CONFIRMED');
      assert.strictEqual(negotiated.remoteRtpAddr, '127.0.0.1');
      assert.ok(negotiated.remoteRtpPort > 0, 'remote RTP port should be set');
      /* pjsip-test-peer uses PCMU (we offered it). */
      assert.ok(negotiated.codec, 'codec should be negotiated');
      assert.strictEqual(negotiated.codec.codec, 'PCMU');
    });

    await test('hangup() tears down the dialog cleanly', async () => {
      await uac.hangup({ timeoutMs: 5000 });
      assert.strictEqual(uac.state, 'TERMINATED');
    });

  } finally {
    if (uac) { try { uac.close(); } catch (_) {} }
    if (uacSock) { try { uacSock.close(); } catch (_) {} }
    if (tunnel) {
      try {
        if (tunnel.tcpSocket) tunnel.tcpSocket.destroy();
        await tunnel.stop();
      } catch (_) {}
    }
    if (vmChild) {
      try { vmChild.kill('SIGKILL'); } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
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

/* ─── plumbing (shared with signaling.test.js; kept local for clarity) ── */

function startTunnelListener() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let resolved = false;
    let socketResolve, socketReject;
    const socketPromise = new Promise((res, rej) => { socketResolve = res; socketReject = rej; });
    const timer = setTimeout(() => {
      if (!resolved) socketReject(new Error('QEMU did not connect within 30s'));
    }, 30000);
    srv.once('connection', s => { resolved = true; clearTimeout(timer); socketResolve(s); });
    srv.once('error', err => { if (!resolved) reject(err); });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, tcpServer: srv, socketPromise });
    });
  });
}

function spawnQemu(kernelPath, initrdPath, tcpPort, logDir) {
  const args = [
    '-M', 'pc', '-m', '256', '-nographic',
    '-kernel', kernelPath, '-initrd', initrdPath,
    '-append', 'console=ttyS0 panic=-1 loglevel=3',
    '-no-reboot', '-accel', 'tcg',
    '-device', 'virtio-serial-pci,id=virtio-serial0',
    '-chardev', `socket,id=tunnel,host=127.0.0.1,port=${tcpPort},server=off`,
    '-device', 'virtserialport,chardev=tunnel,name=synthmodem.tunnel',
  ];
  const qemu = spawn(qemuPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logFile = fs.createWriteStream(path.join(logDir, 'qemu.log'));
  qemu.stdout.pipe(logFile);
  qemu.stderr.pipe(logFile);
  return qemu;
}

async function bindUdpChannels(tunnel) {
  await tunnel._bindUdp('sip',  tunnel.hostPorts.sip);
  await tunnel._bindUdp('rtp',  tunnel.hostPorts.rtp);
  await tunnel._bindUdp('rtcp', tunnel.hostPorts.rtcp);
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
# test/pjsip/uac-invite.test.js synthesized init.
set -e
mount -t proc     proc     /proc    2>/dev/null || true
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

MOD_DIR=/lib/modules/virtio
for m in virtio virtio_ring virtio_pci_legacy_dev virtio_pci_modern_dev \\
         virtio_pci virtio_console; do
    if [ -f "$MOD_DIR/$m.ko" ]; then
        insmod "$MOD_DIR/$m.ko" 2>/dev/null || true
    fi
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

echo "=== uac-invite test init ==="
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
