'use strict';

// V.22 native modulator → demodulator self-loopback
// =====================================================================
// Validates the V.22 receive pipeline as a faithful port of spandsp's
// v22bis_rx.c (phase 5, April 2026).
//
// History:
//
//   Phases 1-4 (now folded into history) iteratively patched bugs found
//   on real-wire captures: UART stop-bit resync (phase 1), carrier-
//   presence gate (phase 2), Gardner timing (phase 3), and various TX
//   amplitude / Te silence / lock-gate experiments (phase 4). All were
//   empirical band-aids over a demodulator architecture that didn't
//   match the protocol's expected RX pipeline.
//
//   Phase 5 replaces the demodulator entirely with a port of spandsp's
//   v22bis_rx.c: the same five-stage RX training state machine, the
//   same one-shot AGC at SYMBOL_ACQUISITION, the same Costas-style
//   carrier tracking, the same complex T/2 LMS equalizer, the same
//   bandpass-RRC filter (27 taps × 12 phase positions), and the same
//   constants. The two phase-1/2 wins that don't have spandsp analogues
//   are kept: UART stop-bit resync (spandsp doesn't have a UART layer)
//   and the byte-emission gate keyed off signal_present + training
//   state.
//
//   Self-loopback now requires a longer warmup than before because the
//   demodulator goes through the full training state machine before
//   emitting bits — about 1.34 seconds for the answerer path. We use 2
//   seconds in tests to give margin.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  QAMModulator,
} = require('../../src/dsp/protocols/V22');
const {
  QAMDemodulator,
  RX_TRAINING,
} = require('../../src/dsp/protocols/V22Demodulator');

const SR = 8000;

// ─── Helper: end-to-end self-loopback with proper warmup ──────────────────

function loopbackBytes(carrier, bytes, opts = {}) {
  const { warmupSec = 2.0 } = opts;
  const mod = new QAMModulator({
    carrier,
    bitsPerSymbol: 2,
    guardTone: false,
  });
  const demod = new QAMDemodulator({ carrier, bitsPerSymbol: 2 });

  const received = [];
  demod.on('data', buf => {
    for (const b of buf) received.push(b);
  });

  // Warmup: run idle (mod's default empty-queue behavior emits scrambled
  // marking) long enough for the demod to traverse SYMBOL_ACQUISITION,
  // SCRAMBLED_ONES_AT_1200, and SCRAMBLED_ONES_AT_1200_SUSTAINING (about
  // 33 + 270 + 1035 = 1338 ms) and reach NORMAL_OPERATION.
  let pulled = 0;
  const warmupSamples = Math.floor(SR * warmupSec);
  while (pulled < warmupSamples) {
    const audio = mod.generate(160);
    demod.process(audio);
    pulled += 160;
  }
  // Discard anything that came out during warmup (should be 0 — the
  // training-stage gate keeps bytes from flowing pre-NORMAL).
  received.length = 0;

  mod.write(Buffer.from(bytes));

  const totalSamples = SR * (warmupSec + 4);
  while (pulled < totalSamples) {
    const chunkSize = Math.min(160, totalSamples - pulled);
    const audio = mod.generate(chunkSize);
    demod.process(audio);
    pulled += chunkSize;
  }

  return received;
}

// ─── Self-loopback round-trips ────────────────────────────────────────────

test('V.22 self-loopback: short ASCII string round-trips', () => {
  const sent = Buffer.from('Hello, V.22!');
  const got  = loopbackBytes(1200, sent);
  const recvStr = Buffer.from(got).toString('latin1');
  assert.ok(recvStr.includes(sent.toString('latin1')),
    `expected to contain "${sent.toString('latin1')}", got "${recvStr}"`);
});

test('V.22 self-loopback: 32-byte payload round-trips', () => {
  const sent = [];
  for (let i = 0; i < 32; i++) sent.push(0x41 + (i % 26));
  const got = loopbackBytes(1200, sent);
  const recvStr = Buffer.from(got).toString('latin1');
  assert.ok(recvStr.includes(Buffer.from(sent).toString('latin1')));
});

test('V.22 self-loopback at 2400 Hz answer carrier', () => {
  const sent = Buffer.from('answer');
  const got  = loopbackBytes(2400, sent);
  const recvStr = Buffer.from(got).toString('latin1');
  assert.ok(recvStr.includes(sent.toString('latin1')));
});

