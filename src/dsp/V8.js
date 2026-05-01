'use strict';

/**
 * ITU-T V.8 (05/99) — Procedures for starting sessions of data transmission
 * over the public switched telephone network.
 *
 * Spec-conformant encoder/decoder for V.8 signalling (CI, CM, JM, CJ).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Key spec facts (V.8 §5, §7):
 *
 *   Modulation:
 *     CI, CM, CJ   →  V.21 channel 1 (low-band)  — called V.21(L) in spec
 *     JM           →  V.21 channel 2 (high-band) — called V.21(H) in spec
 *     Baud:         300 bit/s
 *
 *   Signal structure:
 *     Each of CI/CM/JM begins with a preamble: 10 ones followed by 10
 *     synchronisation bits. Sync pattern distinguishes CI from CM/JM:
 *       CI  sync: "0000000001"
 *       CM/JM sync: "0000001111"
 *     After preamble: one or more octets. Each octet is framed with a
 *     start bit (0) before and stop bit (1) after.
 *     Bits are transmitted in time order b0..b7 (b0 first = LSB).
 *
 *     CJ is different — three consecutive zero octets with start/stop bits,
 *     NO preamble. Signals "end of CM".
 *
 *   Octet types (§5.1, §5.2):
 *     Category octet:   b4 = 0, b0-b3 = category tag, b5-b7 = option bits
 *     Extension octet:  b3 = 0, b4 = 1, b5 = 0, b0-b2 + b6-b7 = extension
 *                        option bits (extends the immediately preceding
 *                        category octet).
 *     The fixed bits (b4=0 for category, b3=0 b4=1 b5=0 for extension)
 *     prevent the HDLC flag octet (0x7E = 01111110) from appearing in the
 *     bit stream.
 *
 *   Category tags (§6, Table 2) — given as transmitted-order bits b0 b1 b2 b3:
 *     1000  = Call function     (b0=1, b1=0, b2=0, b3=0)
 *     1010  = Modulation modes  (b0=1, b1=0, b2=1, b3=0)
 *     0101  = Protocols         (b0=0, b1=1, b2=0, b3=1)
 *     1011  = PSTN access       (b0=1, b1=0, b2=1, b3=1)
 *     1111  = Non-standard
 *     0011  = PCM modem avail   (b0=0, b1=0, b2=1, b3=1)
 *     1110  = Defined in T.66
 *
 *   Call function option bits (§6.1, Table 3):
 *     000 = reserved
 *     100 = PSTN Multimedia terminal (H.324)
 *     010 = Textphone (V.18)
 *     110 = Videotext (T.101)
 *     001 = Transmit facsimile from call terminal (T.30)
 *     101 = Receive facsimile at call terminal (T.30)
 *     011 = Data (unspecified application) ← we use this
 *     111 = Extension (next octet)
 *
 *   Modulation modes octets (§6.2, Table 4):
 *     modn0 (category octet, b4=0):
 *       b5 = PCM modem availability present
 *       b6 = V.34 duplex
 *       b7 = V.34 half-duplex
 *     modn1 (extension, b3=0,b4=1,b5=0):
 *       b0 = V.32bis / V.32
 *       b1 = V.22bis / V.22
 *       b2 = V.17
 *       b6 = V.29 half-duplex
 *       b7 = V.27 ter
 *     modn2 (extension, b3=0,b4=1,b5=0):
 *       b0 = V.26 ter
 *       b1 = V.26 bis
 *       b2 = V.23 duplex
 *       b6 = V.23 half-duplex
 *       b7 = V.21
 *
 *   Timing (§8):
 *     Call DCE:
 *       - ≥1 s silence after off-hook
 *       - Send CI (optional) with ON periods ≥3 sequences (≤2 s) and
 *         OFF periods 0.4-2 s
 *       - Wait for ANS / ANSam / sigA
 *       - On ANSam: stop CI, silence for Te (≥0.5 s, ≥1 s if echo-canceller
 *         disabling needed), then start CM
 *       - On ≥2 identical JM: complete current octet, send CJ
 *       - After CJ: 75 ± 5 ms silence, then sigC
 *     Answer DCE:
 *       - ≥0.2 s silence after connection
 *       - Send ANSam
 *       - On ≥2 identical CM: start JM; continue until CJ detected
 *       - After all 3 CJ octets received: 75 ± 5 ms silence, then sigA
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Preamble sync patterns ─────────────────────────────────────────────────
// Ten-bit sync patterns that distinguish CI from CM/JM (V.8 Table 1).
// Bits listed in time order (leftmost = first transmitted).
const V8_SYNC_CI    = '0000000001';
const V8_SYNC_CM_JM = '0000001111';

// ─── Category tags (V.8 Table 2, b0-b3 in transmission order) ──────────────
// These are the FIRST FOUR transmitted bits of a category octet (after
// the start bit). Values are documented in §5.1 and §6-Table 2.
const V8_TAG_CALL_FN    = [1, 0, 0, 0];  // Call function
const V8_TAG_MOD_MODES  = [1, 0, 1, 0];  // Modulation modes
const V8_TAG_PROTOCOLS  = [0, 1, 0, 1];  // Protocols
const V8_TAG_PSTN_ACC   = [1, 0, 1, 1];  // PSTN access
const V8_TAG_NSF        = [1, 1, 1, 1];  // Non-standard facilities
const V8_TAG_PCM_AVAIL  = [0, 0, 1, 1];  // PCM modem availability

// ─── Call function option bits (V.8 Table 3, b5-b7) ────────────────────────
const V8_CALLFN_DATA    = [0, 1, 1];  // Data (unspecified application)
const V8_CALLFN_H324    = [1, 0, 0];  // PSTN Multimedia terminal H.324
const V8_CALLFN_V18     = [0, 1, 0];  // Textphone V.18
const V8_CALLFN_T101    = [1, 1, 0];  // Videotext T.101
const V8_CALLFN_FAX_TX  = [0, 0, 1];  // Transmit fax T.30
const V8_CALLFN_FAX_RX  = [1, 0, 1];  // Receive fax T.30
const V8_CALLFN_EXT     = [1, 1, 1];  // Extension octet follows

/**
 * Pack a category octet. Returns an array of 10 bits (start + 8 data + stop)
 * in transmission order.
 *
 * @param {number[]} tag      4-bit category tag [b0, b1, b2, b3]
 * @param {number[]} optBits  3 option bits [b5, b6, b7]
 * @returns {number[]} 10-bit array
 */
