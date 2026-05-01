#!/usr/bin/env node
'use strict';

// Decode RX capture and emit (sample_pos, byte) pairs for analysis.
//
// Usage: node tools/decode-rx-capture-timed.js <rx.wav> [carrier_hz] [skip_seconds] [flags...]
//
// Flags:
//   --pre          Enable BPF + AGC pre-pipeline (default: off, post-phase2).
//                  Pre-phase2 the default was on; v22-fix-phase2 flipped it
//                  after empirical testing showed both were net-negative on
//                  real-wire captures.
//   --no-gate      Disable carrier-presence gate (default: on, post-phase2).
//                  Gate was added in v22-fix-phase2; with --no-gate the
//                  demodulator behaves like phase1 (emits all decoded
//                  bytes including those from line silence/noise).
//   --no-gardner   Disable Gardner timing recovery (default: on, post-phase3).
//                  Gardner was added in v22-fix-phase3 to track sample-rate
//                  drift between calling modem and synthmodem. With
//                  --no-gardner the demod uses fixed sample timing
//                  (phase2 behavior).
//   --gardner-log  Print Gardner kicks (timing corrections) and carrier
//                  edge events as they occur. Useful for visualising
//                  how aggressively Gardner is correcting and when the
//                  gate goes up/down.
//
// Older flag --no-pre is retained as a no-op alias for the default state
// since BPF/AGC are now off-by-default.

const fs = require('fs');
const path = require('path');

const wavPath = process.argv[2];
const carrier = parseInt(process.argv[3] || '1200', 10);
const skipSec = parseFloat(process.argv[4] || '0');
const flags = process.argv.slice(5);
const enablePre     =  flags.includes('--pre');
const enableGate    = !flags.includes('--no-gate');
const enableGardner = !flags.includes('--no-gardner');
const gardnerLog    =  flags.includes('--gardner-log');
if (!wavPath) {
  console.error('usage: node decode-rx-capture-timed.js <rx.wav> [carrier_hz] [skip_seconds] [--pre] [--no-gate] [--no-gardner] [--gardner-log]');
  process.exit(1);
}

const wavBuf = fs.readFileSync(wavPath);
const headerLen = 44;
const sampleCount = (wavBuf.length - headerLen) / 2;
const samples = new Float32Array(sampleCount);
for (let i = 0; i < sampleCount; i++) {
  const lo = wavBuf[headerLen + i*2];
  const hi = wavBuf[headerLen + i*2 + 1];
  let v = (hi << 8) | lo;
  if (v & 0x8000) v -= 0x10000;
  samples[i] = v / 32768.0;
}
const skipSamp = Math.floor(skipSec * 8000);
const startPos = skipSamp;
console.error(`Loaded ${samples.length} samples (${(samples.length/8000).toFixed(2)}s) at ${carrier} Hz carrier; skipping first ${skipSec}s (${skipSamp} samples)`);

const { QAMDemodulator } = require(path.resolve(__dirname, '../src/dsp/protocols/V22.js'));
let kickCount = 0;
// We always observe events for the summary; gardnerLog adds verbose printing.
const debugSink = (e => {
  if (e.type === 'gardner_kick') {
    kickCount++;
    if (gardnerLog) {
      console.error(`  [t=${e.t.toFixed(2)}s] gardner kick #${kickCount}: integrated=${e.integrated.toFixed(0)}, nudged ${e.samplesNudged.toFixed(3)} samples (newSymPhase=${e.newSymPhase.toFixed(3)})`);
    }
  } else if (e.type === 'carrier_edge' && gardnerLog) {
    console.error(`  [t=${e.t.toFixed(2)}s] carrier ${e.edge.toUpperCase()} (mag=${e.mag.toFixed(3)})`);
  }
});
const demod = new QAMDemodulator({
  carrier, bitsPerSymbol: 2,
  enableBpf: enablePre, enableAgc: enablePre,
  enableCarrierGate: enableGate,
  enableGardner: enableGardner,
  debugSink,
});
console.error(`BPF+AGC: ${enablePre ? 'on' : 'off'}, carrier-gate: ${enableGate ? 'on' : 'off'}, Gardner: ${enableGardner ? 'on' : 'off'}${gardnerLog ? ', debug-log: on' : ''}`);
let carrierUps = 0, carrierDowns = 0;
demod.on('carrierUp',   () => { carrierUps++; });
demod.on('carrierDown', () => { carrierDowns++; });

