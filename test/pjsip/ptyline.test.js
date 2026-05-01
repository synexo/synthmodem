'use strict';

/*
 * test/pjsip/ptyline.test.js
 *
 * Unit tests for PjsipBackend._onPtyText and the unterminated-result-code
 * recovery path. These exercise the line-assembly logic directly,
 * without needing a VM — so they run instantly and cover the specific
 * edge case that caused the 140-second CONNECT delay in production:
 *
 *   1. slmodemd writes "CONNECT" to its PTY
 *   2. modemd-ctrl reads those 7 bytes, wire-writes as AT_RESPONSE,
 *      flips data_mode=true on seeing "CONNECT" in pty_tail
 *   3. slmodemd writes "\r\n" to PTY
 *   4. modemd-ctrl reads "\r\n" in data_mode, wire-writes as DATA_RX
 *      — so Node never sees the terminator as AT_RESPONSE
 *   5. Node's _onPtyText has "CONNECT" in _ptyLineBuf with no \r\n,
 *      line regex never matches, 'connected' event never fires.
 *
 * The defensive flush triggers after 150ms quiescence when the
 * buffer's trimmed content matches a known result code, emitting the
 * line as if a terminator had arrived.
 */

const assert = require('assert');
const { PjsipBackend } = require('../../src/backends/PjsipBackend');

let tests = 0, failures = 0;
async function test(name, fn) {
  tests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    if (e.stack) {
      console.log(e.stack.split('\n').slice(1, 4).map(l => `    ${l}`).join('\n'));
    }
  }
}

/* Construct a minimal PjsipBackend without starting any VM. The
 * constructor requires kernelPath/initrdPath to exist on disk, so we
 * point at readme files which always exist. */
const path = require('path');
const REPO = path.resolve(__dirname, '../..');
function makeBackend() {
  return new PjsipBackend({
    qemuPath:   '/bin/true',
    kernelPath: path.join(REPO, 'package.json'),
    initrdPath: path.join(REPO, 'package.json'),
  });
}

