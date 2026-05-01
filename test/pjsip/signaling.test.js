'use strict';

/*
 * test/pjsip/signaling.test.js - step-3 integration test.
 *
 * Proves SIP signaling works end-to-end through the tunnel:
 *
 *   Node                    tunnel                   VM
 *   ────                    ──────                   ──
 *   UDP socket  --INVITE--> UdpTcpTunnel  --frame--> modemd-tunnel
 *                                                     --UDP-->  pjsip-test-peer
 *                                                              (pjsua-lib)
 *                                              <--frame-- UDP <--
 *                  <--200--
 *   UDP socket  --ACK----->
 *   UDP socket  --BYE----->                              ...
 *                  <--200--
 *
 * This test does NOT validate RTP media — that waits for step 4 when
 * SipUacInternal handles the media negotiation properly. All we want
 * here is: SIP roundtrips reliably, the SDP in 200 OK is parseable,
 * and basic dialog teardown (BYE -> 200) works.
 *
 * Architecture:
 *
 *   - Build a test initramfs containing both modemd-tunnel and
 *     pjsip-test-peer. Init script launches both and waits.
 *   - Host side: start TCP listener (for chardev socket), bring up
 *     UdpTcpTunnel via its normal start() path (real UDP binding),
 *     and a Node UDP socket to send/receive SIP messages.
 *   - Spawn QEMU with the tunnel chardev.
 *   - Send INVITE, wait for 200 OK, send ACK, send BYE, wait for 200.
 *
 * Requires:
 *   - qemu-system-i386
 *   - vm/kernel/bzImage
 *   - vm/images/rootfs-slmodemd-pjsip.cpio.gz (the slmodemd-pjsip rootfs as base userland)
 *   - vm/prebuilt/modemd-tunnel-i386
 *   - vm/prebuilt/pjsip-test-peer-i386
 *
 * Expected duration: ~25-40s under TCG (pjsua-lib init takes longer
 * to get "ready" than a plain modemd-tunnel; ~5-10s extra).
 *
 * Run: node test/pjsip/signaling.test.js
 */

const assert     = require('assert');
const path       = require('path');
const fs         = require('fs');
const net        = require('net');
const dgram      = require('dgram');
const { spawn }  = require('child_process');
const { tmpdir } = require('os');

const { UdpTcpTunnel } = require('../../src/tunnel/UdpTcpTunnel');
const { QemuVM }       = require('../../vm/qemu-runner/QemuVM');
const sipParser        = require('../../src/sip/SipParser');

const REPO_ROOT   = path.resolve(__dirname, '../..');
const kernelPath  = path.join(REPO_ROOT, 'vm', 'images', 'bzImage');
const baseRootfs  = path.join(REPO_ROOT, 'vm', 'images', 'rootfs-slmodemd-pjsip.cpio.gz');
const tunnelBin   = path.join(REPO_ROOT, 'vm', 'prebuilt', 'modemd-tunnel-i386');
const peerBin     = path.join(REPO_ROOT, 'vm', 'prebuilt', 'pjsip-test-peer-i386');
const qemuPath    = QemuVM.resolveQemuPath();

/* Skip on platforms that can't run our shell-based initrd rebuilder
 * (Windows without WSL). This test needs /bin/sh + zcat + cpio. */
const { skipIfNoUnixInitrdTools } = require('../_helpers/platform');
skipIfNoUnixInitrdTools('PJSIP test-peer signaling test (step 3)');

for (const [label, p] of [
  ['kernel',        kernelPath],
  ['base rootfs',   baseRootfs],
  ['tunnel binary', tunnelBin],
  ['peer binary',   peerBin],
]) {
  if (!fs.existsSync(p)) {
    console.error(`MISSING ${label}: ${p}`);
    if (label === 'tunnel binary' || label === 'peer binary') {
      console.error('Run scripts/build-pjsip-in-vm.sh to build it.');
    } else {
      console.error('Run `make -C vm` to build it.');
    }
    process.exit(1);
  }
}

/* ─── Test driver ──────────────────────────────────────────────────── */

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