// ─── Constructor & default-state behavior ─────────────────────────────────

test('QAMDemodulator default: carrier gate ON, signal absent at start', () => {
  const d = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  assert.equal(d._enableCarrierGate, true, 'carrier gate should default to enabled');
  assert.equal(d.signalPresent, false, 'signal should start absent');
  assert.equal(d.gatedBytes, 0, 'gatedBytes counter should start at 0');
  assert.equal(d.trainingStage, RX_TRAINING.SYMBOL_ACQUISITION,
    'training should start in SYMBOL_ACQUISITION');
});

test('QAMDemodulator constructor: carrier gate can be disabled', () => {
  const d = new QAMDemodulator({
    carrier: 1200, bitsPerSymbol: 2, enableCarrierGate: false,
  });
  assert.equal(d._enableCarrierGate, false, 'gate should be disabled');
});

test('QAMDemodulator constructor: rejects invalid carrier', () => {
  assert.throws(
    () => new QAMDemodulator({ carrier: 1700, bitsPerSymbol: 2 }),
    /Invalid V\.22 carrier/);
});

// ─── Carrier gate ─────────────────────────────────────────────────────────

test('Carrier gate suppresses bytes during silence', () => {
  // Pure-silence input must produce no `data` events. The training
  // stage stays in SYMBOL_ACQUISITION since the power-meter cutoff is
  // never crossed. signal_present stays false.
  const d = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  let dataEvents = 0;
  d.on('data', () => { dataEvents++; });
  for (let i = 0; i < (5 * SR) / 160; i++) {
    d.process(new Float32Array(160));
  }
  assert.equal(dataEvents, 0,
    `expected 0 data events during silence, got ${dataEvents}`);
  assert.equal(d.signalPresent, false, 'signal should still be absent at end');
  assert.equal(d.trainingStage, RX_TRAINING.SYMBOL_ACQUISITION,
    'training stage should remain SYMBOL_ACQUISITION during silence');
});

// ─── Stability checks ────────────────────────────────────────────────────

test('Process accepts empty input', () => {
  const d = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  d.process(new Float32Array(0));
  d.process(null);
});

test('Process accepts 160-sample (RTP-sized) chunks', () => {
  const d = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  for (let i = 0; i < 50; i++) {
    d.process(new Float32Array(160));
  }
});

// ─── Carrier-edge events ─────────────────────────────────────────────────

test('Carrier-edge events arrive at debug sink', () => {
  // Drive with a 1200 Hz tone burst that crosses the carrier-on threshold,
  // then stops to cross the carrier-off threshold. The sink should see
  // corresponding 'carrier_edge' events (and 'carrierUp'/'carrierDown'
  // emitter events).
  const events = [];
  const d = new QAMDemodulator({
    carrier: 1200, bitsPerSymbol: 2,
    debugSink: e => { if (e.type === 'carrier_edge') events.push(e); },
  });
  // 1 second of strong 1200 Hz tone — power above carrier_on_power.
  const tone = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    tone[i] = 0.3 * Math.cos(2 * Math.PI * 1200 * i / SR);
  }
  d.process(tone);
  // Then 1 second of silence → carrier-down.
  d.process(new Float32Array(SR));
  const ups   = events.filter(e => e.edge === 'up').length;
  const downs = events.filter(e => e.edge === 'down').length;
  assert.ok(ups   >= 1, `expected ≥ 1 up edge, got ${ups}`);
  assert.ok(downs >= 1, `expected ≥ 1 down edge, got ${downs}`);
});

test('Diagnostic sink: receives symbol events with expected fields', () => {
  // Drive with a real V.22 modulator so we get past the power threshold
  // and produce symbol events from the demodulator.
  const events = [];
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d = new QAMDemodulator({
    carrier: 1200, bitsPerSymbol: 2,
    debugSink: e => events.push(e),
  });
  // 0.5 seconds of modulated audio — enough symbols (~300) to verify.
  let pulled = 0;
  while (pulled < SR * 0.5) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  const syms = events.filter(e => e.type === 'symbol');
  assert.ok(syms.length > 100, `expected > 100 symbol events, got ${syms.length}`);
  for (const k of ['type', 't', 'I', 'Q', 'nearest', 'training']) {
    assert.ok(k in syms[0], `event should have field "${k}"`);
  }
  assert.equal(syms[0].type, 'symbol');
});

