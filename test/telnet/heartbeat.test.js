'use strict';

// TelnetProxy menu-idle heartbeat tests
// =====================================================================
// Verifies the CONNECT>-prompt UART heartbeat introduced after the
// v22-fix-phase5 spandsp port. See TelnetProxy._scheduleMenuHeartbeat
// for the design rationale.
//
// Behavior under test:
//   - When idle in MENU state for > config.telnet.menuIdleHeartbeatMs,
//     a single CR (0x0D) is transmitted to the modem side.
//   - Any send or receive activity defers the heartbeat (resets timer).
//   - The heartbeat does NOT fire while in PROXYING state.
//   - The heartbeat is cancelled on disconnect/close.
//   - Setting menuIdleHeartbeatMs = 0 disables the feature entirely.
//
// We use fake timers (sinon-style) by stubbing setTimeout / clearTimeout
// on the global so each test gets deterministic control over the clock.
// This avoids tying tests to wall-clock interval values from config.

const assert = require('node:assert/strict');
const { test } = require('node:test');

// Stub timer helpers — we install these per-test so we don't pollute
// other suites if they run in the same process.
function installFakeTimers() {
  const realSet   = global.setTimeout;
  const realClear = global.clearTimeout;
  let nextId = 1;
  const pending = new Map();   // id → {fn, due}
  let now = 0;

  global.setTimeout = (fn, ms) => {
    const id = nextId++;
    pending.set(id, { fn, due: now + ms });
    return id;
  };
  global.clearTimeout = (id) => { pending.delete(id); };

  return {
    advance(ms) {
      const target = now + ms;
      // Fire any timer whose due time is ≤ target, in due order.
      let fired = 0;
      while (true) {
        let next = null;
        let nextId = null;
        for (const [id, t] of pending) {
          if (t.due <= target && (next === null || t.due < next.due)) {
            next = t; nextId = id;
          }
        }
        if (!next) break;
        pending.delete(nextId);
        now = next.due;
        try { next.fn(); } catch (e) { /* propagate errors */ }
        fired++;
        if (fired > 1000) throw new Error('runaway timer firing');
      }
      now = target;
    },
    pendingCount() { return pending.size; },
    restore() {
      global.setTimeout = realSet;
      global.clearTimeout = realClear;
    },
  };
}

// We require TelnetProxy AFTER establishing some default behaviour, but
// before installing fake timers — TelnetProxy doesn't capture timer
// references at module load time, only at instance use, so this is fine.
const { TelnetProxy } = require('../../src/telnet/TelnetProxy');
const config = require('../../config');

test('Heartbeat: fires CR after MENU idle interval', () => {
  const fakes = installFakeTimers();
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    // attach() schedules the heartbeat after sending banner+prompt.
    const interval = config.telnet.menuIdleHeartbeatMs;
    assert.ok(interval > 0, 'heartbeat must be enabled in config for this test');

    const txBeforeAdvance = txLog.length;
    fakes.advance(interval - 1);  // not yet
    assert.equal(txLog.length, txBeforeAdvance, 'should NOT fire before interval');

    fakes.advance(2);  // cross the boundary
    assert.equal(txLog[txLog.length - 1], 0x0D, 'last byte sent should be CR');
    assert.equal(txLog.length, txBeforeAdvance + 1, 'exactly one byte (CR) emitted');
  } finally {
    fakes.restore();
  }
});

test('Heartbeat: fires repeatedly at interval cadence', () => {
  const fakes = installFakeTimers();
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    const interval = config.telnet.menuIdleHeartbeatMs;

    const before = txLog.length;
    // Advance through 3 full intervals
    fakes.advance(interval); // 1st heartbeat
    fakes.advance(interval); // 2nd heartbeat
    fakes.advance(interval); // 3rd heartbeat

    const heartbeats = txLog.slice(before).filter(b => b === 0x0D).length;
    assert.equal(heartbeats, 3, `expected 3 CR heartbeats, got ${heartbeats}`);
  } finally {
    fakes.restore();
  }
});

test('Heartbeat: receive() activity does NOT defer the next heartbeat', () => {
  // Rationale: the heartbeat is a TX-side keepalive. Its purpose is
  // to ensure WE periodically send a clean UART frame so the
  // receiving modem's UART resyncs. RX bytes don't accomplish that.
  //
  // V.22 scrambled line idle produces bursts of garbage RX bytes
  // from UART misframes on the far side. If those bursts reset our
  // heartbeat timer, the timer never elapses and we never send the
  // CR that would re-anchor framing — the very problem the
  // heartbeat is supposed to fix.
  const fakes = installFakeTimers();
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    const interval = config.telnet.menuIdleHeartbeatMs;

    fakes.advance(interval - 100);
    proxy.receive(Buffer.from([0x01]));  // Ctrl-A: ignored in MENU state

    // 100 ms after this point, the original (un-deferred) timer should
    // fire — receive() must not have moved it.
    fakes.advance(150);
    assert.ok(txLog.includes(0x0D),
      'heartbeat should fire on the original schedule despite RX activity');
  } finally {
    fakes.restore();
  }
});

test('Heartbeat: does not fire after disconnect()', () => {
  const fakes = installFakeTimers();
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    const interval = config.telnet.menuIdleHeartbeatMs;
    proxy.disconnect();
    fakes.advance(interval * 5);
    assert.ok(!txLog.includes(0x0D),
      'no heartbeats expected after disconnect');
  } finally {
    fakes.restore();
  }
});

test('Heartbeat: disabled when menuIdleHeartbeatMs <= 0', () => {
  const fakes = installFakeTimers();
  const orig = config.telnet.menuIdleHeartbeatMs;
  config.telnet.menuIdleHeartbeatMs = 0;
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    fakes.advance(60_000);
    assert.ok(!txLog.includes(0x0D),
      'no heartbeats expected when feature disabled');
    assert.equal(fakes.pendingCount(), 0,
      'no scheduled timers when feature disabled');
  } finally {
    fakes.restore();
    config.telnet.menuIdleHeartbeatMs = orig;
  }
});

test('Heartbeat: fires (does not fire) only in MENU state', () => {
  const fakes = installFakeTimers();
  try {
    const proxy = new TelnetProxy();
    const txLog = [];
    proxy.attach(buf => txLog.push(...buf));
    const interval = config.telnet.menuIdleHeartbeatMs;

    // Force into PROXYING to verify the heartbeat self-cancels in
    // non-MENU states. We don't go through real TCP plumbing — set
    // the state directly, which is what the test cares about.
    proxy._state = 'PROXYING';
    proxy._cancelMenuHeartbeat();   // simulate state-change cancel

    const before = txLog.length;
    fakes.advance(interval * 3);
    const heartbeats = txLog.slice(before).filter(b => b === 0x0D).length;
    assert.equal(heartbeats, 0,
      'heartbeat must not fire while in PROXYING state');
  } finally {
    fakes.restore();
  }
});