function packCategoryOctet(tag, optBits) {
  const b0 = tag[0], b1 = tag[1], b2 = tag[2], b3 = tag[3];
  const b4 = 0;  // Category marker
  const b5 = optBits[0], b6 = optBits[1], b7 = optBits[2];
  return [0, b0, b1, b2, b3, b4, b5, b6, b7, 1];
}

/**
 * Pack an extension octet. Returns an array of 10 bits (start + 8 data + stop)
 * in transmission order.
 *
 * @param {number[]} extBits 5 extension option bits [b0, b1, b2, b6, b7]
 * @returns {number[]} 10-bit array
 */
function packExtensionOctet(extBits) {
  const b0 = extBits[0], b1 = extBits[1], b2 = extBits[2];
  const b3 = 0;                // Fixed bit
  const b4 = 1;                // Extension marker
  const b5 = 0;                // Fixed bit
  const b6 = extBits[3], b7 = extBits[4];
  return [0, b0, b1, b2, b3, b4, b5, b6, b7, 1];
}

/** Build a call-function category octet indicating "Data" call. */
function buildCallFunctionOctet() {
  return packCategoryOctet(V8_TAG_CALL_FN, V8_CALLFN_DATA);
}

/**
 * Build modulation-modes octets (modn0, and optionally modn1 / modn2
 * extensions) indicating availability of the listed protocols.
 *
 * @param {Object} modes  Boolean flags:
 *   v34, v34hd, v32bis, v22bis, v17, v29hd, v27ter,
 *   v26ter, v26bis, v23, v23hd, v21, pcm
 * @returns {number[]}  Array of (10 * numOctets) bits
 */
function buildModulationModesOctets(modes = {}) {
  // modn0: b5 = PCM avail present, b6 = V.34 duplex, b7 = V.34 halfdup.
  const modn0 = packCategoryOctet(V8_TAG_MOD_MODES, [
    modes.pcm    ? 1 : 0,
    modes.v34    ? 1 : 0,
    modes.v34hd  ? 1 : 0,
  ]);

  // Only include modn1 if any of its bits are set (V.32bis, V.22bis, V.17,
  // V.29hd, V.27ter). If any later bit is set (V.26ter and later) we need
  // to include modn1 to preserve category integrity even if its own bits
  // are all zero, because extension octets chain directly.
  const needModn1 = modes.v32bis || modes.v22bis || modes.v17 ||
                    modes.v29hd  || modes.v27ter;
  const needModn2 = modes.v26ter || modes.v26bis || modes.v23 ||
                    modes.v23hd  || modes.v21;
  const includeModn1 = needModn1 || needModn2;
  const includeModn2 = needModn2;

  const out = [...modn0];
  if (includeModn1) {
    const modn1 = packExtensionOctet([
      modes.v32bis ? 1 : 0,   // b0
      modes.v22bis ? 1 : 0,   // b1
      modes.v17    ? 1 : 0,   // b2
      modes.v29hd  ? 1 : 0,   // b6
      modes.v27ter ? 1 : 0,   // b7
    ]);
    out.push(...modn1);
  }
  if (includeModn2) {
    const modn2 = packExtensionOctet([
      modes.v26ter ? 1 : 0,   // b0
      modes.v26bis ? 1 : 0,   // b1
      modes.v23    ? 1 : 0,   // b2
      modes.v23hd  ? 1 : 0,   // b6
      modes.v21    ? 1 : 0,   // b7
    ]);
    out.push(...modn2);
  }
  return out;
}

/**
 * Build a complete CI sequence:
 *   10 ones preamble + 10-bit CI sync + 1 call-function octet (10 bits)
 * Returns array of bits (length 30).
 */
function buildCI() {
  const bits = [];
  // 10-ones preamble
  for (let i = 0; i < 10; i++) bits.push(1);
  // Sync
  for (const c of V8_SYNC_CI) bits.push(c === '1' ? 1 : 0);
  // Call function octet
  bits.push(...buildCallFunctionOctet());
  return bits;
}

/**
 * Build a complete CM or JM sequence:
 *   10 ones preamble + 10-bit CM/JM sync + call-function octet + modulation-modes octets
 *
 * @param {Object} modes     Modulation-mode flags (see buildModulationModesOctets)
 * @returns {number[]}       Array of bits
 */
function buildCMorJM(modes) {
  const bits = [];
  for (let i = 0; i < 10; i++) bits.push(1);
  for (const c of V8_SYNC_CM_JM) bits.push(c === '1' ? 1 : 0);
  bits.push(...buildCallFunctionOctet());
  bits.push(...buildModulationModesOctets(modes));
  return bits;
}

/**
 * Build the CJ terminator: three zero octets, each framed with start(0)
 * and stop(1) bits. No preamble. Total 30 bits.
 */
