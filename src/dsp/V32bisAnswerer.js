// ─── V.32bis answer-mode sequencer ───────────────────────────────────────
//
// Implements the ITU-T V.32bis §5.2 answer-mode call-establishment and
// training sequence, emitting samples at 8000 Hz and consuming received
// samples for phase tracking and (later) rate-signal decoding.
//
// Not a full modem: the data phase (B1 = scrambled ones at chosen rate,
// trellis-coded if applicable) is delegated back to spandsp's V.17 TX.
// What lives here is everything from the end of ANS to the start of B1.
//
// Phases (TX):
//   AC_WAIT_AA       — transmit AC, wait for 1800 Hz AA ≥ 64T AND AC ≥ 128T
//   CA_WAIT_REV      — transmit CA, wait for one phase reversal in caller's 1800 Hz
//   CA_PENDING_RETURN— still CA until turnaround sample (64T after reversal)
//   SIG_S            — transmit S segment 1: ABAB for 256T
//   SIG_S_MINUS      — transmit S segment 2: CDCD for 16T
//   SIG_TRN          — transmit TRN: 1280T of scrambled ones, dibits→ABCD direct
//   SIG_R1           — transmit R1: repeated 16-bit rate signal, dibits→ABCD
//                      until caller's R2 detected (or timeout)
//   SIG_S_2          — second round: 256T ABAB
//   SIG_S_MINUS_2    — second round: 16T CDCD
//   SIG_TRN_2        — second round: 1280T TRN
//   SIG_R3           — transmit R3: rate confirmation, until caller's E detected
//   SIG_E            — transmit E: single 16-bit E sequence
//   DONE             — complete; host should hand off to V.17 TX for B1
//
// Constellation (V.32bis §5.2.3 and spandsp's abcd_constellation):
//   A = (-6, -2)   C = ( 6,  2)    (180° apart — used for AA/CC/AC/CA)
//   B = ( 2, -6)   D = (-2,  6)    (180° apart, 90° from A/C)
// Scaled by AMP/|A| for audio amplitude consistency.
//
// Modulation: each symbol is emitted as
//   y(t) = I*cos(2π·fc·t) − Q*sin(2π·fc·t)
// at 1800 Hz carrier, 2400 baud. Symbol period in samples = 10/3; we use
// a fractional accumulator to land symbol boundaries at integer sample
// indices (spreading 10 audio samples across 3 symbols).
//
// Pulse shaping: for now we omit the RRC filter and emit raw rectangular
// symbols. The AC/CA spectrum we already produce (peaks at 600/3000 Hz,
// null at 1800 Hz) matched what real modems expected in the first live
// capture. For S/S−/TRN/R1 the signal will be richer; real modems' RRC
// matched-filter receivers tolerate our extra out-of-band energy.
//
// Scrambler (V.32 §4.1, answerer TX):
//   polynomial x^23 + x^5 + 1, self-synchronizing
//   out = in XOR reg[4] XOR reg[22]
//   reg ← (reg << 1) | out
//   initial reg = 0x2ECDD5
//
// Rate signal framing (V.32bis §5.3):
//   16-bit pattern, bit 15..0. Sync bits 15, 11, 7, 3 are always 1.
//   Bit 0 = 0 → R signal (R1/R2/R3).
//   Bit 0 = 1 → E signal.
//   Rate capability bits:
//     bit 12 = 14400, bit 10 = 12000, bit 9 = 9600, bit 6 = 7200, bit 5 = 4800
//   Pattern with all rates: 0x8880 | 0x1000 | 0x0400 | 0x0200 | 0x0040 | 0x0020
//                         = 0x9EE0   (R1 all-rates)
//   E at rate 14400: 0x8880 | 0x1000 | 0x0001 = 0x9881
//
// 16 bits → 8 dibits (MSB first) → 8 symbols at 2400 baud = ~3.33 ms per
// 16-bit sequence. R1/R3 are repeated; E is sent ONCE.

const SR = 8000;

// ── constellation (full amplitude; scaled when emitting) ────────────────
// Points chosen to match spandsp's abcd_constellation. Unit magnitude
// factor: |A| = √(36+4) = √40; we scale so that output magnitude ≈ amp.
const ABCD_SCALE = 1 / Math.sqrt(40);
const STATE_A = { i: -6 * ABCD_SCALE, q: -2 * ABCD_SCALE };
const STATE_B = { i:  2 * ABCD_SCALE, q: -6 * ABCD_SCALE };
const STATE_C = { i:  6 * ABCD_SCALE, q:  2 * ABCD_SCALE };
const STATE_D = { i: -2 * ABCD_SCALE, q:  6 * ABCD_SCALE };
const STATES = [STATE_A, STATE_B, STATE_C, STATE_D];  // indices 0..3

// Dibit (MSB LSB) → state index, per V.32bis §5.2.3 (direct, no diff enc)
// The spec defines dibits encoding to states for R and TRN signals with
// "dibits encoded directly to states A, B, C and D". Natural order:
//   00 → A, 01 → B, 10 → C, 11 → D.
function dibitToState(dibit) {
  return STATES[dibit & 3];
}