(async () => {
  console.log('PjsipBackend._onPtyText — unterminated result code recovery\n');

  await test('terminated CONNECT with \\r\\n fires immediately (baseline)', async () => {
    const b = makeBackend();
    let connected = false;
    b.on('connected', () => { connected = true; });
    b._onPtyText('CONNECT\r\n');
    assert.strictEqual(connected, true, 'connected event should fire synchronously');
    assert.strictEqual(b._ptyLineBuf, '');
    assert.strictEqual(b._ptyUnterminatedTimer, null,
      'no debounce timer should be armed when terminator was present');
  });

  await test('bare "CONNECT" without terminator fires after 150ms debounce', async () => {
    const b = makeBackend();
    let connected = false;
    let bps = null;
    b.on('connected', (info) => { connected = true; bps = info.bps; });

    b._onPtyText('CONNECT');   /* no \r\n — the bug trigger */
    assert.strictEqual(connected, false, 'should NOT fire synchronously');
    assert.notStrictEqual(b._ptyUnterminatedTimer, null, 'debounce timer armed');

    /* Wait past the 150ms debounce. */
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(connected, true, 'should fire after debounce elapses');
    assert.strictEqual(bps, 0, 'bps defaults to 0 for bare CONNECT');
    assert.strictEqual(b._ptyLineBuf, '', 'buffer consumed after flush');
  });

  await test('bare "CONNECT 4800" without terminator fires with rate', async () => {
    const b = makeBackend();
    let bps = null;
    b.on('connected', (info) => { bps = info.bps; });
    b._onPtyText('CONNECT 4800');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(bps, 4800);
  });

  await test('bare "NO CARRIER" without terminator fires silenceHangup', async () => {
    const b = makeBackend();
    /* NO CARRIER → silenceHangup requires backend to have been
     * _connected first (the code de-dups redundant hangups). Set
     * state manually. */
    b._connected = true;
    let hungup = false;
    b.on('silenceHangup', () => { hungup = true; });
    b._onPtyText('NO CARRIER');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(hungup, true);
  });

  await test('random non-result text does NOT arm debounce', async () => {
    const b = makeBackend();
    b._onPtyText('some random slmodemd diagnostic text');
    assert.strictEqual(b._ptyUnterminatedTimer, null,
      'no debounce for text that does not parse as a result code');
    /* Buffer still contains the text (waiting for terminator). */
    assert.strictEqual(b._ptyLineBuf, 'some random slmodemd diagnostic text');
  });

  await test('arrival of \\r\\n cancels a pending debounce (terminator won the race)', async () => {
    const b = makeBackend();
    let connectCount = 0;
    b.on('connected', () => { connectCount++; });

    b._onPtyText('CONNECT');      /* arms timer */
    assert.notStrictEqual(b._ptyUnterminatedTimer, null);

    b._onPtyText('\r\n');          /* terminated path fires, buffer cleared */
    assert.strictEqual(connectCount, 1, 'fired exactly once via terminator');
    assert.strictEqual(b._ptyLineBuf, '');
    assert.strictEqual(b._ptyUnterminatedTimer, null,
      'debounce should have been cancelled once buffer was emptied');

    /* Wait past the old debounce window to confirm no duplicate fire. */
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(connectCount, 1, 'no duplicate connected event');
  });

  await test('multiple small chunks that eventually form CONNECT\\r\\n still fire once', async () => {
    const b = makeBackend();
    let connectCount = 0;
    b.on('connected', () => { connectCount++; });

    b._onPtyText('CON');
    b._onPtyText('NE');
    b._onPtyText('CT');
    b._onPtyText('\r\n');
    assert.strictEqual(connectCount, 1);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(connectCount, 1, 'still exactly one');
  });

  await test('CONNECT, then more partial chunks before \\r\\n, still fire once', async () => {
    /* Simulates: wire frame 1 = "CONN", wire frame 2 = "ECT", wire
     * frame 3 = "\r\n". Each _onPtyText call re-evaluates the debounce
     * and the final terminator path wins. */
    const b = makeBackend();
    let connectCount = 0;
    b.on('connected', () => { connectCount++; });

    b._onPtyText('CONN');
    b._onPtyText('ECT');     /* now buffer = "CONNECT", debounce arms */
    assert.notStrictEqual(b._ptyUnterminatedTimer, null);
    b._onPtyText('\r\n');     /* terminator fires, buffer cleared, debounce cancelled */
    assert.strictEqual(connectCount, 1);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(connectCount, 1);
  });

  await test('the production failure mode: CONNECT in one call, never-terminated', async () => {
    /* This is the exact sequence observed in the broken production
     * log. Without the fix, connected would never fire. */
    const b = makeBackend();
    let connected = false;
    b.on('connected', () => { connected = true; });

    /* Node receives AT_RESPONSE frame with payload "CONNECT" (no
     * terminator — modemd-ctrl read 7 bytes from PTY and flipped
     * data_mode before the trailing \r\n arrived). */
    b._onPtyText('CONNECT');

    /* Without the defensive debounce, we would wait forever for a
     * terminator. With it, we fire 150ms later. */
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(connected, false, 'not yet fired at 50ms');

    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(connected, true, 'fired after debounce');
  });

  await test('debounce does not fire duplicate if CONNECT comes then \\r\\n within debounce window', async () => {
    const b = makeBackend();
    let connectCount = 0;
    b.on('connected', () => { connectCount++; });

    b._onPtyText('CONNECT');
    await new Promise(r => setTimeout(r, 50));   /* still within 150ms */
    b._onPtyText('\r\n');                         /* terminator path fires */
    await new Promise(r => setTimeout(r, 200));   /* past original debounce */
    assert.strictEqual(connectCount, 1, 'exactly one event, not two');
  });

  /* ─── MODEM_STATUS frame handling (forward-compat) ───────────────
   * modemd-ctrl today does not emit MODEM_STATUS frames, but a
   * planned rebuild will. These tests lock in the handler shape so
   * the next binary can drive it without code changes. */

  /* Helper: route a MODEM_STATUS payload through _onCtrlFrame as the
   * binary wire path would. */
  const wire = require('../../vm/qemu-runner/wire');
  function feedStatus(backend, obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    backend._onCtrlFrame({ type: wire.TYPE.MODEM_STATUS, payload });
  }

  await test('MODEM_STATUS {event:"connect", rate:N} fires connected with rate', async () => {
    const b = makeBackend();
    let fired = null;
    b.on('connected', info => { fired = info; });
    feedStatus(b, { event: 'connect', rate: 33600 });
    assert.ok(fired, 'connected should fire');
    assert.strictEqual(fired.bps, 33600);
    assert.strictEqual(fired.protocol, 'V34');
  });

  await test('MODEM_STATUS connect after PTY "CONNECT" fills rate without re-emit', async () => {
    /* Simulates the production sequence with a future VM rebuild:
     *   1. PTY text fragment "CONNECT" (no rate) arrives as AT_RESPONSE
     *   2. Defensive flush (150ms) fires 'connected' with bps=0
     *   3. MODEM_STATUS frame arrives later with the real rate
     * We want: exactly ONE 'connected' event (de-dup), but _currentBps
     * updated with the real rate from the status frame. */
    const b = makeBackend();
    let events = [];
    b.on('connected', info => { events.push(info); });

    b._onPtyText('CONNECT');
    await new Promise(r => setTimeout(r, 200));   /* defensive flush */
    assert.strictEqual(events.length, 1, 'first fire via flush');
    assert.strictEqual(events[0].bps, 0, 'flush had no rate');

    feedStatus(b, { event: 'connect', rate: 21600 });
    assert.strictEqual(events.length, 1, 'no duplicate connected event');
    assert.strictEqual(b._currentBps, 21600, 'rate backfilled');
  });

  await test('MODEM_STATUS ignored when already connected with a rate', async () => {
    /* If PTY text "CONNECT 33600" already fired with a rate, a late
     * status frame should NOT overwrite or re-emit. */
    const b = makeBackend();
    let events = [];
    b.on('connected', info => { events.push(info); });
    b._onPtyText('CONNECT 33600\r\n');             /* full line, no defensive flush needed */
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].bps, 33600);
    feedStatus(b, { event: 'connect', rate: 9999 });
    assert.strictEqual(events.length, 1, 'no duplicate');
    assert.strictEqual(b._currentBps, 33600, 'rate not overwritten');
  });

  await test('MODEM_STATUS malformed JSON is silently dropped (no crash)', async () => {
    const b = makeBackend();
    /* A malformed payload used to crash when assumed to be JSON.
     * We accept anything and simply log-and-drop. */
    const bad = Buffer.from('not-json{{{', 'utf8');
    /* Must not throw. */
    b._onCtrlFrame({ type: wire.TYPE.MODEM_STATUS, payload: bad });
    assert.strictEqual(b._connected, false, 'no state change on bad payload');
  });

  console.log(`\n${tests - failures} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
