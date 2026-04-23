'use strict';

/*
 * test/slmodem/logging.test.js — unit tests for the M2 diagnostic
 * logging pipeline.
 *
 * Scope:
 *   - buildQemuArgs honors guestLogLevel → synthmodem_log= on cmdline
 *   - SlmodemVM emits 'frame-trace' events when traceWireFrames=true
 *   - QemuVM honors bootLogPath + crashDumpDir options (constructor-
 *     level wiring only; live I/O behavior is covered by vm-smoke)
 *
 * Deliberately no QEMU spawn here — these are pure function and
 * wiring tests. They run in <100ms.
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { buildQemuArgs } = require('../../vm/qemu-runner/qemu-args');
const wire              = require('../../vm/qemu-runner/wire');

let passed = 0;
let failed = 0;
function ok(msg)    { console.log('  ok  ', msg); passed++; }
function fail(msg, err) {
  console.log('  FAIL', msg);
  if (err) console.log('       ', err && err.stack ? err.stack : err);
  failed++;
}
const _queue = [];
function test(name, fn) { _queue.push([name, fn]); }
async function _run() {
  for (const [name, fn] of _queue) {
    try { await fn(); ok(name); }
    catch (e) { fail(name, e); }
  }
}

// ─── buildQemuArgs guestLogLevel ────────────────────────────────────

test('buildQemuArgs: no guestLogLevel → no synthmodem_log in -append', () => {
  const { args } = buildQemuArgs({
    kernelPath:      '/tmp/bz',
    initrdPath:      '/tmp/rootfs',
    audioSockPath:   '/tmp/a.sock',
    controlSockPath: '/tmp/c.sock',
    accel: 'tcg',
  });
  const appendIdx = args.indexOf('-append');
  assert.ok(appendIdx >= 0, '-append present');
  const append = args[appendIdx + 1];
  assert.doesNotMatch(append, /synthmodem_log/,
    `no synthmodem_log when not requested; got: ${append}`);
});

test('buildQemuArgs: guestLogLevel=info → synthmodem_log=info', () => {
  const { args } = buildQemuArgs({
    kernelPath:      '/tmp/bz',
    initrdPath:      '/tmp/rootfs',
    audioSockPath:   '/tmp/a.sock',
    controlSockPath: '/tmp/c.sock',
    accel: 'tcg',
    guestLogLevel: 'info',
  });
  const append = args[args.indexOf('-append') + 1];
  assert.match(append, /\bsynthmodem_log=info\b/,
    `expected synthmodem_log=info in: ${append}`);
});

test('buildQemuArgs: guestLogLevel=debug → synthmodem_log=debug', () => {
  const { args } = buildQemuArgs({
    kernelPath:      '/tmp/bz',
    initrdPath:      '/tmp/rootfs',
    audioSockPath:   '/tmp/a.sock',
    controlSockPath: '/tmp/c.sock',
    accel: 'tcg',
    guestLogLevel: 'debug',
  });
  const append = args[args.indexOf('-append') + 1];
  assert.match(append, /\bsynthmodem_log=debug\b/,
    `expected synthmodem_log=debug in: ${append}`);
});

test('buildQemuArgs: invalid guestLogLevel throws', () => {
  assert.throws(() => {
    buildQemuArgs({
      kernelPath:      '/tmp/bz',
      initrdPath:      '/tmp/rootfs',
      audioSockPath:   '/tmp/a.sock',
      controlSockPath: '/tmp/c.sock',
      accel: 'tcg',
      guestLogLevel: 'trace',   // not a supported value
    });
  }, /guestLogLevel/);
});

test('buildQemuArgs: appendExtra + guestLogLevel both present', () => {
  const { args } = buildQemuArgs({
    kernelPath:      '/tmp/bz',
    initrdPath:      '/tmp/rootfs',
    audioSockPath:   '/tmp/a.sock',
    controlSockPath: '/tmp/c.sock',
    accel: 'tcg',
    guestLogLevel: 'info',
    appendExtra:   'nosmp debug',
  });
  const append = args[args.indexOf('-append') + 1];
  assert.match(append, /synthmodem_log=info/);
  assert.match(append, /nosmp debug/);
});

// ─── SlmodemVM traceWireFrames event emission ────────────────────────
// We exercise this without spawning anything by driving the parsers
// manually and calling the send methods directly.

test('SlmodemVM: traceWireFrames=false emits no frame-trace events', () => {
  const { SlmodemVM } = require('../../vm/qemu-runner/SlmodemVM');
  const vm = new SlmodemVM({
    slmodemdPath: '/bin/true',
    shimPath:     '/bin/true',
    traceWireFrames: false,
  });
  let seen = 0;
  vm.on('frame-trace', () => seen++);

  // _trace is the internal hook; call it directly and confirm no emit.
  vm._trace('tx', 'control', wire.TYPE.AT, 'AT');
  vm._trace('rx', 'audio',   wire.TYPE.AUDIO, Buffer.alloc(320));
  assert.strictEqual(seen, 0, 'no frame-trace events when disabled');
});

test('SlmodemVM: traceWireFrames=true emits shaped events', () => {
  const { SlmodemVM } = require('../../vm/qemu-runner/SlmodemVM');
  const vm = new SlmodemVM({
    slmodemdPath: '/bin/true',
    shimPath:     '/bin/true',
    traceWireFrames: true,
  });
  const events = [];
  vm.on('frame-trace', ev => events.push(ev));

  vm._trace('tx', 'control', wire.TYPE.AT, 'ATI3');
  vm._trace('rx', 'control', wire.TYPE.AT_RESPONSE, Buffer.from('OK\r\n'));
  vm._trace('rx', 'audio',   wire.TYPE.AUDIO, Buffer.alloc(320, 0x42));

  assert.strictEqual(events.length, 3);

  assert.strictEqual(events[0].dir,      'tx');
  assert.strictEqual(events[0].channel,  'control');
  assert.strictEqual(events[0].type,     wire.TYPE.AT);
  assert.strictEqual(events[0].typeName, 'AT');
  assert.strictEqual(events[0].size,     4);       // 'ATI3' is 4 bytes
  assert.match(events[0].preview, /^41544933$/);   // 'ATI3' in hex

  assert.strictEqual(events[1].typeName, 'AT_RESPONSE');
  assert.strictEqual(events[1].size,     4);

  assert.strictEqual(events[2].channel,  'audio');
  assert.strictEqual(events[2].size,     320);
  // preview is first 32 bytes, all 0x42.
  assert.strictEqual(events[2].preview.length, 64); // 32 bytes = 64 hex chars
  assert.match(events[2].preview, /^(42){32}$/);
});

test('SlmodemVM: frame-trace preview capped at 32 bytes', () => {
  const { SlmodemVM } = require('../../vm/qemu-runner/SlmodemVM');
  const vm = new SlmodemVM({
    slmodemdPath: '/bin/true',
    shimPath:     '/bin/true',
    traceWireFrames: true,
  });
  const events = [];
  vm.on('frame-trace', ev => events.push(ev));
  vm._trace('tx', 'audio', wire.TYPE.AUDIO, Buffer.alloc(500, 0xAB));
  assert.strictEqual(events[0].size, 500);
  assert.strictEqual(events[0].preview.length, 64);  // 32 bytes
});

// ─── QemuVM option wiring ───────────────────────────────────────────
// These tests only verify the constructor stores options correctly;
// they don't actually spawn qemu. We need a qemuPath that exists on
// every platform we test on, so use process.execPath (the Node binary
// running this test — guaranteed to exist on Linux, macOS, and Windows).
// Kernel/initrd paths are stand-in files pointed at this test file.

test('QemuVM: bootLogPath + crashDumpDir flow into instance fields', () => {
  const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
  // Use this test file itself as kernel/initrd stand-ins; we don't boot.
  const tmpFile = __filename;
  const vm = new QemuVM({
    qemuPath:     process.execPath,
    kernelPath:   tmpFile,
    initrdPath:   tmpFile,
    bootLogPath:  '/tmp/does-not-exist/boot.log',
    crashDumpDir: '/tmp/does-not-exist-dir',
  });
  assert.strictEqual(vm._bootLogPath,  '/tmp/does-not-exist/boot.log');
  assert.strictEqual(vm._crashDumpDir, '/tmp/does-not-exist-dir');
  assert.strictEqual(vm._bootLogStream, null, 'stream not opened yet');
});

test('QemuVM: logLevel=info produces guestLogLevel=info in qemuOpts', () => {
  const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
  const tmpFile = __filename;
  const vm = new QemuVM({
    qemuPath:    process.execPath,
    kernelPath:  tmpFile,
    initrdPath:  tmpFile,
    logLevel:    'info',
  });
  assert.strictEqual(vm.qemuOpts.guestLogLevel, 'info');
});

test('QemuVM: logLevel=error produces no guestLogLevel (null)', () => {
  const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
  const tmpFile = __filename;
  const vm = new QemuVM({
    qemuPath:    process.execPath,
    kernelPath:  tmpFile,
    initrdPath:  tmpFile,
    logLevel:    'error',
  });
  assert.strictEqual(vm.qemuOpts.guestLogLevel, null,
    'error level should not propagate to guest');
});

// ─── Boot log stream actually writes when triggered ──────────────────

test('QemuVM: _writeBootLog creates parent dir and writes header', async () => {
  const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synthmodem-logtest-'));
  const logPath = path.join(tmpRoot, 'sub', 'boot.log');
  try {
    const vm = new QemuVM({
      qemuPath:    process.execPath,
      kernelPath:  __filename,
      initrdPath:  __filename,
      bootLogPath: logPath,
    });
    vm._writeBootLog('hello world\n');
    // Stream writes are buffered; wait for the close event before reading.
    await new Promise(resolve => {
      vm._bootLogStream.once('finish', resolve);
      vm._bootLogStream.end();
    });
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /==== QemuVM boot /, 'should include header');
    assert.match(content, /hello world/,       'should include payload');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('QemuVM: _maybeCrashDump writes log+meta only on unclean exit', () => {
  const { QemuVM } = require('../../vm/qemu-runner/QemuVM');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synthmodem-crashtest-'));
  try {
    const vm = new QemuVM({
      qemuPath:    process.execPath,
      kernelPath:  __filename,
      initrdPath:  __filename,
      crashDumpDir: tmpRoot,
    });
    vm._bootLog = 'fake boot log contents\n';

    // Clean exit: should NOT dump.
    vm._maybeCrashDump({ code: 0, signal: null });
    let files = fs.readdirSync(tmpRoot);
    assert.strictEqual(files.length, 0, 'no dump on clean exit');

    // SIGTERM (our voluntary stop): should NOT dump.
    vm._maybeCrashDump({ code: null, signal: 'SIGTERM' });
    files = fs.readdirSync(tmpRoot);
    assert.strictEqual(files.length, 0, 'no dump on voluntary stop');

    // Non-zero exit: SHOULD dump.
    vm._maybeCrashDump({ code: 1, signal: null });
    files = fs.readdirSync(tmpRoot).sort();
    assert.strictEqual(files.length, 2, `expected 2 files, got ${files.join(',')}`);
    assert.ok(files.some(f => f.endsWith('.log')),      'log file present');
    assert.ok(files.some(f => f.endsWith('.meta.json')),'meta file present');
    const logFile = files.find(f => f.endsWith('.log'));
    const content = fs.readFileSync(path.join(tmpRoot, logFile), 'utf8');
    assert.strictEqual(content, 'fake boot log contents\n');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── Summary ────────────────────────────────────────────────────────

_run().then(() => {
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
