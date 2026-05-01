'use strict';

/*
 * test/rtp/fixed-buffered.test.js — unit tests for RtpSession's
 * 'fixed-buffered' playout mode.
 *
 * This mode mirrors the D-Modem/PJSIP approach:
 *   - pre-buffer N packets before starting playout
 *   - on tick miss: WAIT (don't emit silence) up to a cap
 *   - on cap hit: advance to next available seq (rare, lossy-net recovery)
 *   - on buffer overflow: drop oldest
 *
 * Tests drive RtpSession through its internal _onPacket and _playoutTick
 * methods directly, avoiding real UDP sockets and real setInterval timing.
 * The session never has `open()` called, so no socket is bound; we also
 * set _running=true manually so _playoutTick doesn't early-return.
 *
 * Run:  node test/rtp/fixed-buffered.test.js
 */

const assert = require('assert');
const { RtpSession } = require('../../src/rtp/RtpSession');
const config     = require('../../config');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

// Tiny RTP-packet builder. Produces a minimal 12-byte RTP header plus
// payload. Payload here can be any bytes — these tests don't exercise
// real audio decoding (PT=127 isn't in preferredCodecs so _deliverAudio
// will warn-and-continue, which is fine; the test just checks event
// emission counts and ordering).
function rtpPacket(seq, timestamp, payload = Buffer.from([0, 0, 0, 0])) {
  const pkt = Buffer.alloc(12 + payload.length);
  pkt[0]  = 0x80;              // V=2, P=0, X=0, CC=0
  pkt[1]  = 0x00;              // M=0, PT=0 (PCMU — valid, so it decodes)
  pkt.writeUInt16BE(seq, 2);
  pkt.writeUInt32BE(timestamp, 4);
  pkt.writeUInt32BE(0xdeadbeef, 8); // SSRC
  payload.copy(pkt, 12);
  return pkt;
}

// Build a session in test-mode: no open() call → no socket. We also
// never start the real timer; all ticks are manual.
function makeSession(mode = 'fixed-buffered') {
  const s = new RtpSession({ playoutMode: mode });
  s._running = true; // pretend open() succeeded
  return s;
}

// Collect emitted audio events into an array. Each entry is either
// a decoded Float32Array (real payload) or a concealment silence frame
// (also a Float32Array, always zeros and 160 samples long).
function captureEmits(session) {
  const emits = [];
  session.on('audio', samples => emits.push(samples));
  return emits;
}

// Convenience: stuff a PCMU 160-byte payload into a packet. These bytes
// won't decode to zeros, so we can distinguish them from concealment.
const NONZERO_PCMU = Buffer.alloc(160, 0x55); // 0x55 is a non-silent u-law code

// ─── Constructor validation ────────────────────────────────────────────────

test('constructor: rejects unknown playoutMode', () => {
  assert.throws(() => new RtpSession({ playoutMode: 'bogus' }), TypeError);
});

test('constructor: accepts fixed-buffered', () => {
  const s = new RtpSession({ playoutMode: 'fixed-buffered' });
  assert.strictEqual(s._playoutMode, 'fixed-buffered');
});

test('constructor: accepts buffered and immediate', () => {
  assert.doesNotThrow(() => new RtpSession({ playoutMode: 'buffered' }));
  assert.doesNotThrow(() => new RtpSession({ playoutMode: 'immediate' }));
});

// ─── Pre-buffer behavior ───────────────────────────────────────────────────