function buildCJ() {
  const bits = [];
  for (let i = 0; i < 3; i++) {
    bits.push(0);           // start
    for (let j = 0; j < 8; j++) bits.push(0);  // b0..b7 all zero
    bits.push(1);           // stop
  }
  return bits;
}

// ─── Decoder state machine ────────────────────────────────────────────────
//
// Scans a continuous bit stream (from V.21 demodulator) and extracts
// V.8 messages. Uses a sliding-window matcher on the 20-bit preamble
// (10 ones + 10 sync bits) to find the start of each CI/CM/JM message.
// After the preamble, reads 10-bit framed octets until the category-chain
// terminates (implementation-defined stopping criterion: no extension
// follows, or buffer runs dry).
//
// CJ is detected as three consecutive zero octets (with start/stop bits)
// when we are in the "expecting CJ" state (call DCE waiting for CJ).

class V8Decoder {
  constructor() {
    this._bitBuf = [];       // sliding window for preamble matching
    this._maxBuf = 300;
    this._octetBits = [];    // bits accumulated for the current pending octet
    this._octets = [];       // completed octets in current message
    this._state = 'HUNT';    // HUNT (seeking preamble) | OCTETS (reading)
    this._pendingType = null; // 'CI' or 'CM/JM'
  }

  /**
   * Feed one bit. Returns a decoded message object when a complete one
   * is detected (triggered by either: seeing the start of the NEXT preamble
   * while in OCTETS state, OR calling finish()).
   *
   * Message: { type, octets[] }
   */
  feed(bit) {
    bit = bit & 1;
    this._bitBuf.push(bit);
    if (this._bitBuf.length > this._maxBuf) this._bitBuf.shift();

    // In OCTETS state, always check if a new preamble started — that
    // means our previous message is complete.
    if (this._state === 'OCTETS' && this._bitBuf.length >= 20) {
      const last20 = this._bitBuf.slice(-20);
      if (this._matchesPreamble(last20, V8_SYNC_CI)) {
        const msg = this._emit();
        this._state = 'OCTETS';
        this._pendingType = 'CI';
        this._octets = [];
        this._octetBits = [];
        return msg;
      }
      if (this._matchesPreamble(last20, V8_SYNC_CM_JM)) {
        const msg = this._emit();
        this._state = 'OCTETS';
        this._pendingType = 'CM/JM';
        this._octets = [];
        this._octetBits = [];
        return msg;
      }
    }

    if (this._state === 'HUNT') {
      if (this._bitBuf.length < 20) return null;
      const last20 = this._bitBuf.slice(-20);
      if (this._matchesPreamble(last20, V8_SYNC_CI)) {
        this._state = 'OCTETS';
        this._pendingType = 'CI';
        this._octets = [];
        this._octetBits = [];
      } else if (this._matchesPreamble(last20, V8_SYNC_CM_JM)) {
        this._state = 'OCTETS';
        this._pendingType = 'CM/JM';
        this._octets = [];
        this._octetBits = [];
      }
      return null;
    }

    // OCTETS state: accumulate bits into 10-bit framed octets.
    this._octetBits.push(bit);
    if (this._octetBits.length === 10) {
      // Validate framing.
      if (this._octetBits[0] !== 0 || this._octetBits[9] !== 1) {
        // Desync — abandon message and return to HUNT.
        this._state = 'HUNT';
        this._octets = [];
        this._octetBits = [];
        return null;
      }
      const b = this._octetBits.slice(1, 9);
      let v = 0;
      for (let i = 0; i < 8; i++) v |= (b[i] & 1) << i;
      this._octets.push(v);
      this._octetBits = [];

      // For CI (single octet), emit immediately.
      if (this._pendingType === 'CI') {
        const msg = this._emit();
        this._state = 'HUNT';
        return msg;
      }
      // Safety cap: if we've accumulated more than 16 octets without
      // seeing another preamble, something's wrong — emit what we have.
      if (this._octets.length >= 16) {
        const msg = this._emit();
        this._state = 'HUNT';
        return msg;
      }
    }
    return null;
  }

  /**
   * Flush any pending message. Call this when the input stream ends,
   * or when you want to force-emit the current accumulation.
   */
  finish() {
    if (this._state === 'OCTETS' && this._octets.length > 0) {
      const msg = this._emit();
      this._state = 'HUNT';
      this._octets = [];
      this._octetBits = [];
      return msg;
    }
    return null;
  }

  _emit() {
    return { type: this._pendingType || 'CM/JM', octets: this._octets.slice() };
  }

  _matchesPreamble(bits20, sync) {
    for (let i = 0; i < 10; i++) if (bits20[i] !== 1) return false;
    for (let i = 0; i < 10; i++) if (bits20[10 + i] !== (sync[i] === '1' ? 1 : 0)) return false;
    return true;
  }
}

// ─── Utility: decode a CM/JM message octet array to a modes object ──────
/**
 * Parse decoded V.8 CM/JM octets to determine advertised modes.
 * @param {number[]} octets  Byte values (b0 as LSB)
 * @returns {Object}
 */
