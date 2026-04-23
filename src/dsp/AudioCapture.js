'use strict';

/**
 * WAV file audio capture for call debugging
 *
 * Writes WAV files per call containing the audio seen on each side of
 * the modem link (received from remote, transmitted to remote, or both
 * mixed). Useful for inspecting what real modems are sending us and what
 * our modem is producing.
 *
 * Format: 16-bit signed mono PCM, 8 kHz sample rate (matches SIP/RTP
 * G.711 sample rate after μ/A-law decoding).
 *
 * Usage:
 *   const cap = new AudioCapture({ dir: './captures', tag: 'call-123' });
 *   cap.writeRx(float32samples);   // audio received from remote
 *   cap.writeTx(float32samples);   // audio we transmitted
 *   cap.close();                   // finalizes WAV headers
 */

const fs   = require('fs');
const path = require('path');

const SR = 8000;
const BYTES_PER_SAMPLE = 2;  // 16-bit signed

class WavWriter {
  constructor(filepath) {
    this._fd = fs.openSync(filepath, 'w');
    this._dataBytes = 0;
    // Write a placeholder 44-byte WAV header; we'll patch the lengths
    // on close().
    const header = Buffer.alloc(44);
    this._writePlaceholderHeader(header);
    fs.writeSync(this._fd, header, 0, 44, 0);
    this._pos = 44;
  }

  _writePlaceholderHeader(buf) {
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(0, 4);           // file size - 8 (patched later)
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);         // fmt chunk size
    buf.writeUInt16LE(1, 20);          // format = PCM
    buf.writeUInt16LE(1, 22);          // channels = 1
    buf.writeUInt32LE(SR, 24);         // sample rate
    buf.writeUInt32LE(SR * BYTES_PER_SAMPLE, 28);  // byte rate
    buf.writeUInt16LE(BYTES_PER_SAMPLE, 32);       // block align
    buf.writeUInt16LE(16, 34);         // bits per sample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(0, 40);          // data size (patched later)
  }

  writeSamples(float32Samples) {
    if (!this._fd) return;
    const n = float32Samples.length;
    const buf = Buffer.alloc(n * BYTES_PER_SAMPLE);
    for (let i = 0; i < n; i++) {
      let s = float32Samples[i];
      if (s >  1) s =  1;
      if (s < -1) s = -1;
      const v = Math.round(s * 32767);
      buf.writeInt16LE(v, i * BYTES_PER_SAMPLE);
    }
    fs.writeSync(this._fd, buf, 0, buf.length, this._pos);
    this._pos += buf.length;
    this._dataBytes += buf.length;
  }

  close() {
    if (!this._fd) return;
    // Patch the file-size and data-size fields in the header.
    const patch = Buffer.alloc(4);
    patch.writeUInt32LE(36 + this._dataBytes, 0);
    fs.writeSync(this._fd, patch, 0, 4, 4);
    patch.writeUInt32LE(this._dataBytes, 0);
    fs.writeSync(this._fd, patch, 0, 4, 40);
    fs.closeSync(this._fd);
    this._fd = null;
  }
}

class AudioCapture {
  /**
   * @param {Object} opts
   *   opts.dir   — directory to write WAVs into (created if needed)
   *   opts.tag   — filename prefix (e.g. call session ID)
   *   opts.enable — default true. If false, all write calls are no-ops.
   */
  constructor(opts = {}) {
    const enable = opts.enable !== false;
    if (!enable) {
      this._disabled = true;
      return;
    }
    const dir = opts.dir || './captures';
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* ignore */ }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = opts.tag || 'call';
    const base = path.join(dir, `${ts}_${tag}`);
    this._rxPath = base + '_rx.wav';
    this._txPath = base + '_tx.wav';
    this._base   = base;
    this._rx = new WavWriter(this._rxPath);
    this._tx = new WavWriter(this._txPath);
  }

  writeRx(samples) {
    if (this._disabled) return;
    if (this._rx) this._rx.writeSamples(samples);
  }

  writeTx(samples) {
    if (this._disabled) return;
    if (this._tx) this._tx.writeSamples(samples);
  }

  /**
   * Write an opaque debug blob next to the WAV captures. Used by the
   * slmodemd backend to emit /tmp/modem_*.raw dumps alongside the
   * call's audio recordings. No decoding — just fs.writeFile.
   *
   * Filename layout: `<base>_<name>` where base matches the WAV
   * prefix so the dump files sort together with the WAVs in the
   * captures directory.
   *
   * Returns the written path, or null if capture is disabled.
   * @param {string} name
   * @param {Buffer} buf
   */
  writeDump(name, buf) {
    if (this._disabled) return null;
    if (!name || typeof name !== 'string') {
      throw new TypeError('writeDump: name must be a non-empty string');
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('writeDump: buf must be a Buffer');
    }
    const outPath = `${this._base}_${name}`;
    fs.writeFileSync(outPath, buf);
    return outPath;
  }

  close() {
    if (this._disabled) return;
    if (this._rx) this._rx.close();
    if (this._tx) this._tx.close();
    this._rx = null;
    this._tx = null;
  }

  get rxPath() { return this._rxPath; }
  get txPath() { return this._txPath; }
  get basePath() { return this._base; }
}

module.exports = { AudioCapture, WavWriter };

// ─── Self-test ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const os = require('os');
  const tmp = os.tmpdir();
  const cap = new AudioCapture({ dir: tmp, tag: 'selftest' });

  // Write 1 second of 440 Hz sine wave to RX, 1 second of silence to TX.
  const tone = new Float32Array(SR);
  for (let i = 0; i < SR; i++) tone[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR);
  cap.writeRx(tone);

  const silence = new Float32Array(SR);
  cap.writeTx(silence);

  cap.close();

  // Verify files exist and look plausible.
  const rxStat = fs.statSync(cap.rxPath);
  const txStat = fs.statSync(cap.txPath);
  const expectedSize = 44 + SR * 2;  // header + 1 sec * 8000 * 2 bytes
  const rxOk = rxStat.size === expectedSize;
  const txOk = txStat.size === expectedSize;

  console.log('wrote:', cap.rxPath, '(' + rxStat.size + ' bytes)');
  console.log('wrote:', cap.txPath, '(' + txStat.size + ' bytes)');
  console.log('rx size correct:', rxOk);
  console.log('tx size correct:', txOk);

  // Clean up
  try { fs.unlinkSync(cap.rxPath); fs.unlinkSync(cap.txPath); } catch (e) {}

  process.exit(rxOk && txOk ? 0 : 1);
}