async function run() {
  console.log('PJSIP test-peer signaling test (step 3)');
  console.log(`  qemu:         ${qemuPath}`);
  console.log(`  kernel:       ${kernelPath}`);
  console.log(`  base rootfs:  ${baseRootfs}`);
  console.log(`  tunnel bin:   ${tunnelBin}`);
  console.log(`  peer bin:     ${peerBin}`);
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-sip-'));
  console.log(`  workdir:      ${workDir}`);
  console.log('');

  let vmChild, tunnel, sipUdpSocket;

  try {
    /* 1. Build test initramfs */
    const testInitrd = path.join(workDir, 'test-initrd.cpio.gz');
    await buildTestInitrd(workDir, baseRootfs, tunnelBin, peerBin, testInitrd);
    console.log(`  built test initrd: ${fs.statSync(testInitrd).size} bytes`);

    /* 2. Start TCP listener for the tunnel chardev */
    const { port: tcpPort, tcpServer, socketPromise } = await startTunnelListener();
    console.log(`  tcp listener: 127.0.0.1:${tcpPort}`);

    /* 3. Spawn QEMU */
    vmChild = spawnQemu(kernelPath, testInitrd, tcpPort, workDir);

    const tcpSocket = await socketPromise;
    tcpServer.close();
    console.log('  qemu connected to tunnel chardev');

    /* 4. Bring up UdpTcpTunnel in 'full' mode (real UDP binding).
     *    vmSipPort=5090 matches pjsip-test-peer's default bind port
     *    (moved from 5060 in step 5c to make room for modemd-tunnel's
     *    symmetric-port binding). modemd-tunnel uses dst_port as the
     *    fallback target until it learns the test peer's source. */
    tunnel = new UdpTcpTunnel({
      tcp:      { host: '127.0.0.1', port: 1 },  // stub; we attach directly
      sipPort:  5062,
      rtpPort:  10002,
      rtcpPort: 10003,
      vmSipPort: 5090,
    });
    tunnel.tcpSocket = tcpSocket;
    tcpSocket.on('data', chunk => tunnel._onTcpData(chunk));
    tcpSocket.on('error', err => console.error(`tcp error: ${err.message}`));

    /* Bind the 3 UDP sockets the production start() would bind. We
     * only need SIP for this test, but bind all three to mirror
     * production. Uses a private helper to invoke the normal path. */
    await bindUdpChannels(tunnel);

    /* 5. Create the Node-side "SIP client" UDP socket. It sends to
     * 127.0.0.1:5062 (the tunnel's host-side SIP port) and receives
     * replies back from the same socket. */
    sipUdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const rxQueue = [];  // ordered queue of received UDP payloads (Buffers)
    const rxWaiters = []; // pending {resolve, predicate, timer} records
    sipUdpSocket.on('message', (msg) => {
      // Stick on the queue; let waiters match predicates.
      rxQueue.push(msg);
      pumpWaiters();
    });
    function pumpWaiters() {
      // For each waiter, scan the queue for a matching message.
      for (let i = 0; i < rxWaiters.length; i++) {
        const w = rxWaiters[i];
        for (let j = 0; j < rxQueue.length; j++) {
          if (w.predicate(rxQueue[j])) {
            clearTimeout(w.timer);
            const msg = rxQueue.splice(j, 1)[0];
            rxWaiters.splice(i, 1);
            w.resolve(msg);
            i--;  // adjust index since we removed an element
            break;
          }
        }
      }
    }
    function waitForMessage(predicate, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = rxWaiters.findIndex(w => w.timer === timer);
          if (idx >= 0) rxWaiters.splice(idx, 1);
          reject(new Error(
            `timeout (${timeoutMs}ms) waiting for ${label}. ` +
            `queue has ${rxQueue.length} messages.`));
        }, timeoutMs);
        rxWaiters.push({ predicate, timer, resolve });
        pumpWaiters();
      });
    }

    await new Promise((resolve, reject) => {
      sipUdpSocket.once('error', reject);
      /* Bind to an ephemeral port on loopback. The tunnel will learn
       * this as the host-side SIP peer on the first outgoing packet. */
      sipUdpSocket.bind(0, '127.0.0.1', () => {
        sipUdpSocket.removeListener('error', reject);
        resolve();
      });
    });
    const clientPort = sipUdpSocket.address().port;
    console.log(`  sip client:   127.0.0.1:${clientPort}`);

    /* 6. Wait for pjsip-test-peer to be ready. The VM log tells us,
     * but polling the log is fragile; instead we send an OPTIONS ping
     * and retry until we get a reply. pjsua responds to OPTIONS with
     * 200 OK even before any call is in progress. */
    console.log('  waiting for pjsip-test-peer ready...');
    await waitForPjsipReady(sipUdpSocket, waitForMessage, clientPort);
    console.log('  pjsip-test-peer ready');

    /* 7. Run the actual tests */
    const callState = { callId: null, fromTag: null, toTag: null, cseq: 1 };

    await test('INVITE receives 100 Trying then 200 OK', async () => {
      const callId = sipParser.generateCallId('127.0.0.1');
      const fromTag = sipParser.generateTag();
      callState.callId = callId;
      callState.fromTag = fromTag;

      const invite = buildInvite({
        fromPort: clientPort,
        callId,
        fromTag,
        cseq: callState.cseq,
      });
      sipUdpSocket.send(invite, 5062, '127.0.0.1');

      // Collect responses; expect 100 Trying (may or may not be sent,
      // PJSIP sends it for media-setup delay which is fast here) and
      // a definitive 200 OK.
      const ok200 = await waitForMessage(
        msg => {
          const parsed = sipParser.parse(msg.toString('utf8'));
          return parsed && !parsed.isRequest &&
                 parsed.statusCode === 200 &&
                 parsed.getHeader('cseq') && parsed.getHeader('cseq').includes('INVITE');
        },
        15000,
        '200 OK to INVITE');

      const parsed = sipParser.parse(ok200.toString('utf8'));
      assert.strictEqual(parsed.statusCode, 200);

      // Grab to-tag so we can build ACK/BYE correctly.
      const toHeader = parsed.getHeader('to');
      const toTagMatch = /;tag=([^;\s>]+)/.exec(toHeader);
      assert.ok(toTagMatch, `200 OK has no to-tag: ${toHeader}`);
      callState.toTag = toTagMatch[1];

      // Sanity check body is SDP with a media line.
      assert.match(parsed.body, /^m=audio\s+\d+/m, 'SDP body has m=audio');
    });

    await test('ACK to 200 OK does not error out', async () => {
      const ack = buildAck({
        fromPort: clientPort,
        callId:   callState.callId,
        fromTag:  callState.fromTag,
        toTag:    callState.toTag,
        cseq:     callState.cseq,
      });
      sipUdpSocket.send(ack, 5062, '127.0.0.1');
      callState.cseq++;
      /* No response expected to ACK by design. Give the VM a moment
       * to process it; if we sent BYE immediately after ACK, pjsua
       * might race. */
      await delay(200);
    });

    await test('BYE receives 200 OK', async () => {
      const bye = buildBye({
        fromPort: clientPort,
        callId:   callState.callId,
        fromTag:  callState.fromTag,
        toTag:    callState.toTag,
        cseq:     callState.cseq,
      });
      sipUdpSocket.send(bye, 5062, '127.0.0.1');

      const ok200 = await waitForMessage(
        msg => {
          const parsed = sipParser.parse(msg.toString('utf8'));
          return parsed && !parsed.isRequest &&
                 parsed.statusCode === 200 &&
                 parsed.getHeader('cseq') && parsed.getHeader('cseq').includes('BYE');
        },
        5000,
        '200 OK to BYE');

      const parsed = sipParser.parse(ok200.toString('utf8'));
      assert.strictEqual(parsed.statusCode, 200);
    });

  } finally {
    if (sipUdpSocket) {
      try { sipUdpSocket.close(); } catch (_) {}
    }
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
    // Keep workdir on ANY failure OR if tests never ran (e.g. readiness
    // timeout before tests kicked off). Delete only on complete success.
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

/* ─── SIP helpers ─────────────────────────────────────────────────── */

/**
 * Build a minimal valid INVITE from 127.0.0.1:<fromPort> to
 * sip:test-peer@127.0.0.1 on port 5090. SDP body offers PCMU on
 * port 10002 (the tunnel's host-side RTP port). No content
 * we actually care about for step 3 — pjsip-test-peer will
 * accept anything that parses.
 */
function buildInvite({ fromPort, callId, fromTag, cseq }) {
  const branch = sipParser.generateBranch();
  const sdp = [
    'v=0',
    `o=- 1234 5678 IN IP4 127.0.0.1`,
    's=synthmodem-test',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=audio 10002 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    '',
  ].join('\r\n');
  const sdpBytes = Buffer.byteLength(sdp, 'utf8');
  const headers = [
    'INVITE sip:test-peer@127.0.0.1:5090 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK${branch};rport`,
    `From: <sip:caller@127.0.0.1:${fromPort}>;tag=${fromTag}`,
    'To: <sip:test-peer@127.0.0.1:5090>',
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} INVITE`,
    `Contact: <sip:caller@127.0.0.1:${fromPort}>`,
    'Max-Forwards: 70',
    'User-Agent: synthmodem-test/0.1',
    'Content-Type: application/sdp',
    `Content-Length: ${sdpBytes}`,
    '',
  ].join('\r\n') + '\r\n';
  return Buffer.from(headers + sdp, 'utf8');
}

function buildAck({ fromPort, callId, fromTag, toTag, cseq }) {
  const branch = sipParser.generateBranch();
  const lines = [
    'ACK sip:test-peer@127.0.0.1:5090 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK${branch}`,
    `From: <sip:caller@127.0.0.1:${fromPort}>;tag=${fromTag}`,
    `To: <sip:test-peer@127.0.0.1:5090>;tag=${toTag}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ACK`,
    'Max-Forwards: 70',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  return Buffer.from(lines, 'utf8');
}

function buildBye({ fromPort, callId, fromTag, toTag, cseq }) {
  const branch = sipParser.generateBranch();
  const lines = [
    'BYE sip:test-peer@127.0.0.1:5090 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK${branch};rport`,
    `From: <sip:caller@127.0.0.1:${fromPort}>;tag=${fromTag}`,
    `To: <sip:test-peer@127.0.0.1:5090>;tag=${toTag}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} BYE`,
    'Max-Forwards: 70',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  return Buffer.from(lines, 'utf8');
}

function buildOptions({ fromPort }) {
  const callId = sipParser.generateCallId('127.0.0.1');
  const fromTag = sipParser.generateTag();
  const branch = sipParser.generateBranch();
  const lines = [
    'OPTIONS sip:test-peer@127.0.0.1:5090 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK${branch};rport`,
    `From: <sip:caller@127.0.0.1:${fromPort}>;tag=${fromTag}`,
    'To: <sip:test-peer@127.0.0.1:5090>',
    `Call-ID: ${callId}`,
    'CSeq: 1 OPTIONS',
    'Max-Forwards: 70',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  return Buffer.from(lines, 'utf8');
}

/**
 * Poll pjsip-test-peer with OPTIONS until it responds. PJSIP accepts
 * OPTIONS at any time once its UDP transport is up. Gives pjsua time
 * to finish initializing before we send the real INVITE.
 */
async function waitForPjsipReady(udpSocket, waitForMessage, clientPort) {
  const deadline = Date.now() + 20000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const opts = buildOptions({ fromPort: clientPort });
    udpSocket.send(opts, 5062, '127.0.0.1');
    try {
      await waitForMessage(
        msg => {
          // Any SIP response with status 2xx on OPTIONS means pjsua is alive.
          const text = msg.toString('utf8');
          return text.startsWith('SIP/2.0 2') && /OPTIONS/i.test(text);
        },
        1500,
        `OPTIONS response (attempt ${attempt})`);
      return;
    } catch (_) {
      // retry
    }
  }
  throw new Error('pjsip-test-peer did not respond to OPTIONS within 20s');
}

/* ─── VM / tunnel plumbing ────────────────────────────────────────── */

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

/**
 * Call UdpTcpTunnel's internal _bindUdp on each channel. We skip the
 * public start() because that also opens a TCP connection/listener,
 * and we've already attached the socket by hand. _bindUdp is a
 * private API but we're the same author — acceptable test coupling.
 */
async function bindUdpChannels(tunnel) {
  await tunnel._bindUdp('sip',  tunnel.hostPorts.sip);
  await tunnel._bindUdp('rtp',  tunnel.hostPorts.rtp);
  await tunnel._bindUdp('rtcp', tunnel.hostPorts.rtcp);
}

async function buildTestInitrd(workDir, basePath, tunnelBinPath, peerBinPath, outPath) {
  const stageDir = path.join(workDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });

  await execSh(`zcat ${sh(basePath)} | cpio -i --quiet --make-directories`,
    { cwd: stageDir });

  const localBin = path.join(stageDir, 'usr', 'local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.copyFileSync(tunnelBinPath, path.join(localBin, 'modemd-tunnel'));
  fs.copyFileSync(peerBinPath,   path.join(localBin, 'pjsip-test-peer'));
  fs.chmodSync(path.join(localBin, 'modemd-tunnel'),   0o755);
  fs.chmodSync(path.join(localBin, 'pjsip-test-peer'), 0o755);

  const initScript = `#!/bin/sh
# test/pjsip/signaling.test.js synthesized init.
# Launches modemd-tunnel and pjsip-test-peer; test only.

set -e

mount -t proc     proc     /proc    2>/dev/null || true
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true

# Bring up the loopback interface. Without this, 127.0.0.1 is
# unroutable and any TCP/UDP on lo fails with ENETUNREACH. (The shim-based image
# doesn't need this because slmodemd uses socketpairs (no IP); backend
# B does need it because PJSIP and modemd-tunnel both bind 127.0.0.1.
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

echo "=== pjsip-test-peer signaling-test init ==="
ls -la /dev/virtio-ports/ 2>&1

# Start modemd-tunnel in background. It'll open the chardev, bind
# UDP, and start forwarding. Put stderr to console so test harness
# can see errors if things go wrong.
echo "starting modemd-tunnel..."
SYNTHMODEM_LOG_LEVEL=debug /usr/local/bin/modemd-tunnel &
TUNNEL_PID=$!
sleep 1  # let it bind UDP before we start PJSIP

# Start pjsip-test-peer in foreground. On SIGTERM it'll exit cleanly.
echo "starting pjsip-test-peer..."
exec env PJSIP_TEST_PEER_LOG_LEVEL=5 /usr/local/bin/pjsip-test-peer
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

run().catch(err => { console.error('fatal:', err); process.exit(2); });