function decodeModes(octets) {
  const modes = {};
  let i = 0;
  while (i < octets.length) {
    const o = octets[i];
    const b0 = (o >> 0) & 1, b1 = (o >> 1) & 1, b2 = (o >> 2) & 1;
    const b3 = (o >> 3) & 1, b4 = (o >> 4) & 1, b5 = (o >> 5) & 1;
    const b6 = (o >> 6) & 1, b7 = (o >> 7) & 1;

    if (b4 === 0) {
      // Category octet. Examine tag b0-b3.
      const tag = (b0 << 0) | (b1 << 1) | (b2 << 2) | (b3 << 3);
      // tag values (b0 first): 1010 → bit0=1,bit1=0,bit2=1,bit3=0 → low nibble = 0b0101 = 5
      if (tag === 0x5) {
        // Modulation modes modn0: b5=pcm, b6=v34, b7=v34hd
        modes.pcm   = !!b5;
        modes.v34   = !!b6;
        modes.v34hd = !!b7;
        // Check next octet for modn1 extension
        if (i + 1 < octets.length) {
          const o1 = octets[i + 1];
          const x_b3 = (o1 >> 3) & 1, x_b4 = (o1 >> 4) & 1, x_b5 = (o1 >> 5) & 1;
          if (x_b3 === 0 && x_b4 === 1 && x_b5 === 0) {
            // modn1
            modes.v32bis = !!((o1 >> 0) & 1);
            modes.v22bis = !!((o1 >> 1) & 1);
            modes.v17    = !!((o1 >> 2) & 1);
            modes.v29hd  = !!((o1 >> 6) & 1);
            modes.v27ter = !!((o1 >> 7) & 1);
            i++;
            // Check for modn2
            if (i + 1 < octets.length) {
              const o2 = octets[i + 1];
              const x2_b3 = (o2 >> 3) & 1, x2_b4 = (o2 >> 4) & 1, x2_b5 = (o2 >> 5) & 1;
              if (x2_b3 === 0 && x2_b4 === 1 && x2_b5 === 0) {
                modes.v26ter = !!((o2 >> 0) & 1);
                modes.v26bis = !!((o2 >> 1) & 1);
                modes.v23    = !!((o2 >> 2) & 1);
                modes.v23hd  = !!((o2 >> 6) & 1);
                modes.v21    = !!((o2 >> 7) & 1);
                i++;
              }
            }
          }
        }
      }
      // tag 0x1 (call function) = b0=1,b1=0,b2=0,b3=0 → low nibble 0b0001 = 1
      else if (tag === 0x1) {
        const callFn = (b5 << 0) | (b6 << 1) | (b7 << 2);
        modes.callFn = callFn;
      }
      // Other categories (protocols, PCM, PSTN access, NSF) — not
      // decoded here for brevity but could be added.
    }
    // If extension octet without matching preceding category, skip
    i++;
  }
  return modes;
}

// ─── Select common protocol between local and remote modes ──────────────
/**
 * Given remote's CM modes and our own capabilities (+ preference order),
 * pick the best protocol to use. Returns protocol name string or null.
 *
 * @param {Object}   remote      Modes from decodeModes(CM octets)
 * @param {string[]} preference  Ordered list, e.g. ['V34','V32bis','V22bis','V22','V21']
 */
function selectProtocol(remote, preference) {
  const map = {
    V34:    'v34',
    V32bis: 'v32bis',
    V22bis: 'v22bis',
    V22:    'v22bis',     // V.22 is included in V.22bis bit
    V23:    'v23',
    V21:    'v21',
  };
  for (const p of preference) {
    const key = map[p];
    if (key && remote[key]) return p;
  }
  return null;
}

// ─── Byte-level V.8 API for use with UART-framed V.21 ───────────────────────
//
// The V.8 bit structure happens to align with UART framing (start + 8 data
// + stop). Even the 10-bit sync pattern is a valid UART frame. This means
// V.8 messages can be sent/received as byte sequences over an existing
// UART-framed V.21 implementation, without needing raw-bit access.
//
// Sync-byte values (the 10-bit sync pattern interpreted as a UART frame,
// data bits in LSB-first order):
//   CI    sync "0000000001" → byte value 0x00  (data = 00000000, stop = 1)
//   CM/JM sync "0000001111" → byte value 0xE0  (data = 00000111, stop = 1)
//
// Known octet values for V.8 categories (LSB-first byte encoding):
//   Call function (Data):  0xC1
//   Modulation modes modn0, V.34 avail flags all zero:  0x05
//                    modn0 with b5=pcm:                  0x25
//                    modn0 with b6=v34:                  0x45
//   modn1 extension (any combination of v32bis/v22bis/v17/v29hd/v27ter):
//     base value = 0x10 (start b0..b7 = 00010000, i.e. b4=1)
//     set bits: v32bis=|0x01, v22bis=|0x02, v17=|0x04, v29hd=|0x40, v27ter=|0x80
//   modn2 extension (v26ter/v26bis/v23/v23hd/v21):
//     base value = 0x10
//     set bits: v26ter=|0x01, v26bis=|0x02, v23=|0x04, v23hd=|0x40, v21=|0x80

const V8_BYTE_CI_SYNC    = 0x00;
const V8_BYTE_CMJM_SYNC  = 0xE0;

/** Build the CI byte sequence suitable for V21.write():
 *  [sync, call_fn_data]. Does NOT include the 10-ones "preamble" — that
 *  happens naturally as UART idle marking. */
function buildCIBytes() {
  // Call-function octet for Data:
  //   start=0 b0=1 b1=0 b2=0 b3=0 b4=0 b5=0 b6=1 b7=1 stop=1
  //   LSB-first byte: 11000001 = 0xC1
  return Buffer.from([V8_BYTE_CI_SYNC, 0xC1]);
}