// ── TX root-raised-cosine pulse shaper ──────────────────────────────────
// Polyphase RRC filter from spandsp/src/v17_v32bis_tx_rrc.h.
// 10 phases (rows) × 9 taps (cols). Structure: at each 8 kHz output we
// pick a polyphase row and convolve with the last 9 complex symbols.
//
// This replaces our previous rectangular-pulse TX which had excess
// out-of-band energy. Real V.32bis modem receivers expect RRC-shaped
// spectra centered at 1800 Hz with rolloff covering ±1200 Hz sidebands.
const TX_RRC = [
  [-0.0028949626, -0.0180558777,  0.0644370035, -0.1680546392,  0.6136030985,  0.6136030984, -0.1680546392,  0.0644370034, -0.0180558778],
  [ 0.0031457248, -0.0296755147,  0.0821538018, -0.1948071696,  0.7563219631,  0.4608861941, -0.1273859915,  0.0418434579, -0.0059021774],
  [ 0.0095859909, -0.0389394472,  0.0918555210, -0.2016880234,  0.8793516917,  0.3081345068, -0.0792085179,  0.0176601554,  0.0051283325],
  [ 0.0153896883, -0.0441001646,  0.0909724653, -0.1838386340,  0.9741012686,  0.1647552955, -0.0297442724, -0.0050682341,  0.0137350940],
  [ 0.0194884088, -0.0437412561,  0.0779044330, -0.1380831560,  1.0338274098,  0.0388498604,  0.0155354801, -0.0238603979,  0.0191007894],
  [ 0.0209425252, -0.0370198693,  0.0523524602, -0.0633894605,  1.0542286891, -0.0633894606,  0.0523524602, -0.0370198693,  0.0209425251],
  [ 0.0191007894, -0.0238603978,  0.0155354801,  0.0388498605,  1.0338274098, -0.1380831561,  0.0779044330, -0.0437412561,  0.0194884087],
  [ 0.0137350940, -0.0050682341, -0.0297442724,  0.1647552955,  0.9741012686, -0.1838386340,  0.0909724652, -0.0441001646,  0.0153896883],
  [ 0.0051283326,  0.0176601554, -0.0792085179,  0.3081345069,  0.8793516917, -0.2016880235,  0.0918555209, -0.0389394473,  0.0095859909],
  [-0.0059021774,  0.0418434580, -0.1273859915,  0.4608861942,  0.7563219631, -0.1948071696,  0.0821538018, -0.0296755147,  0.0031457248],
];

// Carrier-carrier sign flipping for AC/CA: we treat this as alternating
// between state A (sign=+1) and state C (sign=-1) with amp=1 on a single-
// axis (we still emit full complex samples but the Q component handles
// itself via the constellation offset).

