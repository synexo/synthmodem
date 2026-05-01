#!/usr/bin/env node
'use strict';

/**
 * analyze-tx-timing.js
 *
 * Read a TX-timing trace file produced by RtpSession with
 * `traceTxTiming: true`, and report per-packet inter-emit jitter
 * statistics. The trace file format is one packet per line:
 *
 *     # elapsed_us\tseq
 *     12345\t34567
 *     32511\t34568
 *     ...
 *
 * Each line is the wall-clock microseconds elapsed since the start of
 * tracing, plus the RTP sequence number assigned by RtpSession.send
 * at the moment of send.
 *
 * The ideal cadence is one packet every packetIntervalMs (20 ms by
 * default), giving inter-packet gaps of exactly 20000 µs. We report
 * how the actual gaps deviate from that.
 *
 * Usage:
 *   node tools/analyze-tx-timing.js <trace_file>
 *   node tools/analyze-tx-timing.js <trace_file> --window=20s
 *
 * The optional --window flag restricts analysis to packets within the
 * given time window (e.g. only the long-idle period after the banner).
 * Format: <number><unit> where unit is s|ms (default seconds).
 */

const fs   = require('fs');
const path = require('path');

function parseWindow(spec) {
  // "20s" → 20_000_000 µs (treated as a "from start" bound)
  // "20s..40s" → range
  const range = spec.match(/^(\d+(?:\.\d+)?)(s|ms)?\.\.(\d+(?:\.\d+)?)(s|ms)?$/);
  if (range) {
    const a = Number(range[1]) * (range[2] === 'ms' ? 1000 : 1_000_000);
    const b = Number(range[3]) * (range[4] === 'ms' ? 1000 : 1_000_000);
    return { fromUs: a, toUs: b };
  }
  const single = spec.match(/^(\d+(?:\.\d+)?)(s|ms)?$/);
  if (single) {
    const a = Number(single[1]) * (single[2] === 'ms' ? 1000 : 1_000_000);
    return { fromUs: a, toUs: Infinity };
  }
  throw new Error(`bad window spec: ${spec}`);
}

function loadTrace(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [usStr, seqStr] = line.split('\t');
    const us = Number(usStr);
    const seq = Number(seqStr);
    if (Number.isFinite(us) && Number.isFinite(seq)) {
      rows.push({ us, seq });
    }
  }
  return rows;
}