/** Helper to build mod-modes byte sequence from a modes object. */
function _modModesBytes(modes) {
  // modn0: tag 1010 (b0=1,b1=0,b2=1,b3=0), b4=0, b5=pcm, b6=v34, b7=v34hd
  // LSB-first byte: bits = [1, 0, 1, 0, 0, pcm, v34, v34hd]
  //                 byte = 0x05 | (pcm<<5) | (v34<<6) | (v34hd<<7)
  let modn0 = 0x05;
  if (modes.pcm)    modn0 |= 0x20;
  if (modes.v34)    modn0 |= 0x40;
  if (modes.v34hd)  modn0 |= 0x80;

  const needModn1 = modes.v32bis || modes.v22bis || modes.v17 ||
                    modes.v29hd  || modes.v27ter;
  const needModn2 = modes.v26ter || modes.v26bis || modes.v23 ||
                    modes.v23hd  || modes.v21;

  const out = [modn0];

  if (needModn1 || needModn2) {
    // modn1 extension: start=0 b0 b1 b2 b3=0 b4=1 b5=0 b6 b7 stop=1
    // LSB-first byte: bits = [v32bis, v22bis, v17, 0, 1, 0, v29hd, v27ter]
    // byte = 0x10 | v32bis | v22bis<<1 | v17<<2 | v29hd<<6 | v27ter<<7
    let modn1 = 0x10;
    if (modes.v32bis) modn1 |= 0x01;
    if (modes.v22bis) modn1 |= 0x02;
    if (modes.v17)    modn1 |= 0x04;
    if (modes.v29hd)  modn1 |= 0x40;
    if (modes.v27ter) modn1 |= 0x80;
    out.push(modn1);
  }

  if (needModn2) {
    let modn2 = 0x10;
    if (modes.v26ter) modn2 |= 0x01;
    if (modes.v26bis) modn2 |= 0x02;
    if (modes.v23)    modn2 |= 0x04;
    if (modes.v23hd)  modn2 |= 0x40;
    if (modes.v21)    modn2 |= 0x80;
    out.push(modn2);
  }

  return out;
}

/** Build the CM byte sequence. */
function buildCMBytes(modes) {
  return Buffer.from([V8_BYTE_CMJM_SYNC, 0xC1, ..._modModesBytes(modes)]);
}

/** Build the JM byte sequence (same format as CM — the only difference is
 *  which V.21 channel it's transmitted on). */
function buildJMBytes(modes) {
  return Buffer.from([V8_BYTE_CMJM_SYNC, 0xC1, ..._modModesBytes(modes)]);
}

/** Build the CJ byte sequence: three zero octets. No sync byte.
 *
 *  CJ has NO preamble per spec — the 10-ones idle is suppressed, and
 *  there's no sync pattern. This makes CJ distinguishable from a new
 *  CM only by the absence of sync. We send three 0x00 bytes back-to-back;
 *  the peer's V.8 state machine (already expecting CJ after JM exchange)
 *  will treat this as CJ.
 *
 *  CAVEAT: a UART-framed transmitter will insert start/stop bits around
 *  each 0x00 byte, making each of our three 0x00 bytes LOOK like a
 *  properly framed V.8 octet with start(0)+data(00000000)+stop(1). The
 *  peer will see three zero octets. This is what spec §7 describes as CJ.
 *  Spec text "three zero octets with start/stop bits but without the
 *  preceding ones and sync" matches this exactly. */
function buildCJBytes() {
  return Buffer.from([0x00, 0x00, 0x00]);
}

/** Parse a byte stream for V.8 messages. Stateful.
 *
 *  Usage:
 *    const parser = { buf: Buffer.alloc(0) };
 *    // On each incoming 'data' event from V.21:
 *    const msgs = parseV8Bytes(parser, incomingBuf);
 *    for (const m of msgs) { ... }
 *
 *  Returns an array of message objects:
 *    { type: 'CI' | 'CM/JM' | 'CJ', modes?: {...}, callFn?: int }
 */