// ─── Training state machine ──────────────────────────────────────────────

test('Training state machine: reaches NORMAL_OPERATION on continuous valid input', () => {
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d   = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  // Drive 2 seconds of idle — well past the answerer's training budget
  // (33 + 270 + 1035 = 1338 ms).
  let pulled = 0;
  while (pulled < SR * 2) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  assert.equal(d.trainingStage, RX_TRAINING.NORMAL_OPERATION,
    `expected NORMAL_OPERATION after 2s of valid signal, got stage ${d.trainingStage}`);
  assert.equal(d.signalPresent, true, 'signal should be present');
});

test('Training state machine: returns to SYMBOL_ACQUISITION on signal loss', () => {
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d   = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  // Train up to NORMAL_OPERATION
  let pulled = 0;
  while (pulled < SR * 2) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  assert.equal(d.trainingStage, RX_TRAINING.NORMAL_OPERATION);
  // Drop signal — 1 second of silence
  d.process(new Float32Array(SR));
  assert.equal(d.signalPresent, false, 'signal should drop');
  assert.equal(d.trainingStage, RX_TRAINING.SYMBOL_ACQUISITION,
    `should reset to SYMBOL_ACQUISITION on carrier-down, got ${d.trainingStage}`);
});

test('Training state machine: bytes are gated until NORMAL_OPERATION', () => {
  // Send real data immediately, with no warmup. The demod should be in
  // training stages for ~1.3s before emitting any bytes.
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d   = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  const earlyReceived = [];
  d.on('data', buf => { for (const b of buf) earlyReceived.push(b); });

  // Write data immediately (will be transmitted during training)
  mod.write(Buffer.from('TOOEARLY'));
  // Run only 1 second (< 1.34s training)
  let pulled = 0;
  while (pulled < SR * 1.0) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  assert.equal(earlyReceived.length, 0,
    `bytes should be gated during training; got ${earlyReceived.length}`);
  assert.notEqual(d.trainingStage, RX_TRAINING.NORMAL_OPERATION,
    'should still be in training');
});

// ─── symbolMag (carrier-magnitude estimate for protocol-layer detection)──

test('symbolMag: starts at 0, rises with valid signal', () => {
  // Regression test for the V22 protocol module's handshake-time carrier
  // detection. The protocol module reads `demodulator.symbolMag` against
  // a 0.02 threshold; if symbolMag returns undefined or stays near 0
  // when valid signal is present, V22 handshake fails with "no remote
  // carrier detected". This test ensures both the value is exposed and
  // the threshold convention (~0.02 floor for signal-present, ~0.05+
  // for real V.22 signal) is honoured.
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d   = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  assert.equal(d.symbolMag, 0, 'symbolMag should start at 0');
  // Drive 0.5 s of valid V.22 idle — symbolMag should be well above
  // the 0.02 threshold by then.
  let pulled = 0;
  while (pulled < SR * 0.5) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  assert.ok(d.symbolMag > 0.02,
    `symbolMag should rise above 0.02 with valid signal; got ${d.symbolMag.toFixed(4)}`);
});

test('symbolMag: tracks input independent of carrier-presence gate', () => {
  // After a transient carrier drop, symbolMag should NOT reset to 0 —
  // it tracks the smoothed input-signal magnitude, which is the right
  // signal for the V22 protocol layer's handshake detection. (The gate
  // does flap during early acquisition in some environments because of
  // 1800 Hz guard-tone leakage; symbolMag stays meaningful through it.)
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  const d   = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });
  let pulled = 0;
  while (pulled < SR * 1.0) {
    d.process(mod.generate(160));
    pulled += 160;
  }
  const magBefore = d.symbolMag;
  // Force a carrier-down by feeding silence briefly
  d.process(new Float32Array(160));   // 20ms of silence — may or may not trigger gate
  // Resume valid signal — symbolMag should not have collapsed to 0
  d.process(mod.generate(160));
  assert.ok(d.symbolMag > 0.01,
    `symbolMag should not collapse on transient drops; got ${d.symbolMag.toFixed(4)} (was ${magBefore.toFixed(4)})`);
});
