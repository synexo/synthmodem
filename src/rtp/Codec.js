'use strict';

/**
 * Codec — G.711 µ-law (PCMU) and A-law (PCMA) encode/decode.
 * Also Linear PCM (L16) passthrough for testing.
 *
 * All internal audio is Float32 normalised to [-1.0, +1.0].
 * G.711 operates on 8-bit unsigned bytes representing 8kHz samples.
 */

// ─── µ-law (PCMU) ─────────────────────────────────────────────────────────────

const ULAW_MAX = 32767;
const ULAW_BIAS = 0x84;

function ulawEncodeSample(sample) {
  // Clamp
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  let sign = 0;
  if (s < 0) { sign = 0x80; s = -s; }
  s += ULAW_BIAS;
  if (s > 32767) s = 32767;
  // Find segment
  let exponent = 7;
  let mask = 0x4000;
  while (exponent > 0 && !(s & mask)) { exponent--; mask >>= 1; }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawDecodeSample(ulaw) {
  ulaw = ~ulaw & 0xff;
  const sign     = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

// ─── A-law (PCMA) ─────────────────────────────────────────────────────────────
// G.711 A-law operates on a 13-bit linear range (±4096).
// Float normalisation constant for A-law:
const ALAW_MAX = 4096;

const ALAW_SEG_END = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];

function alawEncodeSample(sample) {
  // Convert float [-1,+1] to 13-bit integer [-4096, +4095]
  let s = Math.max(-4096, Math.min(4095, Math.round(sample)));
  let mask, seg, aval;
  if (s >= 0) {
    mask = 0xD5; // positive: bit7=1 after XOR
  } else {
    mask = 0x55; // negative: bit7=0 after XOR
    s    = ~s;   // bitwise NOT of negative values per G.711 spec
    if (s < 0) s = 0;
  }
  // Find segment
  for (seg = 0; seg < 8; seg++) {
    if (s <= ALAW_SEG_END[seg]) break;
  }
  if (seg === 8) {
    aval = 0x7F ^ mask;
  } else {
    aval = seg << 4;
    if (seg < 2) aval |= (s >> 1) & 0x0f;
    else         aval |= (s >> seg) & 0x0f;
    aval ^= mask;
  }
  return aval & 0xff;
}

function alawDecodeSample(alaw) {
  alaw ^= 0x55;
  const seg  = (alaw & 0x70) >> 4;
  const mant = alaw & 0x0f;
  let t;
  if (seg === 0) t = (mant << 1) | 1;
  else           t = ((mant | 0x10) << seg) | (1 << (seg - 1));
  return (alaw & 0x80) ? t : -t;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encode a Float32Array of audio samples to a Buffer of G.711 bytes.
 * @param {Float32Array} samples  Normalised [-1,+1]
 * @param {string}       codec    'PCMU' | 'PCMA' | 'L16'
 * @returns {Buffer}
 */
function encode(samples, codec) {
  const out = Buffer.allocUnsafe(samples.length);
  switch (codec) {
    case 'PCMU':
      for (let i = 0; i < samples.length; i++) {
        out[i] = ulawEncodeSample(samples[i] * ULAW_MAX);
      }
      break;
    case 'PCMA':
      for (let i = 0; i < samples.length; i++) {
        out[i] = alawEncodeSample(samples[i] * ALAW_MAX);
      }
      break;
    case 'L16': {
      // 16-bit big-endian
      const buf = Buffer.allocUnsafe(samples.length * 2);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
        buf.writeInt16BE(v, i * 2);
      }
      return buf;
    }
    default:
      throw new Error(`Unknown codec: ${codec}`);
  }
  return out;
}

/**
 * Decode a Buffer of G.711 bytes to a Float32Array.
 * @param {Buffer} buf
 * @param {string} codec  'PCMU' | 'PCMA' | 'L16'
 * @returns {Float32Array}
 */
function decode(buf, codec) {
  switch (codec) {
    case 'PCMU': {
      const out = new Float32Array(buf.length);
      for (let i = 0; i < buf.length; i++) {
        out[i] = ulawDecodeSample(buf[i]) / ULAW_MAX;
      }
      return out;
    }
    case 'PCMA': {
      const out = new Float32Array(buf.length);
      for (let i = 0; i < buf.length; i++) {
        out[i] = alawDecodeSample(buf[i]) / ALAW_MAX;
      }
      return out;
    }
    case 'L16': {
      const out = new Float32Array(buf.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = buf.readInt16BE(i * 2) / 32767;
      }
      return out;
    }
    default:
      throw new Error(`Unknown codec: ${codec}`);
  }
}

/**
 * Generate a buffer of silence in the given codec.
 * µ-law silence = 0xFF, A-law silence = 0xD5, L16 silence = 0x00
 */
function silence(numSamples, codec) {
  const buf = Buffer.allocUnsafe(codec === 'L16' ? numSamples * 2 : numSamples);
  switch (codec) {
    case 'PCMU': buf.fill(0xFF); break;
    case 'PCMA': buf.fill(0xD5); break;
    case 'L16':  buf.fill(0x00); break;
  }
  return buf;
}

module.exports = { encode, decode, silence };