function parseV8Bytes(state, newBytes) {
  if (!state.buf) state.buf = Buffer.alloc(0);
  state.buf = Buffer.concat([state.buf, Buffer.from(newBytes)]);
  const msgs = [];

  // Try to parse from the start of the buffer.
  while (state.buf.length > 0) {
    const b0 = state.buf[0];

    // CJ: three consecutive 0x00. Need at least 3 bytes.
    // Also CI sync is 0x00 followed by call-fn byte. So 0x00 alone is
    // ambiguous — could be start of CI or start of CJ. Disambiguate:
    //   0x00 followed by 0xC1 (call fn = Data) → CI
    //   0x00 0x00 0x00 → CJ
    //   0x00 0x00 not followed by 0x00 → possibly CI with call-fn=0x00 (reserved)
    //     which we treat as ambiguous — skip one byte and try again.
    if (b0 === V8_BYTE_CI_SYNC) {
      if (state.buf.length < 2) return msgs;  // need more data
      const b1 = state.buf[1];
      if (b1 === 0x00) {
        // Possible CJ. V.8 §5.2 nominally says CJ is "at least three
        // octets of binary 0", but real modems frequently send only
        // 2 full zero octets before falling silent (capture
        // 2026-04-30T15:28:54 shows exactly this behaviour from a
        // V.8-capable AT modem). Spandsp's CJ matcher also accepts
        // less than three zeros in practice — its bit-stream-level
        // matcher is far more lenient than a strict octet count.
        //
        // We accept 2 zero octets as CJ. Risk of false positives is
        // minimal: this branch only fires after seeing a leading 0x00
        // byte at the V.8-byte-stream level, which is extremely
        // unlikely in CM/JM payload (every category/extension octet
        // has its low bits set to a non-zero category tag).
        if (state.buf.length < 2) return msgs;
        // If a third zero is in view, consume all three (saves the
        // parser from having to re-process the third byte on a later
        // call). If not, two is enough.
        if (state.buf.length >= 3 && state.buf[2] === 0x00) {
          msgs.push({ type: 'CJ' });
          state.buf = state.buf.subarray(3);
          continue;
        }
        msgs.push({ type: 'CJ' });
        state.buf = state.buf.subarray(2);
        continue;
      }
      // CI message: sync + call-function octet.
      // b1 is the call-function octet byte value.
      // Sanity check: the call-function byte must have low 5 bits = 0x01.
      if ((b1 & 0x1F) !== 0x01) {
        // Not a valid CI — consume the leading 0x00 and try to resync.
        state.buf = state.buf.subarray(1);
        continue;
      }
      // Extract call function option bits (b5, b6, b7) from byte:
      //   b5 = bit 5 of byte, b6 = bit 6, b7 = bit 7
      //   callFn = (b5 << 0) | (b6 << 1) | (b7 << 2)
      const callFn = ((b1 >> 5) & 1) | (((b1 >> 6) & 1) << 1) | (((b1 >> 7) & 1) << 2);
      msgs.push({ type: 'CI', callFn });
      state.buf = state.buf.subarray(2);
      continue;
    }

    if (b0 === V8_BYTE_CMJM_SYNC) {
      // CM/JM message: sync + call-function + 1..N modulation-mode octets.
      // The challenge with byte-stream parsing: a complete CM has a
      // variable number of octets (1 modn0 + 0/1/2 extension octets),
      // and the only way to know "no more extensions follow" is to see
      // either (a) a fresh sync byte starting the next message, or
      // (b) at least one octet AFTER the would-be modn1/modn2 to confirm
      // it's not actually a continuation. Parsing eagerly the moment we
      // have sync+callfn+modn0 would discard real modn1/modn2 octets if
      // they arrive in a later byte buffer (the typical pattern when
      // bytes are delivered one at a time by the V.21 UART decoder).
      //
      // Rule: don't emit a CM/JM until either the buffer ends with a
      // candidate-terminator (next sync byte or 0x00) OR it has so many
      // octets after the call-function that even three back-to-back
      // extension octets are accounted for. Concretely we wait for
      // length ≥ 2 + 3 + 1 = 6 (sync + callfn + up-to-3-octets +
      // 1 terminator candidate) before emitting WITHOUT a terminator;
      // OR length ≥ 3 plus a terminator byte already in view.
      //
      // For pre-emit holdoff we need at minimum sync + callfn + modn0
      // + one byte that's either the next message's sync or the modn1
      // extension. So minimum useful buffer is 4 bytes.
      if (state.buf.length < 4) return msgs;  // wait for at least sync+callfn+modn0+lookahead

      const callFnByte = state.buf[1];
      // Sanity-check the call-function byte before doing anything else.
      // Its low 5 bits should be 0b00001 = 0x01 (call-function category
      // tag b0=1 b1=0 b2=0 b3=0 + b4=0 category marker).
      const callFnValid = (callFnByte & 0x1F) === 0x01;
      if (!callFnValid) {
        // Not a plausible CM. Skip the leading sync byte and try resync.
        state.buf = state.buf.subarray(1);
        continue;
      }
      const callFn = ((callFnByte >> 5) & 1) | (((callFnByte >> 6) & 1) << 1) | (((callFnByte >> 7) & 1) << 2);

      // Validate modn0 — its low 5 bits must be 0x05 (mod-modes category
      // tag b0=1 b1=0 b2=1 b3=0 + b4=0 category marker).
      const modn0 = state.buf[2];
      if ((modn0 & 0x1F) !== 0x05) {
        // Not a valid mod-modes CM. Skip the sync byte and resync.
        state.buf = state.buf.subarray(1);
        continue;
      }

      // Walk the buffer collecting octets until we hit a clear
      // terminator (sync byte / 0x00) or run out.
      const octets = [];
      let i = 2;
      while (i < state.buf.length && octets.length < 6) {
        const v = state.buf[i];
        if (v === V8_BYTE_CMJM_SYNC || v === 0x00) {
          // Clear terminator — this CM is definitely done.
          break;
        }
        octets.push(v);
        i++;
      }

      // Decide whether we have enough information to emit. Two cases
      // signal "this CM is complete":
      //   (a) we hit a terminator (sync/0x00) — definitely complete.
      //   (b) we read 4+ candidate octets without hitting a terminator
      //       — modn0 + modn1 + modn2 max is 3; a 4th non-terminator
      //       byte means we've seen everything modn0..modn2 could be
      //       and then some.
      const hitTerminator =
        i < state.buf.length &&
        (state.buf[i] === V8_BYTE_CMJM_SYNC || state.buf[i] === 0x00);
      const sawEnoughOctets = octets.length >= 4;

      if (!hitTerminator && !sawEnoughOctets) {
        // Need more data. Don't emit yet; leave buffer intact.
        return msgs;
      }

      // Trim to at most 3 mod-modes octets (modn0 + modn1 + modn2).
      // Anything past index 3 was just our look-ahead lookahead byte —
      // not part of this CM.
      while (octets.length > 3) octets.pop();
      // Recompute consume count: sync + callfn + actual octets used.
      const consume = 2 + octets.length;

      const modes = decodeModesFromBytes(octets);
      modes.callFn = callFn;
      // Snapshot the raw bytes that comprised this CM/JM so callers
      // can compare across consecutive messages (V.8 §7.4 requires
      // two byte-identical CMs/JMs before acting).
      const rawBytes = Buffer.from(state.buf.subarray(0, consume));
      msgs.push({ type: 'CM/JM', callFn, modes, bytes: rawBytes });
      state.buf = state.buf.subarray(consume);
      continue;
    }

    // Unknown byte at start — could be a desync, or a trailing byte
    // from a truncated message. Skip one byte and continue.
    state.buf = state.buf.subarray(1);
  }

  return msgs;
}

