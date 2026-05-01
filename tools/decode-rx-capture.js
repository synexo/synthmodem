#!/usr/bin/env node
'use strict';

// Offline test: feed the RX capture from a real V.22 call into the
// current PUREJS V.22 demodulator and see what bytes come out.
//
// Usage: node tools/decode-rx-capture.js path/to/rx.wav

const fs = require('fs');
const path = require('path');

if (process.argv.length < 3) {
  console.error('usage: node tools/decode-rx-capture.js <rx.wav>');
  process.exit(1);
}

// Load the WAV (16-bit mono PCM). Skip 44-byte RIFF header.
const wavBuf = fs.readFileSync(process.argv[2]);
const headerLen = 44;  // standard PCM WAV header
const sampleCount = (wavBuf.length - headerLen) / 2;
const samples = new Float32Array(sampleCount);
for (let i = 0; i < sampleCount; i++) {
  const lo = wavBuf[headerLen + i*2];
  const hi = wavBuf[headerLen + i*2 + 1];
  let v = (hi << 8) | lo;
  if (v & 0x8000) v -= 0x10000;
  samples[i] = v / 32768.0;
}
console.error(`Loaded ${samples.length} samples (${(samples.length/8000).toFixed(2)}s)`);

const { QAMDemodulator } = require(path.resolve(__dirname, '../src/dsp/protocols/V22.js'));

// Synthmodem is the answerer. Real modem is the originator and transmits
// at 1200 Hz (call carrier). So the RX side at synthmodem decodes at 1200 Hz.
const demod = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2 });

let bytesReceived = [];
demod.on('data', buf => {
  for (const b of buf) bytesReceived.push(b);
});

// Process in 160-sample chunks (one 20ms RTP packet) to mimic real-time
const CHUNK = 160;
for (let pos = 0; pos < samples.length; pos += CHUNK) {
  demod.process(samples.subarray(pos, Math.min(pos + CHUNK, samples.length)));
}

console.error(`Received ${bytesReceived.length} bytes`);

// Print as raw bytes (binary on stdout) plus a printable diagnostic on stderr
const printable = bytesReceived.map(b => {
  if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b);
  if (b === 0x0a) return '\\n';
  if (b === 0x0d) return '\\r';
  return `<${b.toString(16).padStart(2,'0')}>`;
}).join('');
console.error('--- DECODED ---');
console.error(printable);