test('fixed-buffered: does NOT start playout until init depth reached', () => {
  const s = makeSession('fixed-buffered');
  captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  // Feed initDepth - 1 packets.
  for (let i = 0; i < initDepth - 1; i++) {
    s._onPacket(rtpPacket(100 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  // Timer must not have started yet.
  assert.strictEqual(s._jitterTimer, null);
  // No playout pointer yet.
  assert.strictEqual(s._nextPlaySeq, null);
  // Buffer holds them all.
  assert.strictEqual(s._jitterBuf.size, initDepth - 1);

  // Clean up any timer that may have been set (defensive).
  s.close();
});

test('fixed-buffered: starts playout on exactly initDepth packets', () => {
  const s = makeSession('fixed-buffered');
  captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  for (let i = 0; i < initDepth; i++) {
    s._onPacket(rtpPacket(100 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  assert.ok(s._jitterTimer !== null, 'timer should have started');
  assert.strictEqual(s._nextPlaySeq, 100, 'should start at earliest seq held');
  // Stop the real timer so it doesn't fire during tests.
  s.close();
});

test('fixed-buffered: picks EARLIEST seq when buffer fills (out-of-order arrival)', () => {
  const s = makeSession('fixed-buffered');
  captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  // Arrive in reverse seq order so "last seen" != "earliest seq"
  for (let i = initDepth - 1; i >= 0; i--) {
    s._onPacket(rtpPacket(200 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  // _nextPlaySeq must be 200 (the lowest), not the seq of the last packet received.
  assert.strictEqual(s._nextPlaySeq, 200);
  s.close();
});

// ─── Drain behavior ────────────────────────────────────────────────────────

test('fixed-buffered: ticks drain the pre-buffered queue one packet at a time', () => {
  const s = makeSession('fixed-buffered');
  const emits = captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  for (let i = 0; i < initDepth; i++) {
    s._onPacket(rtpPacket(500 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  // Cancel the real timer; drive ticks manually.
  if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }

  // Should emit exactly initDepth audio events in order.
  for (let i = 0; i < initDepth; i++) {
    s._playoutTick();
  }
  assert.strictEqual(emits.length, initDepth);
  // After draining, buffer should be empty and next-seq advanced.
  assert.strictEqual(s._jitterBuf.size, 0);
  assert.strictEqual(s._nextPlaySeq, (500 + initDepth) & 0xffff);
  s.close();
});

// ─── No-concealment behavior (the critical modem fix) ──────────────────────

test('fixed-buffered: tick with MISSING packet emits NOTHING (not silence)', () => {
  const s = makeSession('fixed-buffered');
  const emits = captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  // Feed packets 0..initDepth-1, but skip seq=5 (gap in sequence).
  for (let i = 0; i < initDepth + 1; i++) {
    if (i === 5) continue;
    s._onPacket(rtpPacket(1000 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  // initDepth unique packets now buffered (skipped 5, added 0..initDepth inclusive sans 5).
  // That's initDepth packets total.
  if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }

  // Drain up to before the gap.
  for (let i = 0; i < 5; i++) s._playoutTick();
  assert.strictEqual(emits.length, 5);

  // Now tick with seq=1005 missing. Under 'buffered' mode this would
  // have emitted a silence frame. Under 'fixed-buffered' it must emit
  // NOTHING — the tick is skipped, we wait for the packet.
  s._playoutTick();
  assert.strictEqual(emits.length, 5, 'no concealment emit — just wait');
  // Silence miss counter incremented.
  assert.strictEqual(s._silenceCount, 1);
  // Next-play pointer did NOT advance (still expecting 1005).
  assert.strictEqual(s._nextPlaySeq, 1005);
  s.close();
});

test('fixed-buffered: missing packet arrives late → is played when it shows up', () => {
  const s = makeSession('fixed-buffered');
  const emits = captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  for (let i = 0; i < initDepth + 1; i++) {
    if (i === 5) continue;
    s._onPacket(rtpPacket(2000 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }

  // Drain up to the gap.
  for (let i = 0; i < 5; i++) s._playoutTick();
  assert.strictEqual(emits.length, 5);

  // Miss a few ticks.
  s._playoutTick();
  s._playoutTick();
  s._playoutTick();
  assert.strictEqual(emits.length, 5, 'no emits during wait');
  assert.strictEqual(s._silenceCount, 3);

  // The late packet arrives.
  s._onPacket(rtpPacket(2005, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });

  // Next tick: should emit it and reset miss counter.
  s._playoutTick();
  assert.strictEqual(emits.length, 6);
  assert.strictEqual(s._silenceCount, 0);
  assert.strictEqual(s._nextPlaySeq, 2006);
  s.close();
});

// ─── Give-up-after-threshold recovery ──────────────────────────────────────

test('fixed-buffered: after missSkipTicks with no arrival, jumps to next available', () => {
  const s = makeSession('fixed-buffered');
  const emits = captureEmits(s);

  const initDepth = config.rtp.jitterBufferInitDepth;
  const missCap = config.rtp.jitterBufferMissSkipTicks;
  for (let i = 0; i < initDepth + 1; i++) {
    if (i === 5) continue;
    s._onPacket(rtpPacket(3000 + i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }

  // Drain up to the gap.
  for (let i = 0; i < 5; i++) s._playoutTick();
  const before = emits.length;

  // Tick missCap times with nothing arriving for seq=3005. On the
  // missCap-th tick, we should skip and jump to seq=3006.
  for (let i = 0; i < missCap; i++) s._playoutTick();

  // We were at 3005, now expected to be at 3006 or later.
  assert.ok(s._nextPlaySeq !== 3005, 'should have jumped past lost seq');
  assert.strictEqual(s._nextPlaySeq, 3006);
  assert.strictEqual(s._silenceCount, 0);
  // No audio emits during all the missed ticks.
  assert.strictEqual(emits.length, before);
  s.close();
});

// ─── Overflow behavior ─────────────────────────────────────────────────────

test('fixed-buffered: buffer never exceeds jitterBufferMaxDepth', () => {
  const s = makeSession('fixed-buffered');
  captureEmits(s);

  const maxDepth = config.rtp.jitterBufferMaxDepth;
  // Stuff way more than max. With initDepth much smaller than maxDepth,
  // the timer WILL start and have a live setInterval. Kill it so we
  // don't drain during the test.
  let seq = 0;
  for (let i = 0; i < maxDepth * 2; i++) {
    s._onPacket(rtpPacket(seq++, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
    if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }
  }
  assert.ok(s._jitterBuf.size <= maxDepth + 1,
    `buffer should be capped around ${maxDepth}, got ${s._jitterBuf.size}`);
  s.close();
});

// ─── Mode-isolation sanity ─────────────────────────────────────────────────

test('immediate mode: emits on every arrival with no buffering', () => {
  const s = makeSession('immediate');
  const emits = captureEmits(s);
  for (let i = 0; i < 10; i++) {
    s._onPacket(rtpPacket(i, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  }
  assert.strictEqual(emits.length, 10);
  // No timer in immediate mode.
  assert.strictEqual(s._jitterTimer, null);
  s.close();
});

test('buffered mode: still emits concealment silence on miss (legacy)', () => {
  const s = makeSession('buffered');
  const emits = captureEmits(s);
  // Send 1 packet so _nextPlaySeq gets set.
  s._onPacket(rtpPacket(0, 0, NONZERO_PCMU), { address: '1.2.3.4', port: 5000 });
  if (s._jitterTimer) { clearInterval(s._jitterTimer); s._jitterTimer = null; }
  // First tick drains the packet.
  s._playoutTick();
  assert.strictEqual(emits.length, 1);
  // Second tick: seq=1 is missing → legacy mode emits silence.
  s._playoutTick();
  assert.strictEqual(emits.length, 2);
  // The silence emit is a zero-filled Float32Array of the configured size.
  const silenceFrame = emits[1];
  assert.ok(silenceFrame instanceof Float32Array);
  assert.ok(silenceFrame.every(v => v === 0), 'silence frame should be all zeros');
  s.close();
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