/** Decode modes from modulation-modes byte sequence (LSB-first byte values). */
function decodeModesFromBytes(octets) {
  const modes = {
    v34: false, v34hd: false, pcm: false,
    v32bis: false, v22bis: false, v17: false, v29hd: false, v27ter: false,
    v26ter: false, v26bis: false, v23: false, v23hd: false, v21: false,
  };
  if (octets.length === 0) return modes;

  const modn0 = octets[0];
  // modn0 format (LSB-first byte bits): b0=1 b1=0 b2=1 b3=0 b4=0 b5=pcm b6=v34 b7=v34hd
  //   expected low 5 bits = 0b00101 = 0x05
  if ((modn0 & 0x1F) === 0x05) {
    modes.pcm   = !!(modn0 & 0x20);
    modes.v34   = !!(modn0 & 0x40);
    modes.v34hd = !!(modn0 & 0x80);
  }

  if (octets.length >= 2) {
    const modn1 = octets[1];
    // Extension octet format: b3=0 b4=1 b5=0, bits 3-5 in byte = 0b010
    //   byte & 0x38 should equal 0x10
    if ((modn1 & 0x38) === 0x10) {
      modes.v32bis = !!(modn1 & 0x01);
      modes.v22bis = !!(modn1 & 0x02);
      modes.v17    = !!(modn1 & 0x04);
      modes.v29hd  = !!(modn1 & 0x40);
      modes.v27ter = !!(modn1 & 0x80);
    }
  }

  if (octets.length >= 3) {
    const modn2 = octets[2];
    if ((modn2 & 0x38) === 0x10) {
      modes.v26ter = !!(modn2 & 0x01);
      modes.v26bis = !!(modn2 & 0x02);
      modes.v23    = !!(modn2 & 0x04);
      modes.v23hd  = !!(modn2 & 0x40);
      modes.v21    = !!(modn2 & 0x80);
    }
  }

  return modes;
}


module.exports = {
  // Constants
  V8_SYNC_CI, V8_SYNC_CM_JM,
  V8_TAG_CALL_FN, V8_TAG_MOD_MODES,
  V8_CALLFN_DATA,

  // Bit-level builders (for raw-bit V.21 or analysis)
  buildCI,
  buildCMorJM,
  buildCJ,
  buildCallFunctionOctet,
  buildModulationModesOctets,
  packCategoryOctet,
  packExtensionOctet,

  // Byte-level API (for use with UART-framed V.21 .write(bytes) / 'data' events)
  buildCIBytes,
  buildCMBytes,
  buildJMBytes,
  buildCJBytes,
  parseV8Bytes,

  // Decoder
  V8Decoder,
  decodeModes,
  selectProtocol,
};

