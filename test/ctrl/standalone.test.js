'use strict';

/*
 * test/ctrl/standalone.test.js — modemd-ctrl standalone smoke test.
 *
 * Spawns the native modemd-ctrl binary and exercises its PTY ↔
 * control-channel bridge using Unix sockets as stand-ins for both
 * the virtio-serial chardev (production) and the slmodemd PTY (char
 * device). modemd-ctrl's open_host_path treats both transparently.
 *
 * Covers:
 *   - HELLO emission at startup
 *   - AT command wire frame → CR-terminated bytes on PTY
 *   - PTY bytes → AT_RESPONSE frame
 *   - "CONNECT" in PTY tail → data-mode transition →
 *     subsequent PTY bytes emit DATA_RX instead
 *   - DATA_TX frame → bytes on PTY
 *   - "NO CARRIER" → data-mode exit → back to AT_RESPONSE
 *   - Clean shutdown on SIGTERM
 *
 * No VM, no QEMU — ~2 second wall time.
 *
 * Run: node test/ctrl/standalone.test.js
 */

const assert      = require('assert');
const path        = require('path');
const fs          = require('fs');
const net         = require('net');
const { spawn }   = require('child_process');
const { tmpdir } = require('os');

const wire = require('../../vm/qemu-runner/wire');

const REPO_ROOT  = path.resolve(__dirname, '../..');
const CTRL_BIN   = path.join(REPO_ROOT, 'vm', 'ctrl', 'modemd-ctrl');

if (process.platform === 'win32') {
  console.log('SKIP: Windows host — this test needs the native modemd-ctrl');
  console.log('      binary (built with `make`) and Unix-domain sockets.');
  console.log('      Run under WSL2 or on a Linux/macOS host.');
  process.exit(0);
}

if (!fs.existsSync(CTRL_BIN)) {
  console.error(`MISSING binary: ${CTRL_BIN}`);
  console.error('Build it first: (cd vm/ctrl && make)');
  process.exit(1);
}

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Start a Unix-socket server listening on `path`; resolves with
 * the accepted Socket once the peer connects. */
function listenUnix(socketPath) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let done = false;
    srv.once('connection', s => {
      done = true;
      resolve({ srv, peer: s });
    });
    srv.once('error', err => { if (!done) reject(err); });
    srv.listen(socketPath);
  });
}

/* Read incoming bytes on `socket` into a Parser; collect frames. */
function attachParser(socket) {
  const parser = new wire.Parser();
  const frames = [];
  parser.on('frame', f => frames.push(f));
  parser.on('error', err => { /* rethrow via helper below */ });
  socket.on('data', chunk => parser.feed(chunk));
  return { parser, frames };
}

