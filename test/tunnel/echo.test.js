'use strict';

/*
 * test/tunnel/echo.test.js - integrated tunnel echo roundtrip.
 *
 * This is the real test of step 2: Node-side UdpTcpTunnel sends an
 * echo frame through a real virtio-serial chardev to a real
 * modemd-tunnel running inside a real QEMU VM, and the frame comes
 * back. If this passes, the transport layer is known-good end-to-end
 * and the next step can build on it.
 *
 * Architecture of the test:
 *
 *   Node process                                  QEMU (guest)
 *   -------------                                 ------------
 *   net.createServer       <-- TCP connect --     chardev=socket,
 *      listens on                                   server=off
 *      ephemeral port             |
 *                                 | (virtio-serial framing)
 *                                 v
 *   UdpTcpTunnel            <------------->     /dev/virtio-ports/
 *      constructed but                            synthmodem.tunnel
 *      socket hand-attached                          |
 *                                                    | (open + r/w)
 *                                                    v
 *                                               modemd-tunnel (echo
 *                                                on channel 255)
 *
 * Test flow:
 *   1. Assemble a tiny initramfs with busybox + modemd-tunnel +
 *      an init that launches modemd-tunnel against
 *      /dev/virtio-ports/synthmodem.tunnel.
 *   2. Start a Node TCP server on an ephemeral port.
 *   3. Spawn QEMU with a chardev=socket pointing at that port,
 *      mapped into the guest as a virtio-serial port.
 *   4. Once QEMU connects, attach the socket to UdpTcpTunnel.
 *   5. Call tunnel.sendEcho('hello'); expect an echo-reply event
 *      with 'hello' within a few seconds.
 *
 * Requires:
 *   - qemu-system-i386 on PATH (or $QEMU_SYSTEM_I386)
 *   - cpio, gzip on PATH
 *   - vm/images/bzImage built
 *   - vm/prebuilt/modemd-tunnel-i386 built (run
 *     scripts/build-pjsip-in-vm.sh if missing)
 *   - vm/images/rootfs-slmodemd-pjsip.cpio.gz as a source of busybox + libc + kernel
 *     modules (the slmodemd-pjsip rootfs is a convenient minimal-userland
 *     base; we extend it rather than rebuilding from scratch)
 *
 * Expected duration: ~20-30s (most is TCG boot).
 *
 * Run: node test/tunnel/echo.test.js
 */

const assert      = require('assert');
const path        = require('path');
const fs          = require('fs');
const net         = require('net');
const { spawn }   = require('child_process');
const { tmpdir }  = require('os');
const { UdpTcpTunnel } = require('../../src/tunnel/UdpTcpTunnel');
const { QemuVM } = require('../../vm/qemu-runner/QemuVM');

const REPO_ROOT    = path.resolve(__dirname, '../..');
const kernelPath   = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs   = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin    = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const qemuPath     = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('Tunnel echo integration test');