// ═══════════════════════════════════════════════════════════════════════════
// Self-tests (run with: node V8.js)
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  let pass = 0, fail = 0;
  function check(label, ok, extra = '') {
    if (ok) { pass++; console.log('  PASS  ' + label); }
    else    { fail++; console.log('  FAIL  ' + label + (extra ? ': ' + extra : '')); }
  }

  console.log('\n═══ V.8 self-test ═══\n');

  // Test 1: call-function octet format
  console.log('Test 1: call-function octet (Data = "011" option bits)');
  const callFn = buildCallFunctionOctet();
  //   start  b0  b1  b2  b3  b4  b5  b6  b7  stop
  //    0     1   0   0   0   0   0   1   1    1
  const expected = [0, 1, 0, 0, 0, 0, 0, 1, 1, 1];
  const ok = callFn.length === 10 && callFn.every((b, i) => b === expected[i]);
  check('call-fn data octet matches spec Table 3',
        ok, 'got ' + callFn.join(''));

  // Test 2: modulation-modes octet for V.32bis-only capability
  console.log('\nTest 2: modulation-modes octet for {v32bis}');
  const mm = buildModulationModesOctets({ v32bis: true });
  // modn0: tag=1010 (b0=1,b1=0,b2=1,b3=0), b4=0, b5=0 (no pcm), b6=0 (no v34), b7=0 (no v34hd)
  //   start b0 b1 b2 b3 b4 b5 b6 b7 stop
  //    0    1  0  1  0  0  0  0  0  1
  // modn1: b3=0, b4=1, b5=0. Extension bits: b0=1 (v32bis), b1=0, b2=0, b6=0, b7=0
  //   start b0 b1 b2 b3 b4 b5 b6 b7 stop
  //    0    1  0  0  0  1  0  0  0  1
  const expMm = [
    0, 1, 0, 1, 0, 0, 0, 0, 0, 1,
    0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
  ];
  const okMm = mm.length === 20 && mm.every((b, i) => b === expMm[i]);
  check('mod-modes {v32bis} produces modn0+modn1 matching Table 4',
        okMm, 'got ' + mm.join(''));

  // Test 3: full CM sequence structure
  console.log('\nTest 3: full CM sequence');
  const cm = buildCMorJM({ v32bis: true, v22bis: true, v21: true });
  // Expect: 10 ones + 10 sync CM/JM + callfn (10) + modn0 (10) + modn1 (10) + modn2 (10) = 60 bits
  check('CM length = 60 bits', cm.length === 60, 'got ' + cm.length);
  // Preamble check
  check('CM first 10 bits are all 1', cm.slice(0, 10).every(b => b === 1));
  const syncExpected = V8_SYNC_CM_JM.split('').map(c => c === '1' ? 1 : 0);
  check('CM sync bits (positions 10-19) match "0000001111"',
        cm.slice(10, 20).every((b, i) => b === syncExpected[i]));

  // Test 4: CJ sequence
  console.log('\nTest 4: CJ terminator');
  const cj = buildCJ();
  check('CJ length = 30 bits (3 octets × 10 bits each)', cj.length === 30);
  // Each 10-bit group should be [0, 0,0,0,0,0,0,0,0, 1]
  let cjOk = true;
  for (let g = 0; g < 3; g++) {
    const grp = cj.slice(g * 10, g * 10 + 10);
    if (grp[0] !== 0 || grp[9] !== 1) cjOk = false;
    for (let i = 1; i <= 8; i++) if (grp[i] !== 0) cjOk = false;
  }
  check('CJ 3 octets all-zero with framing', cjOk);

  // Test 5: decode round-trip
  console.log('\nTest 5: encode-then-decode CM round-trip');
  const modesIn = { v32bis: true, v22bis: true, v21: true };
  const encoded = buildCMorJM(modesIn);
  const dec = new V8Decoder();
  let msg = null;
  for (const b of encoded) {
    const m = dec.feed(b);
    if (m) msg = m;
  }
  // End of input — flush whatever's pending.
  if (!msg) msg = dec.finish();
  check('decoder produced a message', msg !== null);
  if (msg) {
    check('message type = CM/JM', msg.type === 'CM/JM');
    const parsedModes = decodeModes(msg.octets);
    check('decoded v32bis = true', parsedModes.v32bis === true);
    check('decoded v22bis = true', parsedModes.v22bis === true);
    check('decoded v21 = true', parsedModes.v21 === true);
    check('decoded v34 = false (not advertised)', parsedModes.v34 === false);
    // callFn value depends on how we number the b5-b7 bits. For "Data"
    // the option pattern is b5=0, b6=1, b7=1. We store these as
    // (b5<<0)|(b6<<1)|(b7<<2) = 0 | 2 | 4 = 6. So we expect 6.
    check('decoded callFn = 6 (b5=0 b6=1 b7=1 for Data)', parsedModes.callFn === 6);
  }

  // Test 6: protocol selection
  console.log('\nTest 6: protocol selection from CM modes');
  const remoteModes = { v32bis: true, v22bis: true, v21: true };
  const preference = ['V34', 'V32bis', 'V22bis', 'V22', 'V21'];
  const chosen = selectProtocol(remoteModes, preference);
  check('V.32bis selected when both sides support V.32bis + V.22bis + V.21',
        chosen === 'V32bis', 'got ' + chosen);

  const remote2 = { v22bis: true, v21: true };
  check('V.22bis selected when no V.32bis',
        selectProtocol(remote2, preference) === 'V22bis');

  // Test 7: byte-level CI builder
  console.log('\nTest 7: byte-level CI builder');
  const ciBytes = buildCIBytes();
  check('CI byte length = 2', ciBytes.length === 2);
  check('CI byte[0] = 0x00 (sync)', ciBytes[0] === 0x00);
  check('CI byte[1] = 0xC1 (call-fn Data)', ciBytes[1] === 0xC1);

  // Test 8: byte-level CM builder
  console.log('\nTest 8: byte-level CM builder for V.32bis+V.22bis+V.21');
  const cmBytes = buildCMBytes({ v32bis: true, v22bis: true, v21: true });
  //   0xE0 = sync
  //   0xC1 = call-fn Data
  //   0x05 = modn0 (no PCM, no V.34, no V.34hd)
  //   0x13 = modn1 (v32bis + v22bis, b4=1 extension marker)
  //   0x90 = modn2 (v21, b4=1)
  const cmExpected = [0xE0, 0xC1, 0x05, 0x13, 0x90];
  const cmOk = cmBytes.length === 5 &&
               cmExpected.every((v, i) => cmBytes[i] === v);
  check('CM bytes = [E0, C1, 05, 13, 90]', cmOk,
        'got ' + Array.from(cmBytes).map(b => b.toString(16).padStart(2,'0')).join(' '));

  // Test 9: byte-level CJ builder
  console.log('\nTest 9: byte-level CJ builder');
  const cjBytes = buildCJBytes();
  check('CJ bytes = [00, 00, 00]',
        cjBytes.length === 3 && cjBytes[0] === 0 && cjBytes[1] === 0 && cjBytes[2] === 0);

  // Test 10: parseV8Bytes end-to-end round-trip
  console.log('\nTest 10: parseV8Bytes round-trip on CI + CM + CJ sequence');
  const state = {};
  // Build a stream of CI, then CM, then CJ bytes.
  const stream = Buffer.concat([
    buildCIBytes(),
    buildCMBytes({ v32bis: true, v21: true }),
    buildCJBytes(),
  ]);
  const msgs = parseV8Bytes(state, stream);
  check('parsed 3 messages (CI + CM + CJ)', msgs.length === 3,
        'got ' + msgs.length);
  if (msgs.length === 3) {
    check('msg[0].type === CI', msgs[0].type === 'CI');
    check('msg[1].type === CM/JM', msgs[1].type === 'CM/JM');
    check('msg[1].modes.v32bis === true', msgs[1].modes && msgs[1].modes.v32bis === true);
    check('msg[1].modes.v21 === true', msgs[1].modes && msgs[1].modes.v21 === true);
    check('msg[1].modes.v22bis === false', msgs[1].modes && msgs[1].modes.v22bis === false);
    check('msg[2].type === CJ', msgs[2].type === 'CJ');
  }

  // Test 11: parseV8Bytes handles partial buffer reassembly
  console.log('\nTest 11: parseV8Bytes handles byte-at-a-time streaming');
  const state2 = {};
  const allMsgs = [];
  for (const b of stream) {
    const got = parseV8Bytes(state2, Buffer.from([b]));
    for (const m of got) allMsgs.push(m);
  }
  check('streaming produces same 3 messages', allMsgs.length === 3,
        'got ' + allMsgs.length + ' messages');

  console.log('\n───────────────────────────────────────');
  console.log(` SUMMARY: ${pass} pass, ${fail} fail`);
  console.log('───────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}