// Track sample position when each byte arrives
let currentSamplePos = startPos;
const events = [];   // {pos_sec, byte}
demod.on('data', buf => {
  const t = currentSamplePos / 8000;
  for (const b of buf) events.push({ t, b });
});

const CHUNK = 160;
for (let pos = startPos; pos < samples.length; pos += CHUNK) {
  currentSamplePos = pos;
  demod.process(samples.subarray(pos, Math.min(pos + CHUNK, samples.length)));
}

// Bucket by 1-second windows. For each second, count printable ASCII bytes,
// telnet-protocol-ish bytes (0xFF + 0xFB-0xFE), idle-pattern bytes (0x11/0x91),
// and "junk" bytes (everything else).
const buckets = {};
for (const { t, b } of events) {
  const sec = Math.floor(t);
  if (!buckets[sec]) buckets[sec] = { printable: 0, telnet: 0, idle: 0, junk: 0, total: 0, sample: [] };
  buckets[sec].total++;
  if (b === 0x11 || b === 0x91) buckets[sec].idle++;
  else if (b >= 0x20 && b < 0x7f) buckets[sec].printable++;
  else if (b === 0xff || (b >= 0xfb && b <= 0xfe)) buckets[sec].telnet++;
  else if (b === 0x0a || b === 0x0d || b === 0x09 || b === 0x07 || b === 0x08) buckets[sec].printable++; // control we expect in BBS
  else buckets[sec].junk++;
  if (buckets[sec].sample.length < 30) buckets[sec].sample.push(b);
}

console.error('');
console.error('Per-second breakdown:');
console.error('  t  | total | print | telnet | idle | junk | sample');
console.error('  ---+-------+-------+--------+------+------+-----------------');
const secs = Object.keys(buckets).map(Number).sort((a,b)=>a-b);
for (const s of secs) {
  const x = buckets[s];
  const sampleStr = x.sample.map(b => {
    if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b);
    return '.';
  }).join('').padEnd(30);
  console.error(`  ${String(s).padStart(2)} | ${String(x.total).padStart(5)} | ${String(x.printable).padStart(5)} | ${String(x.telnet).padStart(6)} | ${String(x.idle).padStart(4)} | ${String(x.junk).padStart(4)} | ${sampleStr}`);
}

// Summary
const totals = secs.reduce((a, s) => {
  a.total += buckets[s].total;
  a.printable += buckets[s].printable;
  a.telnet += buckets[s].telnet;
  a.idle += buckets[s].idle;
  a.junk += buckets[s].junk;
  return a;
}, { total: 0, printable: 0, telnet: 0, idle: 0, junk: 0 });
console.error('');
console.error('Summary:');
console.error(`  ${totals.total} bytes total`);
console.error(`  ${totals.printable} printable (${(100*totals.printable/totals.total).toFixed(1)}%)`);
console.error(`  ${totals.telnet} 'telnet/IAC-shaped' (${(100*totals.telnet/totals.total).toFixed(1)}%)`);
console.error(`  ${totals.idle} V.22 idle pattern (${(100*totals.idle/totals.total).toFixed(1)}%)`);
console.error(`  ${totals.junk} 'junk' (${(100*totals.junk/totals.total).toFixed(1)}%)`);
console.error('');
console.error('Note: the print/junk/telnet breakdown is heuristic — it counts byte');
console.error('  values, not whether the BBS-side terminal would render them as');
console.error('  intended. CP437 box-drawing characters, ANSI escape sequences,');
console.error('  and many other legitimate BBS bytes fall in the "junk" bucket. The');
console.error('  metric is most useful for relative comparisons between configs');
console.error('  on the SAME capture, not for absolute quality claims.');
console.error('');
console.error(`Carrier gate: ${carrierUps} carrierUp events, ${carrierDowns} carrierDown events,`);
console.error(`              ${demod.gatedBytes} bytes suppressed during signal-absent periods,`);
console.error(`              end-state: ${demod.signalPresent ? 'present' : 'absent'}`);
console.error(`Gardner:      ${kickCount} timing-correction kicks during call`);