function waitForFrame(frames, predicate, timeoutMs = 2000, label = 'frame') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      for (let i = 0; i < frames.length; i++) {
        if (predicate(frames[i])) {
          const f = frames[i];
          frames.splice(i, 1);
          return resolve(f);
        }
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(
          `timeout (${timeoutMs}ms) waiting for ${label}; ` +
          `have ${frames.length} unmatched frame(s)`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function waitForBytes(buf, pattern, timeoutMs = 2000, label = 'bytes') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const idx = buf.value.indexOf(pattern);
      if (idx >= 0) {
        /* Return the matched bytes (and leave the rest in buf). */
        const match = Buffer.from(pattern);
        buf.value = Buffer.concat([
          buf.value.subarray(0, idx),
          buf.value.subarray(idx + pattern.length),
        ]);
        return resolve(match);
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(
          `timeout (${timeoutMs}ms) waiting for ${label}; ` +
          `have ${buf.value.length} buffered bytes: ${JSON.stringify(buf.value.toString('utf8'))}`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function run() {
  console.log('modemd-ctrl standalone smoke test');
  console.log('');

  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'synthmodem-ctrl-'));
  const ctrlPath = path.join(workDir, 'control.sock');
  const ptyPath  = path.join(workDir, 'pty.sock');

  let ctrlChild;
  let ctrlServer, ctrlPeer;
  let ptyServer, ptyPeer;
  let frameBuf;
  let ptyBuf = { value: Buffer.alloc(0) };

  try {
    /* Bring up listeners BEFORE spawning the child. The binary retries
     * connect() up to 20 × 100ms so races aren't fatal, but listen-
     * first is tidier. */
    const ctrlListening = listenUnix(ctrlPath);
    const ptyListening  = listenUnix(ptyPath);

    ctrlChild = spawn(CTRL_BIN, [], {
      env: {
        ...process.env,
        SYNTHMODEM_CONTROL_PATH: ctrlPath,
        SYNTHMODEM_PTY_PATH:     ptyPath,
        SYNTHMODEM_LOG_LEVEL:    'debug',
        SYNTHMODEM_BUILD_ID:     'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childLog = [];
    ctrlChild.stdout.on('data', d => childLog.push(d));
    ctrlChild.stderr.on('data', d => childLog.push(d));
    ctrlChild.on('exit', (code, signal) => {
      childLog.push(Buffer.from(`\n[ctrl exit code=${code} signal=${signal}]\n`));
    });

    const a = await ctrlListening;
    ctrlServer = a.srv; ctrlPeer = a.peer;
    const b = await ptyListening;
    ptyServer  = b.srv; ptyPeer  = b.peer;

    frameBuf = attachParser(ctrlPeer);
    ptyPeer.on('data', chunk => {
      ptyBuf.value = Buffer.concat([ptyBuf.value, chunk]);
    });

    await test('emits HELLO frame at startup', async () => {
      const f = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.HELLO, 3000, 'HELLO');
      const text = f.payload.toString('utf8');
      assert.match(text, /^modemd-ctrl v1 build=/);
    });

    await test('AT wire frame → CR-terminated bytes on PTY', async () => {
      /* Host sends AT — modemd-ctrl should write "AT\r" to the PTY. */
      const frame = wire.encode(wire.TYPE.AT, 'AT');
      ctrlPeer.write(frame);
      await waitForBytes(ptyBuf, Buffer.from('AT\r'), 2000, 'AT\\r on PTY');
    });

    await test('PTY bytes → AT_RESPONSE frame', async () => {
      /* Peer writes to the PTY — should surface as AT_RESPONSE on the
       * control channel. */
      ptyPeer.write(Buffer.from('OK\r\n'));
      const f = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE, 2000, 'AT_RESPONSE');
      assert.strictEqual(f.payload.toString('utf8'), 'OK\r\n');
    });

    await test('CONNECT in PTY tail flips to data mode — subsequent bytes become DATA_RX', async () => {
      ptyPeer.write(Buffer.from('CONNECT 33600\r\n'));
      /* The "CONNECT 33600\r\n" bytes themselves arrive as AT_RESPONSE
       * — the line-aware emit path detects the keyword + terminator
       * and wraps the entire line as one AT_RESPONSE frame. */
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE, 2000, 'AT_RESPONSE for CONNECT');
      assert.match(atResp.payload.toString('utf8'), /CONNECT 33600/);
      /* And a MODEM_STATUS frame should now have been emitted with the
       * parsed rate. */
      const status = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.MODEM_STATUS, 2000, 'MODEM_STATUS connect');
      assert.match(status.payload.toString('utf8'), /"event":"connect"/);
      assert.match(status.payload.toString('utf8'), /"rate":33600/);
      /* A follow-up byte should arrive as DATA_RX. */
      ptyPeer.write(Buffer.from('hello'));
      const dataRx = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.DATA_RX, 2000, 'DATA_RX after CONNECT');
      assert.strictEqual(dataRx.payload.toString('utf8'), 'hello');
    });

    await test('DATA_TX frame → bytes on PTY', async () => {
      const frame = wire.encode(wire.TYPE.DATA_TX, 'world');
      ctrlPeer.write(frame);
      await waitForBytes(ptyBuf, Buffer.from('world'), 2000, 'world on PTY');
    });

    await test('NO CARRIER mid-data-mode goes out as AT_RESPONSE (not DATA_RX)', async () => {
      /* Send data first, then NO CARRIER. The data bytes should
       * arrive as DATA_RX, but the "NO CARRIER\r\n" line itself
       * MUST arrive as AT_RESPONSE (this is the bug the new code
       * fixes — historically these bytes leaked as DATA_RX because
       * data_mode was still true at read time). */
      ptyPeer.write(Buffer.from('user-data\r\nNO CARRIER\r\n'));
      /* The pre-keyword bytes arrive as DATA_RX (real keystrokes /
       * V.42 frames). */
      const dataPart = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.DATA_RX, 2000, 'DATA_RX before NO CARRIER');
      assert.match(dataPart.payload.toString('utf8'), /user-data/);
      /* The NO CARRIER line itself is AT_RESPONSE. */
      const ncResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE, 2000, 'AT_RESPONSE for NO CARRIER');
      assert.match(ncResp.payload.toString('utf8'), /NO CARRIER\r\n$/);
      /* MODEM_STATUS nocarrier should be emitted. */
      const status = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.MODEM_STATUS, 2000, 'MODEM_STATUS nocarrier');
      assert.match(status.payload.toString('utf8'), /"event":"nocarrier"/);
      /* After the flip, new PTY bytes are AT_RESPONSE again. */
      ptyPeer.write(Buffer.from('OK\r\n'));
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE, 2000, 'AT_RESPONSE after NO CARRIER');
      assert.strictEqual(atResp.payload.toString('utf8'), 'OK\r\n');
    });

    /* ─── Line-aware emit: the bug-fix tests ──────────────────────
     * These reproduce the production failure modes that motivated
     * the rewrite. Each writes the PTY in two pieces, separated by
     * a brief sleep, simulating slmodemd's split-write pattern. */

    await test('CONNECT split across two PTY writes still emits as one AT_RESPONSE', async () => {
      /* Reset to command mode by going through a full call cycle:
       * since the previous test ended with us back in command mode,
       * we're already there. */
      ptyPeer.write(Buffer.from('\r\nCONNECT 21600'));
      /* No terminator yet — the line-aware path holds these bytes
       * pending. We should NOT see an AT_RESPONSE yet for the
       * CONNECT line. The leading "\r\n" however is safe to emit
       * (it can't start a transition keyword) so it WILL come out
       * as an AT_RESPONSE. */
      await delay(50);
      /* No CONNECT-bearing frame should have arrived yet — only a
       * possible "\r\n" prefix. */
      const earlyConnect = frameBuf.frames.find(
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.toString('utf8').includes('CONNECT')
      );
      assert.strictEqual(earlyConnect, undefined,
        'CONNECT line should be pending until \\r\\n arrives');
      /* Now the terminator arrives. */
      ptyPeer.write(Buffer.from('\r\n'));
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.toString('utf8').includes('CONNECT'),
        2000, 'AT_RESPONSE containing CONNECT');
      /* The frame must contain BOTH the keyword and the terminator
       * — a single frame, not two. */
      const text = atResp.payload.toString('utf8');
      assert.match(text, /CONNECT 21600\r\n$/);
      const status = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.MODEM_STATUS, 2000, 'MODEM_STATUS for split CONNECT');
      assert.match(status.payload.toString('utf8'), /"rate":21600/);
    });

    await test('NO CARRIER split across two PTY writes still emits as one AT_RESPONSE', async () => {
      /* We're back in data_mode after the previous CONNECT. Send
       * a partial NO CARRIER. */
      ptyPeer.write(Buffer.from('NO CARRIER'));
      await delay(50);
      const earlyNc = frameBuf.frames.find(
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.toString('utf8').includes('NO CARRIER')
      );
      assert.strictEqual(earlyNc, undefined,
        'NO CARRIER line should be pending until \\r\\n arrives');
      /* Terminator arrives. */
      ptyPeer.write(Buffer.from('\r\n'));
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.toString('utf8').includes('NO CARRIER'),
        2000, 'AT_RESPONSE containing NO CARRIER');
      assert.match(atResp.payload.toString('utf8'), /NO CARRIER\r\n$/);
      /* And status. */
      const status = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.MODEM_STATUS, 2000, 'MODEM_STATUS for split NO CARRIER');
      assert.match(status.payload.toString('utf8'), /"event":"nocarrier"/);
    });

    await test('DATA_RX bytes that look like partial CONNECT do NOT defer real data', async () => {
      /* In command mode (we just exited via NO CARRIER). Send a
       * one-byte chunk that could be the start of CONNECT. The
       * line-aware path defers it. Send an unrelated byte after.
       * Both should eventually emit as AT_RESPONSE in order. */
      ptyPeer.write(Buffer.from('C'));
      await delay(30);
      ptyPeer.write(Buffer.from('TRL\r\n'));    /* doesn't form CONNECT */
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.toString('utf8').includes('CTRL'),
        2000, 'AT_RESPONSE containing CTRL');
      /* The deferred 'C' must appear concatenated with the rest. */
      assert.match(atResp.payload.toString('utf8'), /^CTRL\r\n$|C(.*?)TRL\r\n$/);
    });

    await test('long benign output does not get stuck in pending buffer', async () => {
      /* Simulate AT response longer than the partial-keyword tail
       * so we exercise the immediate-emit fast path. 200 bytes of
       * non-keyword data. */
      const big = Buffer.from('A'.repeat(200) + '\r\n');
      ptyPeer.write(big);
      const atResp = await waitForFrame(frameBuf.frames,
        f => f.type === wire.TYPE.AT_RESPONSE
          && f.payload.length >= 200,
        2000, 'large AT_RESPONSE');
      assert.match(atResp.payload.toString('utf8'), /^A+\r\n$/);
    });

    await test('SIGTERM → clean exit', async () => {
      const exited = new Promise(resolve => ctrlChild.on('exit', (c, s) => resolve({c, s})));
      ctrlChild.kill('SIGTERM');
      const { c, s } = await Promise.race([
        exited,
        delay(2000).then(() => { throw new Error('child did not exit within 2s'); }),
      ]);
      assert.ok(c === 0 || s === 'SIGTERM',
        `unclean exit: code=${c} signal=${s}`);
    });

  } finally {
    if (ctrlChild && ctrlChild.exitCode === null) {
      try { ctrlChild.kill('SIGKILL'); } catch (_) {}
    }
    if (ctrlPeer) try { ctrlPeer.destroy(); } catch (_) {}
    if (ptyPeer)  try { ptyPeer.destroy();  } catch (_) {}
    if (ctrlServer) try { ctrlServer.close(); } catch (_) {}
    if (ptyServer)  try { ptyServer.close();  } catch (_) {}
    /* Clean up socket files if still there. */
    try { fs.unlinkSync(ctrlPath); } catch (_) {}
    try { fs.unlinkSync(ptyPath);  } catch (_) {}
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

run().catch(err => { console.error('fatal:', err); process.exit(2); });