for (const [label, p] of [
  ['kernel',        kernelPath],
  ['base rootfs',   baseRootfs],
  ['tunnel binary', tunnelBin],
]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING ${label}: ${p}`);
    if (label === 'tunnel binary') {
      console.error('Run scripts/build-pjsip-in-vm.sh to build it.');
    } else {
      console.error('Run `make -C vm` to build it.');
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

async function run() {
  console.log('Tunnel echo integration test');
  console.log(`  qemu:         ${qemuPath}`);
  console.log(`  kernel:       ${kernelPath}`);
  console.log(`  base rootfs:  ${baseRootfs}`);
  console.log(`  tunnel bin:   ${tunnelBin}`);
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-tunnel-'));
  console.log(`  workdir:      ${workDir}`);
  console.log('');

  let vmChild, tunnel;

  try {
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, tunnelBin, testInitrd);
    console.log(`  built test initrd: ${fs.statSync(testInitrd).size} bytes`);

    const { port, tcpServer, socketPromise } = await startTunnelListener();
    console.log(`  tcp listener: 127.0.0.1:${port}`);
    vmChild = spawnQemu(kernelPath, testInitrd, port, workDir);

    const tcpSocket = await socketPromise;
    tcpServer.close();

    tunnel = new UdpTcpTunnel({
      tcp: { host: '127.0.0.1', port: 1 },
    });
    tunnel.tcpSocket = tcpSocket;
    tcpSocket.on('data',  chunk => tunnel._onTcpData(chunk));
    tcpSocket.on('error', err   => console.error(`tcp error: ${err.message}`));
    tcpSocket.on('close', ()    => console.log('tcp closed'));

    await test('echo roundtrip through modemd-tunnel in VM', async () => {
      const payload = Buffer.from('hello-tunnel-echo');
      const srcPort = 1111;
      const dstPort = 2222;
      const replyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('echo timeout (15s)')), 15000);
        tunnel.once('echo-reply', (rxPayload, rxSrc, rxDst) => {
          clearTimeout(timer);
          resolve({ payload: rxPayload, srcPort: rxSrc, dstPort: rxDst });
        });
      });
      tunnel.sendEcho(payload, srcPort, dstPort);
      const reply = await replyPromise;
      assert.deepStrictEqual(reply.payload, payload);
      assert.strictEqual(reply.srcPort, dstPort, 'echo should swap src<->dst');
      assert.strictEqual(reply.dstPort, srcPort, 'echo should swap src<->dst');
    });

    await test('multiple sequential echoes all roundtrip', async () => {
      const count = 5;
      let received = 0;
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`only received ${received}/${count} after 10s`)),
          10000);
        tunnel.on('echo-reply', () => {
          received++;
          if (received === count) { clearTimeout(timer); resolve(); }
        });
      });
      for (let i = 0; i < count; i++) {
        tunnel.sendEcho(Buffer.from(`ping-${i}`), 1000 + i, 2000 + i);
      }
      await done;
    });

    await test('large payload (~4KB) roundtrips intact', async () => {
      const payload = Buffer.alloc(4096);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xFF;
      const replyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('echo timeout (10s)')), 10000);
        tunnel.once('echo-reply', rxPayload => { clearTimeout(timer); resolve(rxPayload); });
      });
      tunnel.sendEcho(payload, 0, 0);
      const received = await replyPromise;
      assert.strictEqual(received.length, payload.length);
      assert.deepStrictEqual(received, payload);
    });

  } finally {
    if (tunnel) {
      try { if (tunnel.tcpSocket) tunnel.tcpSocket.destroy(); } catch (_) {}
    }
    if (vmChild) {
      try { vmChild.kill('SIGKILL'); } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (failed > 0) {
      console.log(`  (keeping workdir for debug: ${workDir})`);
    } else {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function startTunnelListener() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let resolved = false;
    let socketResolve, socketReject;
    const socketPromise = new Promise((res, rej) => { socketResolve = res; socketReject = rej; });
    const socketTimer = setTimeout(() => {
      if (!resolved) socketReject(new Error('QEMU did not connect within 30s'));
    }, 30000);
    srv.once('connection', s => {
      resolved = true;
      clearTimeout(socketTimer);
      socketResolve(s);
    });
    srv.once('error', err => { if (!resolved) reject(err); });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, tcpServer: srv, socketPromise });
    });
  });
}

function spawnQemu(kernelPath, initrdPath, tcpPort, logDir) {
  const args = [
    '-M', 'pc',
    '-m', '256',
    '-nographic',
    '-kernel', kernelPath,
    '-initrd', initrdPath,
    '-append', 'console=ttyS0 panic=-1 loglevel=3',
    '-no-reboot',
    '-accel', 'tcg',
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

async function buildTestInitrd(workDir, basePath, tunnelBinPath, outPath) {
  const stageDir = path.join(workDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });

  await execSh(`zcat ${sh(basePath)} | cpio -i --quiet --make-directories`,
    { cwd: stageDir });

  fs.mkdirSync(path.join(stageDir, 'usr', 'local', 'bin'), { recursive: true });
  fs.copyFileSync(tunnelBinPath, path.join(stageDir, 'usr', 'local', 'bin', 'modemd-tunnel'));
  fs.chmodSync(path.join(stageDir, 'usr', 'local', 'bin', 'modemd-tunnel'), 0o755);

  // Write init script that loads virtio modules in correct order,
  // creates /dev/virtio-ports symlinks, and execs modemd-tunnel.
  // Modeled on the slmodemd-pjsip overlay's init script structure.
  const initScript = `#!/bin/sh
# test/tunnel/echo.test.js synthesized init -- launches modemd-tunnel.
# This replaces S99modem for the echo test only; NOT a production file.

set -e

mount -t proc     proc     /proc    2>/dev/null || true
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true

MOD_DIR=/lib/modules/virtio
for m in virtio virtio_ring virtio_pci_legacy_dev virtio_pci_modern_dev \\
         virtio_pci virtio_console; do
    if [ -f "$MOD_DIR/$m.ko" ]; then
        insmod "$MOD_DIR/$m.ko" 2>/dev/null || true
    fi
done

# Wait up to 5s for /sys/class/virtio-ports/vport* to populate.
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

echo "=== tunnel-echo test init ==="
ls -la /dev/virtio-ports/ 2>&1
ls -la /usr/local/bin/modemd-tunnel

if [ ! -L /dev/virtio-ports/synthmodem.tunnel ] && \\
   [ ! -c /dev/virtio-ports/synthmodem.tunnel ]; then
    echo "FATAL: synthmodem.tunnel not present"
    sleep 30
    exit 1
fi

echo "launching modemd-tunnel..."
exec env SYNTHMODEM_LOG_LEVEL=debug /usr/local/bin/modemd-tunnel
`;

  const initD = path.join(stageDir, 'etc', 'init.d');
  fs.mkdirSync(initD, { recursive: true });
  fs.writeFileSync(path.join(initD, 'S99modem'), initScript);
  fs.chmodSync(path.join(initD, 'S99modem'), 0o755);

  await execSh(`find . -print0 | cpio --null -H newc --create --quiet | gzip -5 > ${sh(outPath)}`,
    { cwd: stageDir });
}

function sh(str) { return `'${String(str).replace(/'/g, "'\\''")}'`; }

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