function analyze(rows, label, idealGapUs) {
  if (rows.length < 2) {
    console.log(`${label}: not enough samples (${rows.length})`);
    return;
  }

  // Compute inter-packet gaps and deviations from ideal
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    gaps.push(rows[i].us - rows[i-1].us);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95    = sorted[Math.floor(sorted.length * 0.95)];
  const p99    = sorted[Math.floor(sorted.length * 0.99)];
  const min    = sorted[0];
  const max    = sorted[sorted.length - 1];

  // Histogram in 1 ms bins around the ideal
  const binMs = 1;
  const histo = new Map();
  for (const g of gaps) {
    const bin = Math.round(g / 1000 / binMs) * binMs;
    histo.set(bin, (histo.get(bin) || 0) + 1);
  }
  const binKeys = [...histo.keys()].sort((a, b) => a - b);

  // Cumulative drift: how far has actual elapsed time drifted from ideal?
  // Ideal time of packet N = N * idealGapUs. Compare to rows[N].us - rows[0].us.
  const totalIdeal = idealGapUs * (rows.length - 1);
  const totalActual = rows[rows.length-1].us - rows[0].us;
  const totalDriftUs = totalActual - totalIdeal;

  // Mean deviation in first vs last quarter — sensitive to cumulative drift
  const q = Math.floor(rows.length / 4);
  const t0 = rows[0].us;
  let firstDev = 0, lastDev = 0;
  for (let i = 0; i < q; i++) {
    firstDev += Math.abs((rows[i].us - t0) - i * idealGapUs);
  }
  for (let i = rows.length - q; i < rows.length; i++) {
    lastDev  += Math.abs((rows[i].us - t0) - i * idealGapUs);
  }
  const firstMean = firstDev / q;
  const lastMean  = lastDev / q;

  console.log(`──── ${label} ────`);
  console.log(`  Packets: ${rows.length}`);
  console.log(`  Wall-clock span: ${(rows[rows.length-1].us - rows[0].us)/1e6} s`);
  console.log(`  Inter-packet gap (µs):`);
  console.log(`    min=${min}  median=${median}  p95=${p95}  p99=${p99}  max=${max}`);
  console.log(`    ideal: ${idealGapUs}`);
  const inSpec = gaps.filter(g => Math.abs(g - idealGapUs) <= 2000).length;
  const outOfSpec = gaps.length - inSpec;
  console.log(`    within ±2 ms of ideal: ${inSpec}/${gaps.length} (${(100*inSpec/gaps.length).toFixed(1)}%)`);
  console.log(`    outside ±5 ms of ideal: ${gaps.filter(g => Math.abs(g - idealGapUs) > 5000).length}`);
  console.log(`    outside ±10 ms of ideal: ${gaps.filter(g => Math.abs(g - idealGapUs) > 10000).length}`);
  console.log(`  Histogram (top 10 bins):`);
  const binSorted = [...histo.entries()].sort((a, b) => b[1] - a[1]);
  for (const [bin, n] of binSorted.slice(0, 10)) {
    const pct = 100 * n / gaps.length;
    console.log(`    ${String(bin).padStart(4)} ms: ${String(n).padStart(5)} (${pct.toFixed(1)}%)`);
  }
  console.log(`  Cumulative drift (over ${(totalActual/1e6).toFixed(1)}s): ${(totalDriftUs/1000).toFixed(2)} ms`);
  console.log(`  Mean deviation from ideal-target line:`);
  console.log(`    First quarter: ${(firstMean/1000).toFixed(2)} ms`);
  console.log(`    Last quarter:  ${(lastMean/1000).toFixed(2)} ms`);
  if (lastMean > firstMean + 1000) {
    console.log(`    *** DRIFT DETECTED: deviation is growing over time. ***`);
  } else {
    console.log(`    (Deviation is bounded — no cumulative drift.)`);
  }

  // Look for outlier ticks that emitted multiple packets back-to-back
  // (gap < 1 ms while the surrounding gaps are normal). These are the
  // "catch-up burst" cases.
  const burstGaps = gaps.filter(g => g < 1000);
  if (burstGaps.length > 0) {
    console.log(`  Burst events (gap < 1 ms — multiple packets sent in same tick): ${burstGaps.length}`);
  }
  // Look for stalls (gap > 30 ms — missed an entire tick)
  const stalls = gaps.filter(g => g > 30000);
  if (stalls.length > 0) {
    console.log(`  Stall events (gap > 30 ms — tick was very late): ${stalls.length}`);
    if (stalls.length <= 20) {
      const stallIdx = [];
      for (let i = 0; i < gaps.length; i++) if (gaps[i] > 30000) stallIdx.push(i);
      console.log(`    Locations (packet index): ${stallIdx.join(', ')}`);
    }
  }

  // Sequence numbers should be strictly monotonic mod 65536. Any gaps
  // would indicate dropped packets (which RtpSession doesn't drop, so
  // shouldn't happen — sanity check).
  let seqBreaks = 0;
  for (let i = 1; i < rows.length; i++) {
    const expected = (rows[i-1].seq + 1) & 0xffff;
    if (rows[i].seq !== expected) seqBreaks++;
  }
  if (seqBreaks > 0) {
    console.log(`  *** Sequence number breaks: ${seqBreaks} (unexpected) ***`);
  }
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node tools/analyze-tx-timing.js <trace_file> [--window=20s|--window=20s..60s]');
  process.exit(1);
}
const filepath = args[0];
let window = null;
for (const a of args.slice(1)) {
  if (a.startsWith('--window=')) {
    window = parseWindow(a.slice('--window='.length));
  }
}

if (!fs.existsSync(filepath)) {
  console.error(`File not found: ${filepath}`);
  process.exit(1);
}

const rows = loadTrace(filepath);
console.log(`Loaded ${rows.length} packet timestamps from ${path.basename(filepath)}`);

// Idealize at 20ms cadence (PCMU at 8kHz, 160 samples per packet)
const idealGapUs = 20_000;

// Analyze the entire trace
analyze(rows, 'Full trace', idealGapUs);

// If user specified a window, also analyze that subset
if (window) {
  const subset = rows.filter(r => r.us >= window.fromUs && r.us <= window.toUs);
  console.log();
  analyze(subset, `Window ${window.fromUs/1e6}s..${window.toUs === Infinity ? 'end' : window.toUs/1e6 + 's'}`, idealGapUs);
}