class V32bisAnswerer {
  constructor(opts = {}) {
    this._log = opts.log || { info: () => {}, warn: () => {}, trace: () => {} };
    this._amp = opts.amp || 0.20;
    this._txPower = opts.txPower || 0.20;

    // Carrier-phase accumulator for 1800 Hz
    this._carrierPhase = 0;
    this._carrierInc   = 2 * Math.PI * 1800 / SR;

    // Fractional symbol accumulator. 10/3 samples per symbol.
    this._symPeriod = SR / 2400;
    this._symAccum  = 0;

    // Current symbol (complex constellation point).
    this._curSym = STATE_A;
    // Symbol emission count since state entry (for segment-length tracking).
    this._symCount = 0;
    // Sample counter for overall TX (used for turnaround timing).
    this._sampleIdx = 0;

    // ─── RRC pulse shaper (TX) ─────────────────────────────────────────
    // Polyphase root-raised-cosine filter from spandsp v17_v32bis_tx_rrc.h.
    // 10 phases × 9 taps. Structure: at 24 kHz effective rate we'd run
    // one filter per sample, decimated by 3 to 8 kHz. Equivalent: at each
    // 8 kHz output sample, pick phase row (idx*3) % 10 and convolve with
    // last 9 symbols (complex I/Q).
    //
    // History: 9-symbol FIFO of complex values. When we "advance to new
    // symbol" we shift this FIFO by one slot and insert new symbol.
    //
    // At each output sample: apply current polyphase row to FIFO contents
    // → baseband I/Q → mix to 1800 Hz passband.
    this._rrcTaps = TX_RRC;
    this._rrcHistI = new Float32Array(9);   // 9-symbol history (I)
    this._rrcHistQ = new Float32Array(9);   // 9-symbol history (Q)
    this._rrcHistIdx = 0;                   // position where next symbol enters
    this._rrcPhaseIdx = 0;                  // current polyphase row index (0..9)
    // Symbol-time tracking for RRC: we feed new symbols to the filter at
    // the symbol rate, and step the polyphase phase row at output rate.
    // Since 10 phases / 3 samples-decimated = 3.333 phases per output
    // sample, we'll advance phase by 3 each sample but also need to
    // shift a new symbol in when phase wraps past 10.
    this._rrcSamplesInSym = 0;   // counter: 10 means one whole symbol has passed

    // Symbol-level phase machine state.
    // Phase machine initial state.
    // AC_PROBE is a pre-phase we added based on empirical capture analysis:
    // real V.32bis callers respond to pure 1800 Hz energy, not to our AC
    // spectrum (which has a null at 1800 Hz). We emit pure Tone A (state A
    // continuously = pure 1800 Hz carrier) for up to AC_PROBE_TIMEOUT_MS
    // to give the caller a clear wake-up signal. On caller-AA detection,
    // we transition into AC_WAIT_AA → CA_WAIT_REV → etc. as per spec.
    //
    // If no caller AA appears within probe timeout, we give up.
    this._phase = 'AC_PROBE';
    this._acProbeSymbolMin = 2400 * 3;   // 3 s worth of probe symbols = 7200
    this._acProbeTimedOut = false;

    // AC/CA sub-state.
    this._acParity = 0;              // 0 → A next, 1 → C next (for AC)
    this._caParity = 0;              // 0 → C next, 1 → A next (for CA)
    this._symbolsInPhase = 0;

    // RX: 1800 Hz Goertzel for phase tracking.
    //
    // Threshold design:
    //   Our own TX AC has a 1800 Hz null at RMS ~0.0002 (with RRC), so echo
    //   pickup should be negligible. But line noise and residual from our
    //   ANS tone (2100 Hz) can spill into adjacent Goertzel bins. Live
    //   capture showed noise mag in the 0.0005-0.001 range and real
    //   caller AA mag in the 0.08-0.10 range — a 100x gap.
    //
    //   Setting threshold at 0.04 (40x noise floor, well below real AA)
    //   gives a huge margin against false positives and still fires on
    //   even weak remote signals.
    //
    // Also require 20 consecutive blocks (128T = 53ms of real signal),
    // not 10. Real caller's AA lasts hundreds of ms, so 128T is still
    // fast. This gives strong double-filter: 0.04 threshold plus 53ms
    // duration to rule out transient noise.
    this._rxBlockSize = 24;
    this._rxBuf       = new Float32Array(0);
    this._rxToneMagMin= 0.04;             // raised from 0.02 — noise was occasionally hitting 0.02
    this._rxAaLockBlocks = 20;            // raised from 10 — require ~53ms sustained
    this._rxConsecTone = 0;
    this._rxPhaseRef  = null;
    this._rxDriftPerBlock = null;
    this._rxRevThresh = 90;
    this._rxRevConfirming = false;
    this._rxRevCandidateRef = null;
    this._rxReversalsSeen = 0;
    // Diagnostic: track peak 1800 Hz magnitude observed during AC_WAIT_AA
    // so that even if we time out we know what the RX actually contained.
    this._rxPeakMag       = 0;
    this._rxBlockCount    = 0;
    this._rxLastLoggedAt  = 0;

    // Turnaround timing for CA→AC transition.
    this._turnaroundAtSymbol = null;

    // Scrambler (for TRN and other scrambled payloads).
    // Polynomial x^23 + x^5 + 1; out = in XOR reg[4] XOR reg[22].
    this._scrambleReg = 0x2ECDD5;

    // Rate-signal framing.
    this._rateSig16   = 0x9EE0;       // R1 all-rates; recomputed later as needed
    this._eSig16      = 0x9881;       // E @ 14400
    this._rateBitIdx  = 0;            // 0..15 within current 16-bit pattern
    this._rateReps    = 0;            // count of complete 16-bit patterns emitted
    // Rate-signal timeout: 16 bits = 8 dibits = 8 symbols per rep at 2400
    // baud = 3.33 ms per rep. Real V.32bis callers may take multiple
    // seconds to start emitting R2 because they're still training their
    // own equalizer during TRN. Old value (30 reps = 100ms) was way too
    // short and caused us to time out while the caller was still training.
    // Allow up to ~3 seconds of R1 transmission before giving up.
    this._rateMaxReps = 900;          // ~3 seconds at 3.33 ms/rep

    // ─── R-signal demodulation (caller's R2/R3/E coming back to us) ──────
    // Once we're in R1 or R3, we demodulate incoming audio at 1800 Hz,
    // apply a matched filter (boxcar over symbol period), classify each
    // symbol into A/B/C/D, map to 2 bits, and look for sync pattern.
    //
    // The matched filter is a boxcar integrator over a 4-sample window
    // (1 symbol period ≈ 3.33 samples, plus a little for overlap). We
    // step the integrator every sample but only sample at symbol rate.
    this._rxDemodEnabled    = false;
    this._rxDemodCarrierPh  = 0;       // 1800 Hz carrier phase
    this._rxDemodSymPeriod  = SR / 2400;
    this._rxDemodSymAccum   = 0;       // fractional symbol accumulator
    // Boxcar filter buffers (for matched filtering over symbol period).
    // Use 4 taps ≈ one full symbol at 10/3 samples/sym (round up).
    this._rxDemodBoxLen     = 4;
    this._rxDemodBoxI       = new Float32Array(this._rxDemodBoxLen);
    this._rxDemodBoxQ       = new Float32Array(this._rxDemodBoxLen);
    this._rxDemodBoxIdx     = 0;
    this._rxDemodBitShift   = 0;
    this._rxDemodSymCount   = 0;
    // Debounce state for R-signal sync detection (see _checkRsigSync).
    this._syncKeyLast       = {};
    // We need to know the 1800 Hz carrier phase reference to coherently
    // demodulate incoming QAM. We use the phase we locked during AC/CA.
    // Store it here; _onRxBlock will stash the latest known value.
    this._rxDemodCarrierRef = null;

    // Events: listeners for phase transitions and handoff.
    this._listeners = {};

    // Segment-length constants (symbols).
    this.LEN_S      = 256;
    this.LEN_S_MINUS= 16;
    this.LEN_TRN    = 1280;

    // Done flag for handoff.
    this._done = false;
    this._finalRate = 14400;           // chosen rate for B1 handoff
  }

  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
  }
  emit(event, ...args) {
    for (const fn of (this._listeners[event] || [])) fn(...args);
  }

  isDone() { return this._done; }
  phase()  { return this._phase; }
  finalRate() { return this._finalRate; }

  // ─── scrambler ─────────────────────────────────────────────────────────
  _scramble(inBit) {
    const reg = this._scrambleReg;
    const outBit = (inBit ^ (reg >> 4) ^ (reg >> 22)) & 1;
    this._scrambleReg = ((reg << 1) | outBit) & 0x7FFFFF;  // 23-bit
    return outBit;
  }

  // ─── symbol source ─────────────────────────────────────────────────────
  // Produce the next constellation symbol based on current phase.
  _nextSymbol() {
    const phase = this._phase;

    // PROBE: emit pure Tone A (state A) = continuous 1800 Hz at caller's
    // listening frequency. This is how we trigger the caller to start
    // transmitting its own AA. Real V.32bis callers respond to pure 1800
    // Hz presence, not to our AC spectrum (which has a 1800 Hz null).
    if (phase === 'AC_PROBE') {
      return STATE_A;
    }
    // AC_WAIT_AA: per V.32 spec §5.2.1, answerer transmits "signal A"
    // which is the constellation point A transmitted continuously (NOT
    // alternating A/C). At 2400 baud with the same point every symbol,
    // this produces a pure 1800 Hz carrier at a fixed phase. The
    // "reversal" to signal C is a literal 180° phase flip.
    //
    // We previously emitted alternating A,C,A,C which produces a
    // 600+3000 Hz spectrum with a NULL at 1800 Hz — completely wrong.
    // That's why callers lost track of us after PROBE.
    if (phase === 'AC_WAIT_AA') {
      return STATE_A;
    }
    // CA_WAIT_REV / CA_PENDING_RETURN: transmit "signal C" continuously.
    // Same pure 1800 Hz carrier as signal A but with 180° phase inversion.
    // The transition from A→C (AC_WAIT_AA → CA_WAIT_REV) is the spec-
    // defined reversal the caller is looking for.
    if (phase === 'CA_WAIT_REV' || phase === 'CA_PENDING_RETURN') {
      return STATE_C;
    }
    // S segment 1 / second round: alternate A, B, A, B, ... (spec §5.2.2)
    if (phase === 'SIG_S' || phase === 'SIG_S_2') {
      const sym = (this._symbolsInPhase & 1) === 0 ? STATE_A : STATE_B;
      return sym;
    }
    // S− segment 2 / second round: alternate C, D, C, D, ...
    if (phase === 'SIG_S_MINUS' || phase === 'SIG_S_MINUS_2') {
      const sym = (this._symbolsInPhase & 1) === 0 ? STATE_C : STATE_D;
      return sym;
    }
    // TRN: scrambled ones, dibit-encoded directly to ABCD per spec §5.2.3
    if (phase === 'SIG_TRN' || phase === 'SIG_TRN_2') {
      const b1 = this._scramble(1);
      const b0 = this._scramble(1);
      const dibit = (b1 << 1) | b0;
      return dibitToState(dibit);
    }
    // R1 / R3 / E: take next 2 bits of the 16-bit rate pattern MSB-first,
    // emit without scrambling (rate signals are unscrambled per spec).
    if (phase === 'SIG_R1' || phase === 'SIG_R3' || phase === 'SIG_E') {
      const pattern = (phase === 'SIG_E')
        ? this._eSig16
        : this._rateSig16;
      const b1 = (pattern >> (15 - this._rateBitIdx)) & 1;
      const b0 = (pattern >> (15 - this._rateBitIdx - 1)) & 1;
      const dibit = (b1 << 1) | b0;
      this._rateBitIdx += 2;
      if (this._rateBitIdx >= 16) {
        this._rateBitIdx = 0;
        this._rateReps++;
      }
      return dibitToState(dibit);
    }
    // DONE or unknown — emit zero.
    return { i: 0, q: 0 };
  }

  // ─── phase transition handler (called after each symbol emitted) ────────
  _onSymbolComplete() {
    // Once we've signaled done (either success or failure), stop processing
    // further phase transitions. Without this guard, a failed-state
    // answerer would re-trigger the R1 timeout branch on every subsequent
    // symbol because _rateReps keeps accumulating, producing log spam.
    if (this._done) return;

    this._symbolsInPhase++;
    this._symCount++;

    const phase = this._phase;

    // AC_PROBE: timeout if no caller AA detected within probe window.
    if (phase === 'AC_PROBE' && !this._acProbeTimedOut &&
        this._symbolsInPhase >= this._acProbeSymbolMin) {
      this._acProbeTimedOut = true;
      this._log.warn(`V.32bis: PROBE timeout — no caller AA detected after ${this._symbolsInPhase} symbols (${(this._symbolsInPhase/2400).toFixed(2)}s, peakMag=${this._rxPeakMag.toFixed(4)}, threshold=${this._rxToneMagMin}) — aborting handshake`);
      this._done = true;
      this.emit('failed', { reason: 'probe-timeout', peakMag: this._rxPeakMag });
      return;
    }

    // Check for transitions OUT of the current phase.
    if (phase === 'CA_PENDING_RETURN') {
      if (this._turnaroundAtSymbol !== null &&
          this._symCount >= this._turnaroundAtSymbol) {
        this._turnaroundAtSymbol = null;
        this._phase = 'SIG_S';
        this._symbolsInPhase = 0;
        this._log.info('V.32bis: CA→AC→S transition (turnaround complete, beginning Signal S ABAB)');
        this.emit('phase', { from: 'CA_PENDING_RETURN', to: 'SIG_S' });
      }
      return;
    }
    if (phase === 'SIG_S' && this._symbolsInPhase >= this.LEN_S) {
      this._phase = 'SIG_S_MINUS';
      this._symbolsInPhase = 0;
      this._log.info(`V.32bis: S (${this.LEN_S}T) → S− (CDCD, ${this.LEN_S_MINUS}T)`);
      this.emit('phase', { from: 'SIG_S', to: 'SIG_S_MINUS' });
      return;
    }
    if (phase === 'SIG_S_MINUS' && this._symbolsInPhase >= this.LEN_S_MINUS) {
      this._phase = 'SIG_TRN';
      this._symbolsInPhase = 0;
      // Reset scrambler for TRN segment per spec §5.2.2: "The initial
      // state of the scrambler shall be all zeros, and a binary one
      // applied to the input for the duration of segment 3."
      this._scrambleReg = 0;
      this._log.info(`V.32bis: S− (${this.LEN_S_MINUS}T) → TRN (${this.LEN_TRN}T scrambled ones)`);
      this.emit('phase', { from: 'SIG_S_MINUS', to: 'SIG_TRN' });
      return;
    }
    if (phase === 'SIG_TRN' && this._symbolsInPhase >= this.LEN_TRN) {
      this._phase = 'SIG_R1';
      this._symbolsInPhase = 0;
      this._rateBitIdx = 0;
      this._rateReps = 0;
      this._log.info(`V.32bis: TRN (${this.LEN_TRN}T) → R1 (rate signal, 0x${this._rateSig16.toString(16)})`);
      this.emit('phase', { from: 'SIG_TRN', to: 'SIG_R1' });
      return;
    }
    if (phase === 'SIG_R1') {
      // R1 continues until we see caller's R2 from the bit-tap stream.
      // For now, if we've sent many reps without detecting R2, assume a
      // simplified caller that ignores rate negotiation, and just stop
      // after N reps. The real logic (detectR2FromBitTap) would transition
      // us out of this phase via _onR2Detected().
      if (this._rateReps >= this._rateMaxReps) {
        // Real timeout — caller never sent R2. This is a genuine handshake
        // failure; the caller isn't following V.32bis rate negotiation, or
        // isn't present anymore, or didn't like something about our S/S−/
        // TRN. Don't try to fake R2 — that just leaves the caller confused.
        // Abort and let the engine fall through.
        const reg = this._rxDemodBitShift || 0;
        const nearMiss = [];
        for (const [k, v] of Object.entries(this._syncKeyLast || {})) {
          if (v.score >= 2) nearMiss.push(`${k}(score=${v.score})`);
        }
        this._log.warn(`V.32bis: R1 timeout (${this._rateReps} reps = ${(this._rateReps * 16 / 2 / 2400).toFixed(2)}s) — no caller R2 received [demod reg=0x${reg.toString(16)}, near-miss=${nearMiss.join(',') || 'none'}] — aborting handshake`);
        this._done = true;
        this.emit('failed', { reason: 'r1-timeout-no-r2' });
      }
      return;
    }
    if (phase === 'SIG_S_2' && this._symbolsInPhase >= this.LEN_S) {
      this._phase = 'SIG_S_MINUS_2';
      this._symbolsInPhase = 0;
      this._log.info(`V.32bis: S_2 (${this.LEN_S}T) → S−_2 (${this.LEN_S_MINUS}T)`);
      this.emit('phase', { from: 'SIG_S_2', to: 'SIG_S_MINUS_2' });
      return;
    }
    if (phase === 'SIG_S_MINUS_2' && this._symbolsInPhase >= this.LEN_S_MINUS) {
      this._phase = 'SIG_TRN_2';
      this._symbolsInPhase = 0;
      this._scrambleReg = 0;
      this._log.info(`V.32bis: S−_2 → TRN_2 (${this.LEN_TRN}T)`);
      this.emit('phase', { from: 'SIG_S_MINUS_2', to: 'SIG_TRN_2' });
      return;
    }
    if (phase === 'SIG_TRN_2' && this._symbolsInPhase >= this.LEN_TRN) {
      this._phase = 'SIG_R3';
      this._symbolsInPhase = 0;
      this._rateBitIdx = 0;
      this._rateReps = 0;
      this._log.info(`V.32bis: TRN_2 → R3 (rate signal, 0x${this._rateSig16.toString(16)})`);
      this.emit('phase', { from: 'SIG_TRN_2', to: 'SIG_R3' });
      return;
    }
    if (phase === 'SIG_R3') {
      // R3 continues until caller's E detected. Fail on timeout instead of
      // faking E — if we haven't heard E from the caller, they haven't
      // agreed to the final rate and proceeding to data phase is just
      // going to produce garbage.
      if (this._rateReps >= this._rateMaxReps) {
        const reg = this._rxDemodBitShift || 0;
        const nearMiss = [];
        for (const [k, v] of Object.entries(this._syncKeyLast || {})) {
          if (v.score >= 2) nearMiss.push(`${k}(score=${v.score})`);
        }
        this._log.warn(`V.32bis: R3 timeout (${this._rateReps} reps = ${(this._rateReps * 16 / 2 / 2400).toFixed(2)}s) — no caller E received [demod reg=0x${reg.toString(16)}, near-miss=${nearMiss.join(',') || 'none'}] — aborting handshake`);
        this._done = true;
        this.emit('failed', { reason: 'r3-timeout-no-e' });
      }
      return;
    }
    if (phase === 'SIG_E') {
      // Single 16-bit E sequence = 8 symbols.
      if (this._symbolsInPhase >= 8) {
        this._phase = 'DONE';
        this._done = true;
        this._log.info(`V.32bis: E transmitted — handshake complete, ready for B1 data phase at ${this._finalRate} bps`);
        this.emit('done', { rate: this._finalRate });
      }
      return;
    }
  }

  // Called externally when caller's R2 is detected (e.g., by tapping bits).
  _onR2Detected(rate) {
    if (this._phase !== 'SIG_R1') return;
    this._finalRate = rate || 14400;
    this._phase = 'SIG_S_2';
    this._symbolsInPhase = 0;
    this._log.info(`V.32bis: R2 detected (rate=${rate}) — beginning second-round S`);
    this.emit('phase', { from: 'SIG_R1', to: 'SIG_S_2' });
  }
  // Called externally when caller's E is detected.
  _onEDetected() {
    if (this._phase !== 'SIG_R3') return;
    this._phase = 'SIG_E';
    this._symbolsInPhase = 0;
    this._rateBitIdx = 0;
    this._log.info('V.32bis: E detected from caller — transmitting our E');
    this.emit('phase', { from: 'SIG_R3', to: 'SIG_E' });
  }

  // ─── TX: generate audio samples with RRC pulse shaping ────────────────
  //
  // Polyphase filter structure: at each 8 kHz output we pick a polyphase
  // row (of 9 taps) and convolve it with the last 9 complex symbols in
  // our history buffer. The row index advances by 3 per output sample
  // (because 10 phases per symbol / decimation by 3 = step 3).
  //
  // When the accumulated phase steps past 10, we shift in a new symbol
  // (advance the FIFO) — this happens exactly once per symbol period
  // averaged (10/3 samples per symbol).
  //
  // The 9-tap filter straddles 9 consecutive symbols. Position 4 (index
  // 4 in 0..8) corresponds to the "current" symbol from a phase-0
  // perspective. With 9 taps and ideal RRC, the effective group delay
  // is 4 symbol periods ≈ 13.3 samples at 8 kHz ≈ 1.67 ms.
  generate(n) {
    const out = new Float32Array(n);
    const amp = this._amp;

    for (let i = 0; i < n; i++) {
      // Pick polyphase row and convolve with last 9 symbols.
      const row = this._rrcTaps[this._rrcPhaseIdx];
      let basebandI = 0, basebandQ = 0;
      // Taps in spandsp's file run centered; our history FIFO is
      // circular. Map tap k → symbol (histIdx + 8 - k) mod 9 (most
      // recent at offset 0, oldest at offset 8).
      // Actually the filter expects taps[0] × oldest symbol,
      // taps[8] × newest. Let's match spandsp's vec_circular_dot_prodf.
      // histIdx points at the next WRITE slot (oldest symbol).
      for (let k = 0; k < 9; k++) {
        const idx = (this._rrcHistIdx + k) % 9;
        basebandI += row[k] * this._rrcHistI[idx];
        basebandQ += row[k] * this._rrcHistQ[idx];
      }

      // Mix baseband to 1800 Hz passband: y = I·cos(φ) − Q·sin(φ)
      const cp = this._carrierPhase;
      out[i] = amp * (basebandI * Math.cos(cp) - basebandQ * Math.sin(cp));
      this._carrierPhase = cp + this._carrierInc;
      if (this._carrierPhase >= 2 * Math.PI) this._carrierPhase -= 2 * Math.PI;

      // Advance polyphase index by 3 modulo 10. When it wraps, shift in
      // a new symbol (FIFO advance).
      const newPhase = this._rrcPhaseIdx + 3;
      if (newPhase >= 10) {
        // New symbol boundary — shift in next symbol.
        this._rrcPhaseIdx = newPhase - 10;
        this._onSymbolComplete();
        this._curSym = this._nextSymbol();
        // Push into FIFO: overwrite oldest slot.
        this._rrcHistI[this._rrcHistIdx] = this._curSym.i;
        this._rrcHistQ[this._rrcHistIdx] = this._curSym.q;
        this._rrcHistIdx = (this._rrcHistIdx + 1) % 9;
      } else {
        this._rrcPhaseIdx = newPhase;
      }

      this._sampleIdx++;
    }
    return out;
  }

  // ─── RX: phase tracking for AC/CA handshake + R-signal demod ──────────
  process(samples) {
    // During probe/AC/CA: Goertzel 1800 Hz phase tracking.
    if (this._phase === 'AC_PROBE' ||
        this._phase === 'AC_WAIT_AA' ||
        this._phase === 'CA_WAIT_REV') {
      this._processAcCa(samples);
      return;
    }
    // During R-signal emission: demodulate caller's R-signals so we can
    // advance on their actual signaling (no long timeouts).
    if (this._phase === 'SIG_R1' || this._phase === 'SIG_R3') {
      this._processRsignal(samples);
      return;
    }
    // Other phases (CA_PENDING_RETURN, S, S−, TRN, SIG_E, DONE): no RX
    // processing here. Caller of V32bisAnswerer can still route samples
    // to spandsp V.17 RX for eventual B1 data decoding.
  }

  _processAcCa(samples) {
    const combined = new Float32Array(this._rxBuf.length + samples.length);
    combined.set(this._rxBuf, 0);
    combined.set(samples, this._rxBuf.length);

    const block = this._rxBlockSize;
    let offset = 0;
    while (combined.length - offset >= block) {
      const seg = combined.subarray(offset, offset + block);
      offset += block;
      let ci = 0, cq = 0;
      for (let j = 0; j < block; j++) {
        const ph = 2 * Math.PI * 1800 * j / SR;
        ci += seg[j] * Math.cos(ph);
        cq += seg[j] * -Math.sin(ph);
      }
      const mag = Math.sqrt(ci*ci + cq*cq) / (block / 2);
      const ang = Math.atan2(cq, ci) * 180 / Math.PI;
      this._onRxBlock(mag, ang);
    }
    this._rxBuf = combined.slice(offset);
  }

  // ─── R-signal demodulation ─────────────────────────────────────────────
  // Coherent QAM demod of caller's ABCD constellation at 1800 Hz carrier,
  // 2400 baud. Classifies each symbol by I/Q angle (4-point constellation),
  // maps to 2-bit dibit, shifts into 16-bit window, tests sync mask.
  //
  // Constellation angles (radians):
  //   A = atan2(-2, -6) ≈ -2.82  (-161.6°)
  //   B = atan2(-6, +2) ≈ -1.25  (-71.6°)
  //   C = atan2(+2, +6) ≈ +0.32  (+18.4°)
  //   D = atan2(+6, -2) ≈ +1.89  (+108.4°)
  //
  // Dibits per spec §5.2.3: 00→A, 01→B, 10→C, 11→D (MSB-first).
  //
  // Symbol timing: we don't have perfect alignment with caller's symbol
  // boundaries (round-trip delay + clock skew), but since we're looking
  // for a repeating 16-bit pattern with strong sync bits, the decoder is
  // tolerant. We integrate over one symbol period and classify.
  _processRsignal(samples) {
    if (!this._rxDemodEnabled) {
      this._rxDemodEnabled = true;
      this._rxDemodCarrierPh = 0;
      this._rxDemodSymAccum  = 0;
      this._rxDemodBoxI.fill(0);
      this._rxDemodBoxQ.fill(0);
      this._rxDemodBoxIdx = 0;
      this._rxDemodBitShift = 0;
      this._rxDemodSymCount = 0;
      this._syncKeyLast = {};
      this._log.info('V.32bis: R-signal demod started');
    }

    const carrierInc = 2 * Math.PI * 1800 / SR;
    const symPeriod  = this._rxDemodSymPeriod;
    const boxLen     = this._rxDemodBoxLen;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const c = Math.cos(this._rxDemodCarrierPh);
      const sn= Math.sin(this._rxDemodCarrierPh);

      // Push baseband sample into boxcar ring buffer.
      this._rxDemodBoxI[this._rxDemodBoxIdx] = s * c;
      this._rxDemodBoxQ[this._rxDemodBoxIdx] = s * -sn;
      this._rxDemodBoxIdx = (this._rxDemodBoxIdx + 1) % boxLen;

      this._rxDemodCarrierPh += carrierInc;
      if (this._rxDemodCarrierPh >= 2 * Math.PI) this._rxDemodCarrierPh -= 2 * Math.PI;

      this._rxDemodSymAccum += 1;
      if (this._rxDemodSymAccum >= symPeriod) {
        this._rxDemodSymAccum -= symPeriod;

        // Sum boxcar = integrate over last N samples (matched-filter-ish).
        let I = 0, Q = 0;
        for (let k = 0; k < boxLen; k++) {
          I += this._rxDemodBoxI[k];
          Q += this._rxDemodBoxQ[k];
        }
        I /= boxLen;
        Q /= boxLen;

        // Only classify once signal is strong enough (caller actually
        // sending R-signal). Threshold ~ half of expected amp.
        const mag = Math.sqrt(I*I + Q*Q);
        if (mag < 0.03) continue;

        // Classify into A/B/C/D by angle. Constellation centers (radians):
        //   A = -2.82 (−161.6°)
        //   B = -1.25 (−71.6°)
        //   C = +0.32 (+18.4°)
        //   D = +1.89 (+108.4°)
        // Decision boundaries are midway: A/B at −116.6°, B/C at −26.6°,
        // C/D at +63.4°, D/A at +153.4°.
        //
        // Cleanest way: rotate ang by −(center_angle − 45°) = −(18.4° − 45°)
        // = +26.6°. Then centers shift to −135°, −45°, +45°, +135° — the
        // quadrant bisectors. Classification is then just sign(I')·sign(Q')
        // after the rotation:
        //   Q' < 0, I' < 0 → A (quadrant III, -135°)
        //   Q' < 0, I' > 0 → B (quadrant IV, -45°)
        //   Q' > 0, I' > 0 → C (quadrant I, +45°)
        //   Q' > 0, I' < 0 → D (quadrant II, +135°)
        const ROT = +26.6 * Math.PI / 180;
        const cr = Math.cos(ROT), sr = Math.sin(ROT);
        const Ir = I * cr - Q * sr;
        const Qr = I * sr + Q * cr;
        let stateIdx;
        if      (Qr < 0 && Ir < 0) stateIdx = 0;  // A
        else if (Qr < 0 && Ir >= 0) stateIdx = 1; // B
        else if (Qr >= 0 && Ir >= 0) stateIdx = 2;// C
        else                         stateIdx = 3;// D

        // Shift 2 bits (MSB first) into the 16-bit window.
        const b1 = (stateIdx >> 1) & 1;
        const b0 = stateIdx & 1;
        this._rxDemodBitShift = (((this._rxDemodBitShift << 2) | (b1 << 1) | b0) & 0xFFFF);
        this._rxDemodSymCount++;

        // After 8 symbols (one full 16-bit word), test sync mask.
        // Check every symbol boundary (rolling) since phase is unknown.
        this._checkRsigSync();
      }
    }
  }

  _checkRsigSync() {
    const w = this._rxDemodBitShift;
    // Test all 8 possible rotations of the 16-bit word (shift reg position
    // relative to 16-bit word boundary is unknown because caller's symbol
    // clock isn't frame-aligned with ours).
    //
    // Debounce: a valid caller R-signal is the SAME 16-bit pattern
    // repeated for many words. Between consecutive words, the "rotation"
    // advances because we're sampling the shift register at every symbol
    // (not every 8 symbols). So a valid pattern will appear at rotation
    // r at sym N, rotation r-2 at sym N+1 (mod 16), ..., rotation r at
    // sym N+8. Equivalently: if we match at rot r at sym N, we should
    // match again at rot r at sym N+8 and sym N+16 and so on.
    //
    // Simplest-correct: track per-key the last symbol index where it
    // matched. If we see the same key within a window of [1, 12] symbols
    // ago (= within a reasonable range around the expected 8), count
    // toward that key's score. When score reaches REPS_NEEDED, fire.
    //
    // This debounces correctly: random false positives won't accumulate
    // consistently at a single key, but a genuine repeating pattern will.
    const REPS_NEEDED = 3;
    const WINDOW_MIN  = 1;
    const WINDOW_MAX  = 12;

    if (!this._syncKeyLast) this._syncKeyLast = {};

    for (let rot = 0; rot < 16; rot += 2) {
      const rotated = ((w >> rot) | (w << (16 - rot))) & 0xFFFF;
      const isRsig = (rotated & 0x888F) === 0x8880;
      const isEsig = (rotated & 0x888F) === 0x888F;
      if (!isRsig && !isEsig) continue;
      let rate = 4800;
      if      (rotated & 0x1000) rate = 14400;
      else if (rotated & 0x0400) rate = 12000;
      else if (rotated & 0x0200) rate = 9600;
      else if (rotated & 0x0040) rate = 7200;
      const kind = isRsig ? 'R' : 'E';
      const key = `${kind}:${rate}:${rot}`;
      const last = this._syncKeyLast[key] || { lastSym: -999, score: 0 };
      const gap = this._rxDemodSymCount - last.lastSym;
      if (gap >= WINDOW_MIN && gap <= WINDOW_MAX) {
        last.score++;
      } else {
        last.score = 1;
      }
      last.lastSym = this._rxDemodSymCount;
      this._syncKeyLast[key] = last;

      if (last.score >= REPS_NEEDED) {
        // Debounced fire.
        if (isRsig && this._phase === 'SIG_R1') {
          this._log.info(`V.32bis: caller R2 detected (pattern 0x${rotated.toString(16)}, rate=${rate}, rot=${rot}, reps=${last.score})`);
          this._syncKeyLast = {};
          this._onR2Detected(rate);
          return;
        }
        if (isEsig && this._phase === 'SIG_R3') {
          this._log.info(`V.32bis: caller E detected (pattern 0x${rotated.toString(16)}, rot=${rot}, reps=${last.score})`);
          this._syncKeyLast = {};
          this._onEDetected();
          return;
        }
      }
    }
  }

  _onRxBlock(mag, angleDeg) {
    this._rxBlockCount++;
    if (mag > this._rxPeakMag) this._rxPeakMag = mag;
    // Periodic diagnostic log during probe/AC phases so live captures show
    // us what the Goertzel is seeing even when we never lock.
    if ((this._phase === 'AC_PROBE' || this._phase === 'AC_WAIT_AA') &&
        this._rxBlockCount - this._rxLastLoggedAt >= 330) {   // ~1 sec
      this._log.info(`V.32bis: RX watch [${this._phase}] blocks=${this._rxBlockCount} peakMag=${this._rxPeakMag.toFixed(4)} currentMag=${mag.toFixed(4)} threshold=${this._rxToneMagMin}`);
      this._rxLastLoggedAt = this._rxBlockCount;
      this._rxPeakMag = 0;
    }
    const tonePresent = mag >= this._rxToneMagMin;
    if (!tonePresent) {
      if (this._phase === 'AC_PROBE' || this._phase === 'AC_WAIT_AA') this._rxConsecTone = 0;
      return;
    }
    this._rxConsecTone++;

    // AC_PROBE: we're emitting pure 1800 Hz (Tone A / AA). On detecting
    // caller's sustained 1800 Hz, transition to the formal AC-begin phase.
    // This is an additional "priming" step before the spec-defined AA lock.
    // Rationale: callers detect our TX 1800 Hz energy and begin AA; once
    // we see AA we start the real AC→CA→... sequence.
    if (this._phase === 'AC_PROBE') {
      if (this._rxConsecTone >= this._rxAaLockBlocks) {
        // Lock onto probe — caller's AA is present. Now switch to AC for
        // the spec-defined phase-reversal FSM.
        this._rxPhaseRef = angleDeg;
        this._rxDriftPerBlock = (360 * 1800 * this._rxBlockSize / SR) % 360;
        while (this._rxDriftPerBlock > 180)  this._rxDriftPerBlock -= 360;
        while (this._rxDriftPerBlock < -180) this._rxDriftPerBlock += 360;
        this._log.info(`V.32bis: PROBE — caller AA detected (tx ${this._symCount}T probe symbols, rx ${this._rxConsecTone} blocks, phase=${angleDeg.toFixed(1)}°) — switching to AC`);
        this._phase = 'AC_WAIT_AA';
        this._symbolsInPhase = 0;
        this._acParity = 0;
        this._rxConsecTone = 0;  // reset so AC_WAIT_AA gets its own count
        this.emit('phase', { from: 'AC_PROBE', to: 'AC_WAIT_AA' });
      }
      return;
    }

    if (this._phase === 'AC_WAIT_AA') {
      // Conditions: AC transmitted ≥128T, caller's 1800 Hz ≥64T (≈10 blocks).
      //
      // Note: _symbolsInPhase counts symbols INPUT to the RRC filter FIFO,
      // but the 9-tap RRC filter has a group delay of 4 symbol periods.
      // So when _symbolsInPhase=128, only 124 symbols have reached the
      // wire. Bump threshold by the filter delay to guarantee ≥128T on
      // the line. (Even-count requirement from spec is satisfied since
      // 128+4=132 is even.)
      const acSymbolsOk = this._symbolsInPhase >= 128 + 4;
      const aaBlocksOk  = this._rxConsecTone >= this._rxAaLockBlocks;
      if (acSymbolsOk && aaBlocksOk) {
        // Lock phase reference and transition to CA IMMEDIATELY (per spec:
        // switch to CA as soon as conditions met, no reversal needed).
        this._rxPhaseRef = angleDeg;
        this._rxDriftPerBlock = (360 * 1800 * this._rxBlockSize / SR) % 360;
        while (this._rxDriftPerBlock > 180)  this._rxDriftPerBlock -= 360;
        while (this._rxDriftPerBlock < -180) this._rxDriftPerBlock += 360;
        this._rxRevConfirming = false;
        this._rxRevCandidateRef = null;

        this._phase = 'CA_WAIT_REV';
        this._symbolsInPhase = 0;
        this._caParity = 0;
        this._log.info(`V.32bis: AA locked (tx ${this._symCount}T, rx ${this._rxConsecTone} blocks, phase=${angleDeg.toFixed(1)}°, drift=${this._rxDriftPerBlock.toFixed(1)}°/block) — switching TX to CA, watching for caller reversal`);
        this.emit('phase', { from: 'AC_WAIT_AA', to: 'CA_WAIT_REV' });
      }
      return;
    }

    if (this._phase === 'CA_WAIT_REV') {
      // Watch for single phase reversal in caller's 1800 Hz (their AA→CC
      // transition). Candidate+confirm pattern to reject noise.
      const expected = this._rxPhaseRef + this._rxDriftPerBlock;
      let delta = angleDeg - expected;
      while (delta > 180)  delta -= 360;
      while (delta < -180) delta += 360;

      if (!this._rxRevConfirming) {
        if (Math.abs(delta) > this._rxRevThresh) {
          this._rxRevConfirming = true;
          this._rxRevCandidateRef = angleDeg;
        } else {
          // Steady state — track phase ref forward with slow blend.
          this._rxPhaseRef = expected + 0.1 * delta;
          while (this._rxPhaseRef > 180)  this._rxPhaseRef -= 360;
          while (this._rxPhaseRef < -180) this._rxPhaseRef += 360;
        }
      } else {
        const candExpected = this._rxRevCandidateRef + this._rxDriftPerBlock;
        let candDelta = angleDeg - candExpected;
        while (candDelta > 180)  candDelta -= 360;
        while (candDelta < -180) candDelta += 360;
        if (Math.abs(candDelta) <= 45) {
          // Confirmed — this is the caller's AA→CC reversal.
          this._log.info(`V.32bis: caller phase reversal confirmed (delta=${delta.toFixed(1)}°, candidate=${candDelta.toFixed(1)}°) — scheduling CA→AC turnaround at 64T`);
          // Schedule turnaround: CA→AC transition at wire shall be 64T±2T
          // after the reception of the reversal. Symbol-count basis.
          this._turnaroundAtSymbol = this._symCount + 64;
          this._phase = 'CA_PENDING_RETURN';
          this._rxRevConfirming = false;
          this._rxRevCandidateRef = null;
          this.emit('phase', { from: 'CA_WAIT_REV', to: 'CA_PENDING_RETURN' });
        } else {
          // Not confirmed — false alarm.
          this._rxRevConfirming = false;
          this._rxRevCandidateRef = null;
          this._rxPhaseRef = expected + 0.1 * delta;
          while (this._rxPhaseRef > 180)  this._rxPhaseRef -= 360;
          while (this._rxPhaseRef < -180) this._rxPhaseRef += 360;
        }
      }
      return;
    }
  }

  // ─── R2/E detection from spandsp V.17 RX bit tap ────────────────────────
  // Call this with each descrambled bit produced by spandsp V.17 RX.
  // Looks for the 0x888F sync pattern; if found, checks bit 0 to classify
  // as R-signal or E-signal, extracts rate bits, triggers phase transition.
  feedRxBit(bit) {
    if (!this._rxBitShift) this._rxBitShift = 0;
    this._rxBitShift = ((this._rxBitShift << 1) | (bit & 1)) & 0xFFFF;
    // Sync mask test.
    if ((this._rxBitShift & 0x888F) === 0x8880) {
      // R-signal. Extract rate.
      const word = this._rxBitShift;
      let rate = 4800;
      if (word & 0x1000) rate = 14400;
      else if (word & 0x0400) rate = 12000;
      else if (word & 0x0200) rate = 9600;
      else if (word & 0x0040) rate = 7200;
      if (this._phase === 'SIG_R1') {
        this._log.info(`V.32bis: detected caller R2 pattern 0x${word.toString(16)}, max rate ${rate}`);
        this._onR2Detected(rate);
      }
    } else if ((this._rxBitShift & 0x888F) === 0x888F) {
      // E-signal detected.
      if (this._phase === 'SIG_R3') {
        const word = this._rxBitShift;
        this._log.info(`V.32bis: detected caller E pattern 0x${word.toString(16)}`);
        this._onEDetected();
      }
    }
  }
}

module.exports = { V32bisAnswerer, STATES, STATE_A, STATE_B, STATE_C, STATE_D };
