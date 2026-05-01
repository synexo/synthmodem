# SynthModem — Session Handoff

This document is intended for a new Claude session picking up work on
SynthModem. You will typically be told:

> *Start sandbox and pull the synthmodem repo. Read Handoff.md.*

**Current state (as of late April / early May 2026): Step 6 complete
— end-to-end interactive BBS over real PSTN, V.34 33600/21600 bps,
via the slmodemd-pjsip backend (backend B).** Handshake reliable,
data mode stable for full session, TelnetProxy attaches and forwards
keystrokes to the target BBS. The key post-CONNECT pathology from
prior versions (unterminated result code stuck in line buffer for
140+ seconds) is fixed by a Node-side defensive debounce; VM-side
cleanup is planned.

**Native backend low-speed modulations (Apr 2026 follow-on):**
all five pure-JS protocols — Bell 103, V.21, V.22, V.22bis, V.23 —
are end-to-end validated against real hardware modems over SIP/RTP.
V.22bis answer-side completed April 30 with three fixes (spectral S1
detector replacing symbol-stream S1, Gardner symbol-sync sign
inversion, LMS leak rate). `protocolPreference` and `v8ModulationModes`
defaults now advertise all five. See "V.22bis answer-side — completed"
section below for full diagnosis details.

**`auto` backend shipped (April 30):** composes slmodemd-pjsip and
native via mid-call swap on V.8 timeout. Now the recommended default.
Worst-case Bell 103 connect ~22 s, comfortably inside the 30 s S7
timer in vintage terminal software. See Section 0's "auto backend"
entry below.

**Windows multimedia-timer claim extended to `auto` (April 30):**
the `timeBeginPeriod(1)` claim in `src/index.js` previously gated only
on `backend === 'native'`. Auto runs the native DSP post-swap and
equally needs the 1 ms timer. **This was the cause of a multi-day
"intermittent garbage characters" diagnostic arc** — masked when audio
capture was enabled (sync `fs.writeSync` per audio chunk damped
timer-quantum bursts); exposed when capture was disabled. Any future
backend that runs the native DSP on the host event loop MUST extend
this guard. See "Decisions and solutions" §7 for full record.

This file covers:

1. Your sandbox capabilities and how to use them
2. The project at a glance
3. Current state — what works, what's open (**READ FIRST**)
4. Debian-bookworm-VM build workflow (for glibc-pinned binaries)
5. Tarball packaging conventions
6. Audio-capture analysis methodology
7. Decision history — solutions attempted, diagnoses made, and why
8. Pointers to deeper context (transcripts)

A brisk first-session reading gets you productive in ~15 minutes.

---

## 0. What changed since the last major handoff (Apr 2026 update)

### Backend strategy — current shape (April 30, 2026)

The project maintains **three backends**: two primitives plus a
composer. The two primitives existed at the start of this session
arc; the composer was added April 30.

1. **`native` (pure-JS ModemDSP)** — collection of pure-JS modems
   under `src/dsp/protocols/` (V21, V22, V22bis, V23, Bell103).
   All five validated end-to-end against real hardware. No VM, no
   glibc-pinned binaries. Driven by `config.modem.native.*`.
2. **`slmodemd-pjsip`** — `src/backends/PjsipBackend.js`. Full VM
   with slmodemd + d-modem + PJSIP. Handles all high-speed paths
   (V.32bis → V.34 → V.90) via the proprietary DSPs that Linux
   distros once shipped. Driven by `config.modem['slmodemd-pjsip'].*`.
3. **`auto`** (recommended) — composes the two above. Every call
   starts on slmodemd-pjsip (`b2bua` mode). If V.8 times out — the
   deterministic ~12 s slmodemd-pjsip "no CM observed" signature of
   a non-V.8 caller — the call swaps mid-flight to native via
   `RtpSession.adoptSocket()` and runs the V.25 legacy probe chain
   (V.22bis 5 s → V.21 3 s → Bell 103 5 s). Native is initialized
   with `start({ skipV8: true, skipAnsam: true })` because the
   caller has already heard ANSam from PJSIP. The discriminator is
   pure JS in `CallSession`: `_dspIsPooled && !_everConnected` at
   the moment of `silenceHangup`. See Phase 8 in `CLEANUP.md` for
   the design notes and the full landing list.

The older host-paced "slmodemd-alone" backend (which used
`SlmodemBackend.js` talking to `modemd-shim.c` over wire-framed
audio) was removed in cleanup-phase-1. References to it in this
document are historical context, not current architecture.

### `auto` backend — DONE (April 30, 2026)

User-confirmed working across all 8 caller modes (V.8-capable,
V.22bis/V.22/V.21/Bell 103 with-V.8 and no-V.8). Real-modem-tested
through several drops (v1 through v5+) with iterative feedback at
each step. Final v5 drop sits at
`/mnt/user-data/outputs/auto-backend-drop-v5/` in the previous
session's outputs.

Key implementation pointers, in order of "you'd want to read these
in this sequence to understand the swap":

- `src/session/CallSession.js`:
  - `_buildModemBackendSync`: enumerates the three valid backend
    values; throws helpfully if `'auto'` is configured without a
    `ModemBackendPool`.
  - `silenceHangup` handler: contains the swap discriminator
    (`_dspIsPooled && !_everConnected`) and the swap orchestration
    (tear down internal SIP leg, hand RTP socket to new
    `RtpSession`, instantiate `ModemDSP` with skipV8/skipAnsam,
    arm V.25 probe chain).
- `src/rtp/RtpSession.js`: new `adoptSocket(socket, remoteAddr,
  remotePort, ssrc)` method. Takes ownership of an existing UDP
  socket without re-binding. Maintains seq/ts continuity with what
  PJSIP was sending (or accepts a fresh ssrc; the caller's modem
  doesn't care since the swap happens before the caller has seen
  any RTP from us at all).
- `src/rtp/RtpBridge.js`: `stop()` removes the `'message'` listener
  but does NOT close the socket — so `adoptSocket` can take it over
  cleanly.
- `src/dsp/Handshake.js`: `start({skipV8, skipAnsam})` skip-flags
  jump straight to V.25 "answer-tone-heard, awaiting training"
  state, which then fans out into the legacy probe chain.
- `src/dsp/protocols/V22.js` (V22bis class): anti-Bell103 spectral
  test (`fskEnergy <= 4 * carrierEnergy + 0.002` at 1270 Hz vs
  1200 Hz Goertzels). Necessary because the V.22bis class is part
  of the legacy probe chain and Bell-103 callers will pump 1270 Hz
  during the probe window.
- `src/dsp/Handshake.js` (`FskDiscriminator` class): runs alongside
  V.21/Bell103 probes (only on answer-side legacy probes), tight
  Goertzels at in-band vs cross-band caller-mark frequencies,
  requires 1.5x dominance. Without it, V.21 and Bell 103 demods
  cross-trigger because their bandpass filters leak each other's
  caller marks.

Tests: `test/session/auto.test.js` (6/6) covers the swap
orchestration. The pre-existing 88-test suite still passes (94
total).

### Banner placeholders + publicHost auto-resolution — DONE (April 30, 2026)

Two QoL features that landed alongside the auto backend.

**Banner placeholders.** `terminal.banner` (string or array) now
substitutes `{{protocol}}` and `{{bps}}` at TelnetProxy attach time.
The CONNECT info is captured during handshake and bound into the
banner string before send. Test banner used during this session was
`['ABCDEFGHIJKLMNOPQRSTUVWXYZ']` for unambiguous visual identification
in real-modem tests; the placeholder format is documented in
`config.js` next to the `terminal.banner` key.

**publicHost auto-resolution.** New file
`src/sip/PublicHostResolver.js` (~140 LOC). When
`config.sip.publicHost === ''` (now the default), the resolver
picks per-call by INVITE source-IP-subnet match → first non-loopback
→ 127.0.0.1 fallback. Logs the chosen interface at INFO level with
a separate WARN-level log if the fallback chain hits 127.0.0.1.
`dlg.localPublicHost` is cached at INVITE time for use by 180/200/BYE.

**Defaults updated.** In the COMMON CONFIG block:

- `HOST` from a per-instance LAN IP to `'0.0.0.0'` (bind on all
  interfaces). The right default for most installs.
- `PUBLIC_HOST` from a per-instance LAN IP to `''` (empty enables
  auto-resolution).

### RTP heartbeat log-level — DONE (April 30, 2026)

`RtpBridge.js` heartbeat lowered from `info` → `debug`. It was
visually noisy in normal `info`-level logs.

### FskCommon shared base + V.23 spandsp port — DONE (April 2026)

**What landed:** consolidation of the three pure-JS FSK protocols
under one shared module, plus a complete spandsp port for V.23.

**`src/dsp/protocols/FskCommon.js`** — new shared module containing:

1. **`FskModulator`** — DDS-style continuous-phase frequency
   switcher with sub-sample-accurate baud timing. Used by V.21,
   Bell 103, and V.23 TX (both forward and backward channels). Per
   spandsp's approach: per-sample `baud_frac += baud_rate` accumulator
   with `baud_rate` in 1/100-bps units.
2. **`FskDemodulator`** — incoherent BPF + envelope demodulator
   with majority-of-3 mid-bit sampling. Used by V.21 and Bell 103
   at 300 baud where it works very well (user-confirmed excellent).
3. **`CoherentFskDemodulator`** — port of spandsp's `fsk.c` (LGPL
   2.1, Steve Underwood). Quadrature DDS correlators with sliding
   dot-product matched filter; spandsp-style UART framer with
   60/100% central-bit stability check; carrier-detect via DC-blocked
   power meter with ±2.5 dB hysteresis around -30 dBm0. Used by V.23.

**`src/dsp/protocols/V21.js` and `Bell103.js`** — reduced to thin
~95-line wrappers over `FskModulator` + `FskDemodulator`. Algorithm
is in exactly one place. The previous duplicated demod code (~140
lines per file) is gone.

**`src/dsp/protocols/V23.js`** — replaced wholesale. Was 158 lines
with three structural bugs:
- `Math.round(SR/baud)` for symbol period at 1200 baud → 7 samples
  per symbol → actual baud rate 1142.86 (-4.8% error). V.23 spec
  allows ±0.01%, so no real V.23 receiver could decode this. Same
  bug on the RX side meant even bench-loopback with a corrected TX
  would slip bits over time.
- Demodulator was incoherent BPF + envelope at Q=12 — marginal at
  6.7 sps and inadequate for the 60-Hz tone separation on the 75-baud
  backward channel. No carrier-detect, so any noise during silence
  emitted phantom bytes.
- TX amplitude was 0.4 — about +12 dB above the V.21/Bell103 line
  level (0.15) used by working protocols on the same path.

The new V.23 is a 136-line wrapper that uses `FskModulator` for both
TX channels and `CoherentFskDemodulator` for both RX channels, with
the standard role mapping (answer = host = TX 1200 / RX 75; originate
= terminal = TX 75 / RX 1200).

**Validation:**
- `test/suite.js` extended from 15 to 18 tests: V.21 loopback (kept),
  V.23 forward 1200 bps loopback, V.23 backward 75 bps loopback, V.23
  bidirectional via role wrapper (answer↔originate). All pass.
- Stress tests (not in suite): 1000 random bytes through V.23 forward
  → 0 errors; 100 random bytes through V.23 backward → 0 errors.
  Edge-case payloads (0x00, 0xff, 0x55/0xaa, ASCII, high-bit-set, full
  pangram) all decode bit-exact.
- `test/native/v22-loopback.test.js` (16 tests) and the rtp / sip /
  session tests all still pass — refactor is non-regressive for V.22.

**Real-peer test status (April 2026):** validated end-to-end against
real hardware in the V.22bis answer-side work session — V.23 is no
longer a TESTING/promotion candidate; the protocol class is now in
the default `protocolPreference` and `v8ModulationModes` lists.

### Phase 2 — DONE (April 2026)

Phase 2 (spandsp removal from the native backend; documentation
to match) shipped in `synthmodem-cleanup-phase2-v1.tar.gz`.

**What landed:**

#### Code / build
- `src/native/` removed entirely (vendored spandsp subset, V.22bis
  and V.32bis bindings, MSVC `win-compat/` shim, spandsp-patches/).
- `binding.gyp` removed.
- `src/dsp/V32bisAnswerer.js` (937-line V.32bis answer-mode
  sequencer) removed.
- `src/dsp/protocols/V32bis.js` removed (V.32bis spandsp wrapper +
  the co-located V.23 pure-JS class).
- `src/dsp/protocols/V34.js` removed.
- `src/dsp/protocols/V22.js.SPANDSP` (reference copy) removed.
- `src/dsp/protocols/V22.js` replaced by the historical PUREJS
  version, banner-flagged: V22 class is the active 1200 bps DPSK
  implementation; V22bis class is preserved as TESTING / not
  known-working, retained as the basis for future fix work.
  **Post-Phase-2 update (April 30):** the V.22bis fix work happened
  during this same session arc — V.22bis answer-side is now
  end-to-end validated against real hardware at 2400 bps. See the
  "V.22bis answer-side — completed" entry below for details. The
  TESTING banner has been removed; V.22bis is in
  `protocolPreference` defaults alongside V.22 / V.21 / Bell 103 /
  V.23. The original Phase 2 plan called for deleting V.22bis; the
  arc diverged into "fix it instead." The plan-as-written in early
  Section 0 of this document does not match the shipped state on
  this point; this update is the authoritative record.
- `src/dsp/protocols/V23.js` is a new file extracted verbatim
  (modulo trimmed Primitives imports) from the V.23 portion of the
  removed V32bis.js. Banner-flagged TESTING / promote-or-delete
  pending operator validation against a real V.23 peer.
- `src/dsp/Handshake.js`: trimmed V.32bis/V.34 protocol dispatch,
  HS_STATE.V32_AC_SEND state, `_startV32AcSend` /  `_generateV32Ac`
  / `_processV32AaRx` methods (~90 lines), the V.32bis fallback
  branch in `_selectProtocol`, the V.34 `startHandshake` branch.
  V.8 spec bit-encoding/decoding (`_buildCapabilityModes`) left
  intact — those are spec compliance, governed by what's in config.
- `src/dsp/ModemDSP.js`: dropped AGC instantiation/use (no surviving
  protocol consumes it). Pre-existing config-access bug fixed (the
  `cfg = config.modem` line was reading native-only keys —
  `silenceThreshold`, `silenceHangupPackets` — through the wrong
  path; introduced `ncfg = config.modem.native` for the native-only
  reads).
- `src/dsp/Primitives.js`: AGC / CostasLoop / GardnerTiming /
  LMSEqualizer / Scrambler classes are *retained* (not removed).
  Banner explains they are kept as building blocks for any future
  native-V.22bis fix work; nothing currently active consumes them.
- `package.json`: dropped `gypfile`, the `install`/`rebuild`
  scripts, and the `speaker` dependency. License corrected from
  `MIT` to `GPL-2.0-or-later` (the rest of the tree was already
  GPL'd; the `MIT` string in package.json was a stale leftover).
- `test-client/AudioOutput.js` removed.
- `test-client/index.js`: dropped `--audio` and `--volume` CLI
  flags, the `AudioOutput` import and instantiation, and the
  audio-out side-effect in the `audioOut` event handler. Updated
  `--proto` valid list to the post-Phase-2 surface (V21, V22,
  Bell103 active; V22bis, V23 TESTING).
- `config.js`: `protocolPreference` and `v8ModulationModes` now
  default to `['V22', 'V21', 'Bell103']`. V22bis/V23 entries
  remain in `trainingDurationMs` and `carriers` because their
  classes still exist in the registry as TESTING (operators must
  opt them in to use them). Dropped: `agc*` keys (4),
  `equalizer` block, `scramblerPolynomial`, `timingRecovery`
  block, `carriers.V32bis`, `carriers.V34`, and the testClient
  `audioOutput*` keys (3). Each removal documented in-place via
  comment so a future Phase-4 V.22bis-fix author knows what was
  there.
- `.gitignore`: removed the `build/` line. (Maintainer-side
  `git rm --cached -r build/` is a separate local action.)

#### Tests
- `test/loopback_v22bis.js`, `test/loopback_v32bis.js`,
  `test/loopback_qam.js` removed.
- `test/suite.js` trimmed: dropped V.22bis/V.32bis/V.34 QAM
  child-process loopbacks; updated "all protocols registered"
  check to `['V21', 'V22', 'V22bis', 'V23', 'Bell103']`. Kept
  the V.21 FSK loopback, all SIP/RTP/Codec/SipDialog/TelnetProxy
  /Config/SipServer-live tests. The HandshakeEngine V.8
  negotiation real-time test is now SKIPPED with a comment
  documenting a pre-existing decode failure (the answer side
  decodes the originate's CM as `modes={}` even though the TX
  side logs the correct `{v22bis}`); verified by running the
  pre-Phase-2 tree on the same sandbox — same failure mode. Out
  of Phase-2 scope; track for a future native-test pass.
- All non-VM tests pass on a clean checkout: 11 ctrl/standalone +
  13 rtp/fixed-buffered + 4 rtp/bridge + 6 sip/uac-unit + 5
  session/b2bua + 15 suite.js = 54 / 54.
- VM smoke not exercised in this session; slmodemd-pjsip path is
  unaffected by Phase 2 (all changes were in the native backend
  and shared host-side code).

#### Documentation
- `WIN_FIX_NOTES.md` removed.
- `LICENSE-spandsp` removed (was a top-level attribution file
  documenting the vendored spandsp subset; obsolete with 100% of
  spandsp source gone, verified by `grep -r SpanDSP` across the
  source tree returning no `.c`/`.h`/`.cc` hits).
- `README.md`: status block, system-requirements block, "How it
  works → native" block, repository layout, and quickstart `npm
  install` paragraph all updated for the no-toolchain pure-JS
  reality.
- `QUICKSTART.md`: dropped the C/C++ toolchain bullet, the Phase-2
  pending note, the WIN_FIX_NOTES.md cross-reference, the
  "compiles two native addons" install paragraph, the
  synthmodem_v22 troubleshooting entry, and the `--audio`/
  `--volume` examples. Updated the protocolPreference example to
  the post-Phase-2 default.
- `Handoff.md`: this section, marking Phase 2 done. Section 9
  "Phase-2 territory" subsection removed.
- `CLEANUP.md`: Phase 2 entry marked complete with a summary
  block following the Phase-6 Tier-1 pattern.
- `COPYING` and `licenses/`: no changes needed (SPANDSP-LGPL was
  already absent before Phase 2 — verified at the start of this
  session).

**TESTING-status protocols and what's deferred:**

V.22bis (in `V22.js`) and V.23 (in `V23.js`) are not advertised by
default. Operators who want to test them set
`config.modem.native.protocolPreference` and `v8ModulationModes`
explicitly to include the protocol name, or use
`config.modem.native.advertiseProtocol` from the test client.

If V.22bis is fixed in a future phase, the retained Primitives
building blocks (LMSEqualizer / CostasLoop / GardnerTiming / AGC /
Scrambler) and the V22.js V22bis class are the natural starting
point. Restore the matching config keys (`equalizer`,
`timingRecovery`, `agc*`, `scramblerPolynomial`) at that time —
the comment block in config.js documents what was removed.

If V.23 is validated against a real V.23 peer, promote it by
adding it to `protocolPreference`/`v8ModulationModes` defaults
and removing the TESTING banner from V23.js. If it doesn't
work and isn't worth fixing, delete `V23.js`, drop the V23 entry
from PROTOCOLS in Handshake.js, drop the V23 import, drop the
`carriers.V23` and `trainingDurationMs.V23` config entries, and
remove the V23 case from V8.js's `selectProtocol` mapping (V.8
spec bit-decoding can stay).


### TX pacing — absolute-time hrtime target chain (April 2026)

This is the actual fix for the long-standing "CONNECT> garbage" issue
that survived through every phase 1-5 of the V.22 demodulator work
and resisted both the spandsp port and the (subsequently reverted)
TelnetProxy heartbeat. The user observation that nailed the
diagnosis: **the issue does not occur on the slmodemd-pjsip backend**.
That ruled out anything in the V.22 DSP layer (which is shared
between backends in concept but only the native backend uses our
pure-JS implementation; the pjsip backend uses slmodemd inside a VM)
and pointed at something specific to the native backend's audio
pipeline.

Shipped as two files:

  * `src/dsp/ModemDSP.js` (MODIFIED): replaces the prior
    `setInterval(5)` + `Date.now()` deficit-catchup TX pacer with an
    absolute-time target chain driven by `process.hrtime.bigint()`
    and `setTimeout`.
  * `test/dsp/tx-pacing.test.js` (NEW): 5 timing tests — long-term
    throughput, BLOCK-sized chunks, no cumulative drift, stop()
    cleanup, prompt first emit.

**Root cause (the diagnosis we missed for several phases)**:

The native backend's TX path was using:

```js
this._txTimer = setInterval(() => this._txTick(), 5);

_txTick() {
  const elapsedMs     = Date.now() - this._txStartMs;
  const targetSamples = Math.floor(elapsedMs * SAMPLES_PER_MS);
  const deficit       = targetSamples - this._txSamplesEmitted;
  ...
}
```

Two compounding sources of timing jitter:

1. **`Date.now()` has 1-15 ms quantum** depending on the OS. On
   Windows the default system timer interval is 15.6 ms, and
   `Date.now()` advances in those quanta. Two `Date.now()` calls a
   few ms apart can return identical values, making the deficit
   computation step-staircased.

2. **`setInterval` is soft real-time at best** — a `setInterval(5)`
   on a busy event loop fires at 5-15 ms intervals, not 5. The
   deficit-catchup compensated for the COUNT of samples emitted but
   not for the precise SPACING of the emit calls in wall-clock
   time. Inter-emit gaps measured 16-22 ms typical with occasional
   30-40 ms outliers — a ±2-5 ms jitter relative to the ideal
   20 ms cadence per RTP packet.

Why this matters specifically for V.22 (and was correctly called
out by an existing comment in `src/backends/PjsipBackend.js` we
hadn't internalized):

> "PJSIP's software clock (`snd_use_sw_clock`) drives the 20 ms
> put_frame/get_frame cadence... we tried reimplementing equivalent
> pacing in Node (Clock Pump v2) and it works at V.32bis but is
> fragile at higher speeds."

V.22 line idle is "scrambled marking": no UART start bits, just a
pseudorandom 50/50 bit stream from the scrambler. The receiving
hardware modem's PLL/equalizer/descrambler tracks bit timing
continuously. **Small TX-side timing slips accumulate as carrier-
phase slip on the wire**, which the receiver can't realign against
because there are no UART resync points during pure idle. Once the
receiver's bit alignment slips by half a bit period (~833 µs at
1200 baud), its descrambler register fills with wrong bits → output
becomes random-looking → its UART catches false start bits →
garbage on the user's terminal.

During data flow (BBS sessions), every UART start bit provides a
fresh resync; timing slips can't propagate far before being
corrected. That's why BBS sessions looked clean and pure idle did
not — the same TX timing jitter was always there, but only idle
exposed it.

The slmodemd-pjsip backend doesn't see this because PJSIP's C-side
software clock paces RTP packet emission at hard real-time. The
audio path bypasses Node's event loop entirely (b2bua mode).

**The fix**:

Use `process.hrtime.bigint()` for ns-resolution wall-clock reference,
and a `setTimeout` chain rescheduling for ABSOLUTE target times:

```js
// Anchor at start
this._txStartNs = process.hrtime.bigint();

// Each tick: emit any blocks at-or-past their absolute target,
// then reschedule for the next un-emitted block's target time.
_txTick() {
  const nowNs = process.hrtime.bigint();
  const elapsedNs = nowNs - this._txStartNs;
  const targetSamplesBig = (elapsedNs * BigInt(SR)) / 1_000_000_000n;
  const targetSamples = Number(targetSamplesBig);
  const deficit = targetSamples - this._txSamplesEmitted;
  ...emit min(3, deficit/BLOCK) full blocks...
  this._scheduleTxTick();  // delta to NEXT block's absolute target
}
```

Three design rules followed:

1. **Absolute targeting**: block N's ideal time is
   `_txStartNs + N * 20_000_000n` ns, computed from start. Never
   relative to the previous tick. Drift is mathematically zero.

2. **Catch-up**: if the event loop stalls and we wake past the
   target for multiple blocks, emit the backlog immediately (capped
   at 3 blocks per tick to avoid network burst).

3. **Next-tick delta**: after emitting, compute exact delta from
   `now` to the next un-emitted block's absolute target and use
   `setTimeout(callback, deltaMs)`. setTimeout's own firing latency
   (1 ms on Linux, 15.6 ms quantum on Windows) bounds the per-tick
   error, but does NOT compound across ticks.

**Measured impact** (on Linux container, 5 s run):

| Metric                       | Old (setInterval+Date.now) | New (hrtime+absolute) |
|------------------------------|---------------------------:|----------------------:|
| Most-common gap              | 22 ms (97×)                | **20 ms (127×)**      |
| Median gap                   | 21 ms                      | **20 ms**             |
| Gaps in 18–22 ms             | 70.6%                      | **99.6%**             |
| Cumulative drift over 5 s    | not measured               | **0.08 ms**           |

A 100 ms forced event-loop stall recovers in ~3 emit cycles via the
catch-up loop, leaving residual drift of ~22 ms after 3 s — bounded
because absolute-time anchoring lets each subsequent tick aim for
its correct absolute target.

**Why prior phases never caught this**:

Every demodulator-side fix improved RX correctness but the issue is
TX-side timing. The wav files we captured for analysis have
sample-perfect timing because they're written from
`audioOut`-event Float32Arrays — they preserve audio CONTENT but
DISCARD wall-clock TIMING. Decoding our own TX wav with our own
demodulator looked clean because both sides are reading from the
same wav file at perfect 8000 sps; the receiving HARDWARE modem,
however, is reading the audio off the SIP/RTP path with the actual
emit-time jitter intact.

The misframed garbage we observed in user terminals was always the
hardware modem's RX losing track of bit timing because of carrier-
phase jitter, NOT a descrambler bit error or anything else we'd
addressed in the V.22 DSP code.

**Tests**: 5 pacing tests in `test/dsp/tx-pacing.test.js`, covering
throughput accuracy, chunk size, drift bounding, stop() cleanup,
and prompt first-emit. Full suite now 73/0/0 (no regressions).

**Limitations and followups**:

  * `setTimeout`'s per-fire latency on Windows is bounded by the
    system timer quantum (15.6 ms by default). For V.22 at 600
    baud this is acceptable — the absolute-time anchor prevents
    cumulative drift, and individual 15 ms slips are recoverable.
    For higher-speed protocols (V.32bis 14400, V.34) the
    slmodemd-pjsip backend remains the correct path, as the
    PjsipBackend.js comment warned.

  * On Windows, the timer resolution can be raised to 1 ms via
    `timeBeginPeriod(1)`. Node doesn't call this by default. A
    future refinement could be a small native helper that sets the
    multimedia timer resolution at startup, which would make
    setTimeout(20) actually wake within ~1 ms of target instead of
    within ~15 ms. Not currently shipped because we don't know yet
    whether V.22 needs it; if the user reports residual idle
    garbage after this fix, that's the next step.

  * Linux does not have the timer-resolution issue.

---

### CONNECT> menu-idle UART heartbeat (April 2026) [REVERTED]

This was an attempted fix for the "CONNECT> garbage" problem before
the TX-pacing root cause was identified. The hypothesis was that
hardware-modem UARTs misframed pseudorandom V.22 idle bits into
bogus bytes, and that periodic CRs would resync them. The user
installed it and tested; it had no effect on the garbage volume,
only changing the visual layout (the CRs forced subsequent garbage
to overwrite the same line). User correctly identified that
something more fundamental was wrong and rolled back the change.

The actual root cause turned out to be TX timing jitter — see the
TX-pacing entry above. Files removed from the tree on rollback:

  * `src/telnet/TelnetProxy.js` — heartbeat hooks reverted
  * `config.js` — `menuIdleHeartbeatMs` knob removed
  * `test/telnet/heartbeat.test.js` — deleted

This entry is kept in the Handoff as a cautionary record. The
diagnostic mistake was attributing the garbage to a hardware-modem
UART quirk rather than to our own TX timing. The clue we missed
until the user spelled it out: "this does NOT happen with the
slmodem-pjsip backend." That observation excluded anything shared
between backends (V.22 DSP, scrambler, modulator math) and pointed
directly at the native-backend audio pipeline — specifically, the
pacing layer that the pjsip backend completely bypasses.

---

### CONNECT> menu-idle UART heartbeat (April 2026)

A small follow-on to the v22-fix-phase5 spandsp port work. Addresses a
long-standing visible issue, present even in pre-phase-5 builds, where
"garbage characters" appear on the user's terminal whenever they sit
at the `CONNECT>` prompt for tens of seconds without typing anything.

Shipped as three files:

  * `src/telnet/TelnetProxy.js` (MODIFIED): added the menu-idle
    heartbeat — a single CR (0x0D) sent every 5 s during MENU-state
    idle, deferred by any send/receive activity.
  * `config.js` (MODIFIED): added `telnet.menuIdleHeartbeatMs` knob
    (default 5000; set to 0 to disable).
  * `test/telnet/heartbeat.test.js` (NEW): 5 unit tests using stubbed
    timers — fires after interval, fires repeatedly at cadence,
    receive() defers the next fire, no fire after disconnect, fully
    disabled when knob = 0.

**Why the garbage appears (forensic summary)**:

V.22 line idle is "scrambled marking": the scrambler input is held at
binary 1, and the scrambler output is therefore a pseudorandom 50/50
bit stream on the wire. Both ends' scramblers/descramblers stay in
sync indefinitely if every line bit is received correctly — the
descrambler output is then continuous 1s, and the receiving UART,
never seeing a start bit, emits no bytes. That is the protocol's
intended behavior, and self-loopback verifies it: 38 s of pure idle
through our own demodulator emits exactly 0 bytes.

Real-world hardware-modem UARTs occasionally trip on a "false start
bit" — a chance 0 in the pseudorandom stream — and frame the next 8
bits as a data byte. Once misframed, a hardware UART tends to stay
misframed because pure scrambled idle never produces 9+ consecutive
marks for clean resync. The user-visible effect is "garbage at
CONNECT>" plus subsequent prompt re-renders showing dropped leading
characters (e.g. the `ONNECT>` we observed in capture transcripts —
the leading `C`'s start bit got eaten by the previous misframed
byte).

We confirmed via bit-exact comparison that our V22Scrambler exactly
matches spandsp's scramble/descramble (zero mismatches over 100K
bits each direction, including the 64-consecutive-ones rule timing).
The issue is not in our DSP, modulator, demodulator, scrambler, or
any part of the V.22 pipeline — those are all bit-exact correct.
The issue is at the V.22-line ↔ hardware-UART interface, on the
user's modem side, which we cannot directly fix.

**The mitigation**:

During long MENU-state idle (typically the period between BBS
disconnect and the next user command), send a single CR (0x0D)
every 5 seconds. CR is:

  * a real UART-framed byte (start 0, data 10110000 LSB-first, stop 1)
    with a deterministic frame the receiving UART can resync against;
  * rendered as "cursor to column 0" by every terminal we care about
    — visually inert. The CONNECT> prompt is already at column 0
    from `_sendPrompt`'s lineEnding; any mis-decoded garbage on the
    same line gets overwritten when the next real prompt re-renders;
  * a real bit-transition exercise for the line's
    scrambler/descrambler shift registers, which keeps both ends
    resynced if either has drifted.

**Cadence and gating**:

  * Timer interval: 5 s (configurable via `telnet.menuIdleHeartbeatMs`)
  * State: MENU only — does NOT fire during PROXYING (BBS data already
    exercises the UART continuously)
  * Reset: any send or receive activity defers the timer. So during
    normal use (typing or active session) the heartbeat never fires.
  * Cancellation: cancelled on `disconnect()` and on transition to
    CONNECTING.

**Why this is at the TelnetProxy layer, not lower**:

This is a session-layer ergonomics fix. The V.22 layer has no opinion
about whether or how often UART frames flow through it — that is the
concern of whatever sits above the modem's TX path. TelnetProxy is
that "above" component for the menu/CONNECT> mode, and it is the
right place for the fix.

**Tests**: 5 heartbeat unit tests (using fake timers) verify cadence,
deferral, cancellation, and disable. Full suite now 73/0/0:
standalone(11), fixed-buffered(13), bridge(4), uac-unit(6),
b2bua(5), suite.js(15), v22-loopback(16), heartbeat(5).

---

### V.22 native fix — phase 5 (spandsp port, April 2026)

**This is the proper implementation.** Phases 1-4 were a sequence of
empirical patches over an architecture that didn't match the V.22
protocol's expected RX pipeline. Phase 5 replaces the demodulator
entirely with a faithful port of spandsp's `v22bis_rx.c` (Steve
Underwood, 2004), preserving the two phase-1/2 wins that don't have
spandsp analogues and stripping out the rest.

Shipped as four files:

  * `V22Common.js` (NEW): split off shared constants, scrambler, and
    the SRRC pulse-shape helper. The TX modulator (`V22.js`) imports
    these unchanged.
  * `V22RxRRC.js` (NEW): the 1296 RX RRC bandpass-filter coefficients,
    extracted verbatim from spandsp's `v22bis_rx_1200_rrc.h` and
    `v22bis_rx_2400_rrc.h`. 12 phase-shifted coeff sets × 27 taps × 2
    (re, im) × 2 (carriers).
  * `V22Demodulator.js` (REWRITTEN): full port of spandsp's `v22bis_rx.c`
    (~700 lines). Includes:
      - PowerMeter (single-pole IIR, shift=5, matches `power_meter.c`)
      - One-shot AGC during SYMBOL_ACQUISITION, locked thereafter,
        formula `0.18 * 3.60 / root_power` per spandsp line 918
      - Bandpass-RRC filter with 12 fractional phase positions
      - DDS-equivalent NCO (float phase in radians; conversion factor
        `2π / 2^32` from spandsp's int32 DDS units)
      - `_trackCarrier` Costas PI loop with per-stage `track_p`/`track_i`
        constants matching spandsp lines 1044-1050
      - Complex T/2 LMS equalizer (`_equalizerGet`, `_tuneEqualizer`,
        `_equalizerCoefficientReset`) with `EQUALIZER_LEN=17`,
        `EQUALIZER_PRE_LEN=8`, `EQUALIZER_DELTA=0.25`, initial coefficient
        `(3.0, 0.0)` at `eq_coeff[8]`
      - `_symbolSync` Gardner detector with 45° rotation, two-step
        convergence (256 → 32 → 4 over the 40-symbol SYMBOL_ACQUISITION
        stage), integrate-and-dump with threshold 16
      - Full RX training state machine with all five stages spandsp
        uses (SYMBOL_ACQUISITION → UNSCRAMBLED_ONES (caller) /
        SCRAMBLED_ONES_AT_1200 (answerer) → UNSCRAMBLED_ONES_SUSTAINING
        / SCRAMBLED_ONES_AT_1200_SUSTAINING → NORMAL_OPERATION) with
        spandsp's exact time budgets `155+456 ms`, `270 ms`, `270+765 ms`
      - `decode_baud` vs `decode_baudx` distinction — bits flow to
        the user only from NORMAL_OPERATION; pre-NORMAL stages
        descramble for state-machine bookkeeping but don't emit
  * `v22-loopback.test.js` (REWRITTEN): 14 tests covering self-loopback
    round-trips with proper warmup, training-stage transitions, byte
    gating during training, carrier-edge events, debug-sink fields.

**What was kept from earlier phases**:

  * **UART stop-bit-resync (phase 1)**. spandsp doesn't have a UART layer
    — its consumers handle UART framing externally. Our async data
    interface emits `data` events of `Buffer`, so a UART framer is
    integrated here. The phase-1 improvement (emit byte regardless of
    stop-bit value) is preserved.
  * **Carrier-presence gate concept (phase 2)**. spandsp's `signal_present`
    flag and our `enableCarrierGate` are equivalent. Bytes are blocked
    when carrier is absent. The constructor flag is kept for diagnostic
    A/B testing.
  * **TX-side fixes — `PEAK_TARGET=0.32` (phase 4b)** and
    **`teMs=150` (phase 4c)** in `V22.js` and `Handshake.js`. These
    operate on the modulator side and are independent of the
    demodulator rewrite.

**What was stripped** from earlier phases:

  * Phase-3 inline Gardner timing (replaced by spandsp's `symbol_sync`)
  * Phase-4a `_symPhase = 0` initialization (replaced by spandsp's
    `eq_put_step` pacing — no equivalent of `_symPhase` exists)
  * Phase-4d zero-rate descrambler-lock gate (replaced by spandsp's
    training state machine; bytes flow only from NORMAL_OPERATION)
  * Phase-4 separate AGC, Costas, LMS code (replaced by spandsp's
    integrated versions inside the state machine)

**Real-wire results vs spandsp era**:

| Capture                          | spandsp era junk | phase 5 junk |
|----------------------------------|-----------------:|-------------:|
| spandsp-cap1 RX                  | 30               | **30**       |
| spandsp-cap2 RX (caller-options) | 0                | **0**        |
| phase-4d RX                      | n/a              | **30**       |

Per-call training-state timeline on the phase-4d capture validates
all transitions:

```
t=4.53s SYMBOL_ACQ        ← carrier first detected
t=6.08s SCRAMBLED1200     ← 40 symbols later (Gardner settled)
t=6.28s SCRAMBLED1200_SUS ← 270 ms timed out
t=7.13s carrier-down      ← caller's silence gap
t=7.75s SYMBOL_ACQ        ← reacquisition starts
t=7.82s SCRAMBLED1200
t=8.02s SCRAMBLED1200_SUS
t=9.06s NORMAL            ← matches spandsp's 1.34s training budget
```

**Known cosmetic issue (resolved in phase-5 follow-up, see below)**:

~~The carrier-presence gate flaps ~85 Hz during the first ~1.5 seconds
of carrier acquisition.~~ This was initially documented as cosmetic
but turned out to be a hard regression: the `_softCarrierDownReset`
zeroed the rrc filter buffer and power meter on every flap cycle,
which (a) bloated diagnostic output, and (b) starved the V22 protocol
module's `symbolMag`-based carrier detection so the handshake
timed out with "no remote carrier detected" even when carrier was
plainly present on the wire.

**Phase-5 follow-up fix (still single drop)**: two changes.

1. **`symbolMag` exposed on the new demodulator**. The V22 protocol
   layer reads `demodulator.symbolMag` against a 0.02 threshold for
   handshake-time carrier detection (entirely separate from the
   demodulator's own carrier-presence gate and training state machine
   — these are two independent carrier checks that need to agree
   before the handshake completes). The new demod did not expose
   `symbolMag`, so the handshake check returned undefined and always
   timed out. Fix: track a smoothed `√power / RX_AMP_SCALE` every
   sample (where `power` is the IIR-smoothed RMS² of the bandpass-
   filtered carrier signal). This gives the V22 layer the same
   normalized-units scale the prior demodulator produced.

2. **One deliberate deviation from spandsp's RX**. On a carrier-down
   edge, spandsp's `v22bis_rx_restart` zeros the rrc filter buffer
   and power meter. That works on clean phone lines. In our specific
   RX environment our own TX guard tone (1800 Hz) leaks into the
   RX path with energy ~400× the actual caller's 1200 Hz signal
   during early ramp-up. The 1200 Hz bandpass filter rejects 1800 Hz
   at -36 to -44 dB but the small leak-through pulses cross the
   carrier-on threshold and dip below it cyclically. Zeroing the
   buffer/meter on every dip turned each transient into a 27-sample
   re-acquisition cycle, producing the self-sustaining flap.

   The fix: keep the rrc filter buffer and power meter intact across
   transient down-edges. Reset only the higher-level state (training,
   equalizer, descrambler, UART). On a real end-of-call, the buffer
   drains naturally over the next ~27 samples as silent input flushes
   the old samples; on transient dips the state stays primed.

   Documented in `_softCarrierDownReset` with rationale. This is the
   ONE deviation from spandsp in the entire port. Behavior on clean
   phone lines (no guard-tone leakage) is unchanged because the gate
   doesn't flap there in the first place.

After this fix:
  - Carrier edges on the failed-call wav: 110+ → 10 (5 of which are
    legitimate caller silences and call-end edges)
  - V22 protocol carrier detection on the failed-call wav: detects
    at v22-local t=2.82s, well within the 8-second window
  - `symbolMag` returns ~0.037 during steady V.22 signal (above the
    0.02 threshold)
  - Byte-level RX output unchanged: still 30 junk bytes on standard
    captures, 0 on caller-options. spandsp parity preserved.

**Tests**: 16 v22-loopback (all pass, +2 vs initial phase-5 drop):
two `symbolMag` regression tests added. Full suite still 68/0/0 plus
the 2 new ones = 70/0/0.

**Licensing / attribution (added in phase-5)**:

Two of the three new files are direct ports of spandsp work and
therefore inherit spandsp's licensing:

  - `V22RxRRC.js` — coefficient data ported verbatim from
    `v22bis_rx_{1200,2400}_rrc.h`. Header now attributes spandsp
    (https://github.com/freeswitch/spandsp) and notes that spandsp
    is GPL/LGPL; the ported file is distributed under the GPL.

  - `V22Demodulator.js` — algorithm port (filter, AGC, Costas, LMS,
    Gardner, training state machine). Header attributes Steve
    Underwood / spandsp (LGPL-2.1) and is distributed under the GPL
    consistent with V22RxRRC.js.

  - `V22Common.js` — independently authored from the V.22bis spec
    (constants, the SRRC formula from textbook DSP, the V22Scrambler
    implementing the §5.1/§5.2 polynomial). Header now clarifies
    this and notes the file is distributed under the synthmodem
    project license.

If the project's overall license isn't compatible with GPL, the
right resolution is to convert the demodulator and RRC files back
to LGPL-2.1 (matching spandsp's actual license), which is more
permissive. Either GPL or LGPL is OK from the upstream's perspective.

---

**Tests**: 14 v22-loopback (all pass), full suite 68/0/0 across
standalone, fixed-buffered, bridge, uac-unit, b2bua, suite.js,
v22-loopback. Two-second warmup is required in self-loopback tests
because of the new training-stage gating (~1.34s for the answerer
path); attempting to write data immediately after warmup fails as
expected (no bytes flow until NORMAL_OPERATION).

**Followups beyond phase 5**:

  * **Carrier-flap cleanup** (cosmetic). Either tune CARRIER_OFF_POWER
    higher to avoid the false threshold crossings during 1800 Hz
    leakage, or skip the rrc buffer zeroing on transient down. Latter
    is the more principled fix; either is small and isolated.
  * **`captureAudio` extension to slmodemd-pjsip path**. Currently
    native-only. Hooking RtpBridge._forward would enable cross-backend
    captures.

(NOTE: an earlier draft of this list suggested "port Bell103/V.21/V.23
to spandsp's fsk.c next." That suggestion was wrong. The FskCommon
work in April 2026 already considered this and made the deliberate
choice to use a coherent spandsp port (`CoherentFskDemodulator`)
ONLY for V.23 — where the short symbol period (forward 1200 baud =
6.67 samples/symbol) and narrow tone separation (backward 75 baud =
60 Hz mark/space) make incoherent BPF+envelope marginal. V.21 and
Bell 103 use the incoherent `FskDemodulator` (BPF + envelope +
majority-of-3 sampling) because at 300 baud / ~26 samples-per-bit
that approach works very well — user-confirmed excellent. The V.22
lessons that DID port to V.21/Bell103 are: the spandsp-discipline
of implementing-to-spec, the same carrier-presence gate concept,
and stop-bit-resync robustness. See "FskCommon shared base + V.23
spandsp port" earlier in this document for the full design rationale.)

---

### V.22bis answer-side — completed (April 2026, end-to-end validated)

Phase 5 ported the V.22bis demodulator from spandsp but the answer-side
*handshake sequencer* (the `V22bis` class in `V22.js` that drives
the modulator through the U11 → U0011 → TIMED_S11 → S1111 → DATA TX
sequence) was untested against real hardware. Three bugs were
diagnosed and fixed, after which an end-to-end call with a real V.22bis
modem dialing in over SIP/RTP completes the handshake at 2400 bps,
correctly decodes the caller's typed bytes, and forwards them to the
configured BBS via TelnetProxy. The user confirmed working April 30.

**Bug 1 — phantom NCO lock on caller's S1, broken symbol-stream S1
detector.** The pre-port code relied on the demodulator's symbol-based
S1 detector (count phase-step XOR pattern repeats over consecutive
symbols). Spandsp does this. But against real V.22bis caller signals
via SIP/RTP, by the time symbol acquisition finishes (~67 ms), only
~24 symbols of the caller's 100 ms S1 burst remain, and the carrier-
track loop tends to phantom-lock on S1's regular 90°/symbol rotation,
producing a stationary post-NCO baseband that defeats the slicer's
quadrant-delta detection. **Fix:** added a parallel **spectral S1
detector** in the V22bis class. S1 produces strong narrowband peaks
at carrier ± baud/2 (900 and 1500 Hz for the answerer) with valleys
at the off-sideband bins. A peaks-vs-valleys ratio test (>2x ratio,
4 consecutive 20 ms windows = 80 ms) fires reliably during S1 and is
silent during USB1/SB1/data. When the spectral detector fires,
`_onS1Detected('spectral')` writes `_negotiatedBitRate=2400` directly
into the demod (so its training state machine takes the 2400 branch),
emits `'remote-detected'` immediately (with `viaS1: true`), and
advances the V22bis TX state machine to U0011. Constants:
`V22BIS_S1_DETECTOR_WINDOW_MS=20`, `RATIO=2.0`, `MIN_CARRIER=0.005`,
`RUN_LEN=4`. Implementation in `V22.js` `_runS1Detector` /
`_onS1Detected`.

**Bug 2 — Gardner symbol-sync sign inversion in V22Demodulator.js
(equalizer never converges on real signals).** spandsp's `symbol_sync`
computes the timing error as `(eq_buf[aa[2]] - eq_buf[aa[0]]) * eq_buf[aa[1]]`
= `(oldest - newest) * mid`. The phase-5 port had `(newest - oldest)
* mid` — sign inverted in BOTH the 16-way and 4-way branches. With
the wrong sign the timing loop drives the sub-symbol sample position
the wrong way, so the equalizer never converges on a clean
constellation. **Self-loopback tests still passed** because both
sides made symmetric errors and the integer-sample structure happened
to start at the right offset. Real-signal symptom: demod sat in
`WAIT_FOR_SCRAMBLED_ONES_AT_2400` for the entire call, decoding random
nibbles instead of the 9-consecutive-`0xF` pattern needed to enter
NORMAL_OPERATION. After fix: demod transitions WAIT_2400 → NORMAL
in 292 symbols (vs stuck at 43000+ before).

**Bug 3 — missing LMS leak rate.** spandsp's `cvec_lmsf`
(`complex_vector_float.c:201`) multiplies coefficients by
`LMS_LEAK_RATE = 0.9999` each adaptation step to prevent unbounded
drift. The phase-5 port was missing it. The leak alone wasn't enough
to make the demod converge (Bug 2 was the killer), but it's needed
for stability over long noisy training periods. Added in
`_tuneEqualizer`.

**Validation:** Replaying captured RX from the user's successful call:
- Equalizer converges in tens of symbols.
- During typing burst (caller transmits `bbs.birdenuf.com:2003\r`),
  demod cleanly decodes the byte sequence `0x62 0x62 0x73 0x2e 0x62
  0x69 0x72 0x64 0x65 0x6e ...` = `bbs.birden...` — bytes correctly
  reach TelnetProxy, BBS connection succeeds.
- Handshake completes reliably at 2400 bps; idle data periods correctly
  produce 0 spurious bytes (descrambler in sync, UART stays in IDLE).

**Files touched in this work:**

  - `src/dsp/protocols/V22.js` — added spectral S1 detector
    (`_runS1Detector`, `_onS1Detected`, four `V22BIS_S1_DETECTOR_*`
    constants). The detector runs only during HS_PHASE.U11. On fire,
    it forces the demod into the 2400-bps training path and emits
    `remote-detected` with `viaS1: true` so Handshake.js correctly
    reports a successful answer rather than timing out on the
    coarse carrier-energy heuristic's 400 ms hysteresis.
  - `src/dsp/protocols/V22Demodulator.js` — Gardner sign fix in
    `_symbolSync` (both 16-way and 4-way branches), LMS leak rate
    `0.9999` in `_tuneEqualizer`, and `RX_TRAINING` enum exported
    so V22.js can reference state codes.
  - `src/dsp/protocols/V22Demodulator.js` — `SYMBOL_ACQUISITION` exit
    only sets `_negotiatedBitRate=1200` if not already 2400 (prevents
    the spectral detector's pre-emptive 2400 commit from being
    clobbered when the demod's symbol acquisition completes).

**Default config promoted:** `V22bis` and `V23` are now in
`config.modem.native.protocolPreference` and `v8ModulationModes`
defaults. README "Status" updated to reflect all five low-speed
native protocols are validated.

**Tests:** 18 suite.js + 16 v22-loopback all pass.

---

### V.22 native fix — phase 4d of N (April 2026) [SUPERSEDED by phase 5]

Phase 4d of the V.22 native fix work. Shipped as files
`V22Demodulator.js`, `v22-loopback.test.js`, and `Handoff.md`.

**The fix:** a second-stage RX gate that closes when the descrambler
isn't synchronised, opens when it is.

**What this fixes:**

After phase 4c (Te-silence regression) cleaned up most of the
user-visible corruption, a residual ~6-second early-call burst of
spurious bytes remained. Empirical analysis of the phase-4c capture
revealed the structure:

  * t=0–5s: Pure noise pre-carrier. Correctly suppressed by the
    phase-2 carrier gate. **0 bytes emitted.**
  * t=6s: Mag jumps to 1.43, gate opens. Demod is in unstable
    settling state (dQuad uniformity 8.3 std dev). **13 bytes
    emitted, 3 junk.**
  * t=7s: Mag DROPS to 0.38 — calling modem went silent for
    ~600 ms (Te-like gap on caller side). Gate flaps. **32 bytes
    emitted, 27 junk.**
  * t=8–11s: Descrambler resyncing after the t=7 dropout. Bytes
    pseudo-random as the descrambler shift register self-aligns.
  * t=12+: Zero rate ~0%, fully synced, clean for rest of call.

So the bytes were emitted while the descrambler was either still
settling on first carrier acquisition, or recovering from a brief
mid-handshake silence on the calling-modem side. In both cases the
gate that needed to be closed is "are we actually decoding V.22 idle
correctly right now" — a question the existing carrier-power gate
can't answer.

**Mechanism:**

The descrambler-lock gate measures the zero-rate of the descrambled
bit stream over a sliding 200-bit window (167 ms at 1200 baud).
V.22 idle (calling-modem-side scrambler-on-1s) descrambles to all
1s, so a synchronised descrambler produces ~0% zeros. An unsynced
or partially-synced descrambler produces ~50% zeros (random).

Constants:
  * `LOCK_WINDOW_BITS = 200`
  * `LOCK_THRESHOLD_ZEROS = 5` (2.5% — generous enough to allow
    transient glitches, far below random)

State machine: starts `unlocked`. When the sliding-window zero
count drops to ≤ threshold, transitions to `locked`. **Stays
locked** through user-typed character bursts (typed characters
produce ~10–15% zero rate over short windows but the descrambler
itself remains synced because the scrambler at the other end is
still running). Releases lock only when the upstream carrier gate
drops (call ends or sustained signal loss).

The byte-emission gate now blocks on:
```
blockedByCarrier = enableCarrierGate && !signalPresent
blockedByLock    = enableLockGate    && lockState !== 'locked'
emit only if (!blockedByCarrier && !blockedByLock)
```

Default-on; opt-out via constructor flag `enableLockGate` for
diagnostic comparison and for direct-drive tests of `_onDataBit`.

**Empirical impact on phase-4c capture:**

|                              | Lock OFF (4c) | Lock ON (4d) |
|------------------------------|--------------:|-------------:|
| Total bytes                  |           349 |          213 |
| Early junk (<12s)            |           151 |       **45** |
| Late junk (≥12s)             |             2 |            2 |
| Lock edges                   |             — |            3 |

The 3 lock edges trace the call's actual training-phase structure:
  * t=6.28s — lock acquired (first time descrambler hits ≤5 zeros
    in 200-bit window)
  * t=7.11s — unlocked (carrier_down: the calling-modem 600 ms
    silence at t=7.05–7.65s)
  * t=9.37s — lock re-acquired

Lock-state transitions match the underlying channel events
exactly. The 70% reduction in early-call junk (151 → 45) is purely
from suppressing bytes during the unlocked windows.

The 45 residual early-junk bytes are emitted between t=6.28 (lock
acquired) and t=7.11 (carrier dropped) — a real descrambler-locked
window during the unstable t=6–7s period, where symbol decisions
were still glitchy enough to produce some garbage despite the
descrambler test passing. Could potentially tighten the lock
criterion further (e.g., require N consecutive locked windows, or
drop threshold to 2/200) to suppress these too. The current values
are biased toward "engage as soon as plausible" so user input
isn't clipped on the legitimate side.

**Legitimate user input is preserved.** The captured user
keystrokes (`bbs.birdenuf.com:2003`, `synexo`, `soulvirus`, `cc/`,
`x`, `y`, `quit`) are intact in both gate-on and gate-off runs.

**Tests:** 22 pass / 0 fail / 0 skipped in v22-loopback (was 18/0/0
in phase 4a). Four new tests added:
  * Random bits never engage lock (5000 random bits, lockState
    stays unlocked, 0 bytes emitted).
  * Sustained 1-bit stream engages lock at the 200-bit threshold.
  * Lock is sticky through real-data zero bursts (UART-framed
    byte after lock doesn't drop the lock).
  * Bytes flow correctly once lock is established.

Total across all suites: 76 pass / 0 fail / 0 skipped.

**Future work:**

  * **Tighter lock criterion** — if the 45 residual junk bytes
    still cause user-visible corruption, candidates are: require
    2+ consecutive locked windows, or drop threshold to 2/200.
    This trades some "time to first byte" against junk
    suppression. Defer until real-world testing data motivates
    the change.
  * **Hysteresis on the lock gate?** Currently one-way per call
    cycle (lock → stays locked until carrier drops). If we observe
    real mid-call descrambler desync events that need re-locking
    *without* a full carrier-drop event, we'd need to add unlock-
    on-prolonged-high-zero-rate logic. Not seen in any captures so
    far.
  * **Apply the same gate pattern to FSK protocols** (V.21 /
    Bell103 / V.23). Their descramblers — well, V.21 has none, so
    the analogous gate would be UART-framing-confidence based on
    the start/stop bit consistency rate. Different mechanism, same
    spirit. Logged from prior phases.

### V.22 native fix — phase 4c of N (April 2026)

Phase 4c of the V.22 native fix work. Shipped as files
`Handshake.js` and `Handoff.md`.

**The fix is one constant.**

```js
// In src/dsp/Handshake.js, V.22/V.22bis Te silence:
const teMs = 150;   // was: 75
```

**What this fixes (regression introduced in phase 2):**

The phase 2 cleanup removed spandsp entirely from the codebase.
What we missed at the time: spandsp had its own internal training-
stage silence (`V22BIS_TX_TRAINING_STAGE_INITIAL_TIMED_SILENCE`)
that added an additional 75 ms of silence between ANS-tone end and
USB1 training-signal start, on top of whatever silence the call
wrapper provided. So the **effective Te silence** on the wire was:

  * spandsp era: 75 ms (Handshake.js) + 75 ms (spandsp internal) = 150 ms
  * Phase 1–4b:  75 ms (Handshake.js) + 0  (spandsp removed)     = 75 ms

The user's hardware modem appears to need approximately 150 ms of
post-ANS silence to fully reset its detection state before training
begins. With only 75 ms it starts decoding the early USB1 symbols
before its post-ANS detector has settled, producing bit errors that
compound through the rest of the call. The user-visible symptom
was garbage characters in the terminal even after the phase-4a
self-loopback fix and phase-4b TX amplitude fix.

This was diagnosed by direct empirical comparison of TX wav captures
from spandsp era (working) against phase-4b TX wav captures (still
corrupting) on the same wire. After ANS ends:

  * Spandsp captures: 150 ms of zero RMS, then full data RMS = 0.1397
  * Phase-4b captures: 70 ms of zero RMS, then full data RMS = 0.1396

Everything else — the ANS phase, the data-phase amplitude, the
constellation precision, the bit-level content, the pulse shape —
was already byte-for-byte equivalent to spandsp. Only Te was off.

The same pattern likely held in earlier captures from phases 4a and
phase 4b — but the level mismatch (phase 4b fix) and the timing
alignment problem (phase 4a fix) masked the Te issue, since every
fix made things modestly better but didn't fully address the
hardware modem's training. With those resolved, Te is the remaining
diff.

**What this does NOT fix (yet):**

The phase-4 features (Costas/LMS/AGC) remain defaulted off as in
phase 4a. The remaining real-wire bit-error bursts during V.22 idle
(traced in phase 3 and phase 4 work) are a separate issue not
affected by Te timing.

**Verification:**

  * 72/0/0 tests still pass.
  * Te change is purely in the handshake state machine; doesn't
    affect modulation, demodulation, scrambler, or any other code
    path.

**Caveat:**

I cannot guarantee from analysis alone that this will fully fix
the user's interop issue. The comparison evidence strongly suggests
Te is the remaining major differentiator vs spandsp era, but there
may be other subtle differences in training-pattern timing or
content (USB1 duration, S1 segment, scrambler init state) that
also contribute. If garbage persists after this drop, the next
investigation step is bit-level diff of training-pattern timing.

### V.22 native fix — phase 4b of N (April 2026)

Phase 4b of the V.22 native fix work. Shipped as files
`V22.js` and `Handoff.md`.

**The fix is one constant.**

```js
const PEAK_TARGET = 0.32;    // was: 0.25
```

**What this fixes:**

The user-reported TX-side corruption (garbage characters appearing
in the user's terminal after `CONNECT> ` from synthmodem, leading
to spurious `CONNECT>` re-prompts and connection failures) turned
out to be caused by synthmodem transmitting at a level ~2 dB lower
than the spandsp-era code on the same wire. This was discovered by
direct empirical comparison of TX wav captures from spandsp era
(working) vs current code (corrupting):

| Source                | Steady-state RMS | Peak | Data-phase target |
|-----------------------|-----------------:|-----:|-------------------|
| spandsp era (working) |           0.1397 | 0.286|  -14 dBm0         |
| Phase 4a (corrupting) |           0.1093 | 0.222|  ~ -16 dBm0       |
| Phase 4b              |           0.1400 | 0.284|  -14 dBm0 (matched)|

The handshake / training / silence / ANS phases were already
byte-for-byte identical between spandsp and our code — both ramp
through ANS at 0.1061 RMS, both at exactly the same timing
(silence to 1.8s, then ANS to 5.2s). The divergence happened only
at the data-phase transition, where spandsp jumps to 0.1398 RMS
while we jumped only to 0.1092 RMS. Everything else — pulse shape,
crest factor, scrambler timing, dibit ordering, differential
encoding direction — was already correct.

The user's hardware modem — like all hardware modems — fixes its
slicer thresholds during training based on the initial signal
power. Applying those thresholds to a 2 dB quieter steady-state
signal pushes some boundary symbols across the wrong threshold,
producing occasional bit errors which manifest as scattered byte
errors in the descrambled output.

When the user added `AT&Q0+AT+MS=V22,0,1200,1200` modem options,
those flags forced V.22 1200-baud-only operation and disabled some
of the modem's auto-AGC/EQ adaptation, which made the thresholds
tighter and apparently more tolerant of the quieter signal. That's
why those caller options "essentially perfectly" worked — they
worked around the level mismatch.

**Why this wasn't found earlier:**

  - Self-loopback worked at any amplitude because both sides scale
    proportionally. Tests passed with PEAK_TARGET 0.15, 0.25, or 0.32
    — the loopback metric is meaningless for absolute level.
  - Real-wire RX-side captures looked OK because the calling modem
    transmits at its own (correct) level, which our RX handles.
  - The TX-side problem only shows on the calling modem's side,
    which we can't directly see — we only see its eventual decoded
    output (the corrupted display).
  - Prior phase notes had the comment "0.25 places RMS at -14 dBm0"
    which under-estimated the QAM-vs-sine RMS conversion factor.
    The math suggested we were at the right level when we weren't.

**Why empirical level matching is the right approach:**

Spandsp's TX power formula `sig_gain = 0.4490 *
db_to_amplitude_ratio(sig_power - DBM0_MAX_SINE_POWER) * 32768.0 /
TX_PULSESHAPER_GAIN` references a specific pulse-shaper gain
constant tied to spandsp's coefficient tables. Our SRRC coefficients
are scaled differently, so the absolute math doesn't transfer
directly. But a hardware modem on the same wire only cares about
the **measured RMS at the line interface** — so matching that
empirically is exactly correct, and free of any transferable
spandsp-specific constants.

**Empirical verification:**

Generated 5 seconds of synthesized scrambled-1s idle from our
modulator with PEAK_TARGET=0.32:

  - Measured RMS: 0.1400 (spandsp baseline: 0.1397, error 0.2%)
  - Measured peak: 0.2836 (spandsp: 0.2856, error 0.7%)
  - Crest factor: 2.03 (spandsp: 2.04, identical)

Match within measurement noise.

**No other code changes.** Phase 4a's `_symPhase = 0` fix and the
phase-4 features (Costas/LMS/AGC) defaulted off remain unchanged.
The amplitude fix is purely in V22.js.

**Future work:**

  - **The remaining bit-error bursts on real-wire idle** (5 spurious
    CRs in cap-tx, 0 in cap-tx2 from earlier phases) may now be
    reduced by improved hardware-modem tracking due to better TX
    levels, but were not the symptom this fix directly addresses.
  - **PEAK_TARGET tuning for V.22bis** when that protocol comes
    on-line — V.22bis 16-QAM has higher peak/RMS ratio and may
    need a different value to stay clear of full-scale.

### V.22 native fix — phase 4a of N (April 2026)

Phase 4a of the V.22 native fix work. Shipped as files
`V22Demodulator.js`, `v22-loopback.test.js`, and `Handoff.md`.

**The headline fix is one line.**

```js
this._symPhase = 0;          // was: this._symPhase = SPS / 2;
```

**What this fixes:**

The demodulator's symbol-strobe phase accumulator was initialised to
`SPS/2` at construction and on `reset()`, intending to "sample at the
middle of each symbol". This was wrong. The modulator's pulse-shaped
symbol peaks land at integer multiples of `SPS` samples after the
first symbol's start (offset by `RRC_SPAN/2 * SPS`, which is itself
a multiple of `SPS`). Initialising the strobe phase to `SPS/2`
therefore placed every demod sampling instant exactly halfway
between the modulator's pulse peaks — the worst possible alignment.

Result was 50%-attenuated symbols, severe inter-symbol interference,
and a ~9% raw symbol error rate even with a noise-free signal path.
Real-wire calls partly worked because Gardner timing recovery (added
in phase 3) converged the timing toward the optimum within a few
hundred symbols. Synthetic self-loopback failed unrecoverably
because Gardner is gated on signalPresent + post-warmup, and the
test signal was already wrecked by the time Gardner could engage.

This was the cause of:
1. The pre-existing self-loopback test failures we'd been skipping
   for several phases ("matched filter / differential phase reference
   warmup bug" was the wrong diagnosis).
2. The user-visible interop corruption with hardware modems on long
   calls. Even though Gardner pulled timing toward optimum on
   real-wire signals, the bit error rate during the convergence
   period and during transient drift events let occasional wrong
   dibits slip into the descrambler, producing spurious bytes (most
   commonly `0x0d` CR, because of how UART framing aligns on
   bit-error patterns from the V.22 64-ones-rule inversions).

**Diagnostic chain that led to the fix:**

User submitted a capture with the symptom `CONNECT>` prompt
reappearing repeatedly without any user input. Initial hypotheses
ranging through hardware-modem-side issues, TX-side modulator bugs,
and missing demod stages (Costas/LMS/AGC) all turned out to be
wrong. The actual breakthrough came from running the synthmodem TX
audio back through the synthmodem demod, which — combined with the
historical "self-loopback is broken" workaround — pointed at a
fundamental TX/RX mismatch. Symbol-by-symbol comparison of TX vs RX
dQuad sequences in synthetic self-loop showed the demod's I/Q
values stuck near (1.5, 0.5)-magnitude regardless of TX state — the
matched filter producing inter-symbol-interference noise instead of
crisp constellation points. The fix was to align sampling.

**Empirical impact on real-wire captures:**

| Capture        | Phase-3 emit | Phase-4a emit | Notes                           |
|----------------|-------------:|--------------:|---------------------------------|
| cap1           |          136 |           175 | Idle-only, no real data         |
| cap2           |          298 |           247 | Live BBS session                |
| cap3           |           96 |            47 | V.22 forced + AT&Q0             |
| cap-phase2     |          361 |           386 | Earlier test                    |
| cap-phase3     |          243 |           184 | 234s call (the "best yet")      |
| cap-tx         |          195 |           183 | First TX-corruption capture     |
| cap-tx2        |        ~195* |           133 | Second TX-corruption capture    |

*Phase-3 number for cap-tx2 was with phase-4 default-on; phase-4a
defaults phase-4 features off, hence the comparable cleaner result.

The most striking improvement is cap-tx2, where the spurious-CR
problem (which caused the `CONNECT>` re-prompts the user observed)
went from non-zero to exactly **0 CR bytes** for the entire call.
On cap-tx, the spurious-CR count remains 5 — those are real-wire
bit-error bursts, separate from the timing-alignment issue and
unfixable by demod-only work.

**Phase-4 features defaulted OFF (Costas/LMS/AGC):**

Phase 4 also added one-shot AGC, Costas carrier-tracking, and
complex LMS equalizer code. All three are in place but defaulted
**off** for shipping:

  * `enableOneShotAgc = false`
  * `enableCostas = false`
  * `enableEqualizer = false`

These can be re-enabled via constructor flags for offline
experimentation. They're left in the code (and continue to
participate in the diagnostic-sink event stream) because:

  - The one-shot AGC alone is small and stable.
  - Costas and LMS are tightly coupled to AGC and slicer-target
    scale; they can't be enabled independently without subtle
    breakage.
  - LMS divergence in our pipeline is borderline-stable: the
    convergence criterion μ·trace(R) ≈ 2.5 is right at the edge of
    classical stability bounds. Tap-runaway resets fire ~100×/call
    on real-wire captures, indicating LMS is reset more than it
    converges. For V.22 (4-point constellation, points well-
    separated) the equalizer adds complexity without measurable
    benefit. For V.22bis (16-QAM) it'll be necessary, but that
    work is parked until V.22 is fully wire-stable.

The `_symPhase = 0` fix alone produced the user-visible improvement.
Costas/LMS/AGC didn't.

**Self-loopback tests now passing:**

The four tests previously skipped with `PRE-EXISTING: V.22 self-
loopback is broken` now pass:

```
test('V.22 self-loopback: short ASCII string round-trips', ...)
test('V.22 self-loopback: 32-byte payload round-trips', ...)
test('V.22 self-loopback at 2400 Hz answer carrier', ...)
test('V.22 self-loopback works with BPF/AGC disabled (parity check)', ...)
```

The `loopbackBytes` helper now runs 250 ms of idle audio through
the modulator/demodulator pair before writing data, so the matched
filter and descrambler register sync up before user data arrives.
This mirrors what real V.22 protocol does naturally via training/
preamble. Without the warmup, the descrambler register starts in
the all-zeros state while the scrambler has been advancing through
its idle pattern; the first ~17 bits would be garbled until self-
synchronisation kicked in.

The helper's BPF/AGC defaults were also flipped (true → false) to
match the post-phase-2 production defaults; the legacy phase-1 BPF
has a Q value too narrow for the 1200/2400 Hz V.22 carriers and
distorts the symbol shape enough to defeat the new sampling
alignment.

**Test counts:** 18 pass / 0 fail / 0 skipped (was 14 pass / 4 skipped).
Total across all suites: 72 pass / 0 fail / 0 skipped.

**Future-work notes captured during phase 4a:**

  - **Stabilise LMS for V.22bis prep.** The phase-4 LMS code as-is
    is unstable. Real fix likely requires (a) lower per-tap step
    size, (b) stricter slicer gating during convergence, (c)
    proper power-meter-based AGC rather than the symbol-magnitude
    proxy we use. This work is non-trivial and parked.
  - **Costas could probably be re-enabled separately** once we have
    correct slicer targets without the equalizer in the loop. The
    current Costas implementation requires AGC-locked, which
    requires phase-4 AGC, which is currently coupled to the
    equalizer. Decoupling these is a small refactor but not
    urgent.
  - **The remaining real-wire bit-error bursts** (5 spurious CRs in
    cap-tx, 0 in cap-tx2) appear to be transient amplitude/timing
    perturbations during otherwise strong-signal periods. They're
    consistent with momentary symbol-decision errors at quadrant
    boundaries. Won't be fixed by demod work alone — would need
    confidence-weighted slicing or descrambler-output gating
    ("hush during locally-pure-1s output"). Logged for future.

### V.22 native fix — phase 3 of N (April 2026)

Phase 3 of the V.22 native fix work. Shipped as files
`V22Demodulator.js`, `decode-rx-capture-timed.js`,
`v22-loopback.test.js`, and `Handoff.md`.

**What this drop does:**

1. **Gardner timing recovery** — the headline fix. Adapts the
   symbol-sampling phase using a Gardner detector, integrate-and-dump
   accumulator, and small phase nudges. Solves the cap-phase2 case
   where symbolMag drifted from 1.5 → 1.0–1.2 over the call as
   sample-rate slip accumulated, producing increasing decode errors.
   Empirical wire-clock drift between user's hardware modem and
   synthmodem measured at ~22 ppm, well within V.22 spec tolerance
   but enough to fully wreck a fixed-timing demod.

2. **Diagnostic instrumentation** via optional `debugSink` callback.
   When null (production default), zero overhead. When set, receives
   structured events: per-symbol decisions, Gardner timing kicks,
   carrier-edge events. Used by the offline tools (`--gardner-log`
   flag) and by future test code. Designed so logs can be trivially
   silenced — no `console.log`s anywhere in the demod itself.

**How Gardner is implemented:**

Per spandsp's `v22bis_rx.c:symbol_sync()` algorithm, adapted to our
floating-point pipeline:

- **Mid-symbol matched-filter capture.** When `_symPhase` crosses
  SPS/2 (halfway between symbol strobes), an extra matched-filter
  convolution captures the mid-point I/Q. This is the only added
  per-sample DSP cost and is gated behind `enableGardner` so it
  can be disabled for diagnostic comparison.

- **Per-symbol error metric.** At each symbol strobe, compute
  `err = (curr.re − prev.re) · mid.re + (curr.im − prev.im) · mid.im`.
  The sign of `err` indicates timing direction (positive = sampling
  late, negative = sampling early).

- **Sign-only integrate-and-dump.** Per-symbol error sign accumulates
  into `_gardnerIntegrate` (steps of ±1). When `|integrate| ≥ 16`,
  `_symPhase` is nudged by ±0.05 samples and the integrator is
  cleared. The threshold of 16 means ~26 ms of sustained bias is
  needed before any timing correction — slow enough to ignore
  single-bit slicer errors, fast enough to track real drift.

- **Gated by signal-presence.** Gardner only runs when the carrier
  gate (phase-2) reports `_signalPresent: true` AND the warmup
  counter is satisfied. During silence or warmup the integrator
  stays at zero and no kicks fire. This avoids chasing noise.

- **Reset on signal-loss edge.** When the gate transitions from
  present → absent, all Gardner state (integrator, prev-symbol
  reference, mid-symbol capture flag) is cleared along with the
  other phase-2 flush. Gardner re-acquires from scratch on next
  signal arrival.

**Empirical results across all four real-modem captures:**

| Capture | Phase-2 emit | Phase-3 emit | Reduction | Gardner kicks |
|---------|-------------:|-------------:|----------:|--------------:|
| cap1 (idle, no connection) | 1769 | **136** | **−92%** | 229 |
| cap2 (live BBS session)    | 3233 | **298** | **−91%** | 418 |
| cap3 (V.22 forced + AT&Q0) | 3351 | **96**  | **−97%** | 524 |
| cap-phase2 (recent test)   | 3834 | **361** | **−91%** | 540 |

The reduction comes from two compounding effects:

1. **Correctly-decoded bytes during signal-present periods**. Without
   Gardner, sample-rate slip caused the matched filter to produce
   off-peak outputs, the slicer to make wrong dibit decisions, and
   the descrambler to emit garbage. With Gardner tracking the timing,
   matched-filter outputs land on peak, slicer decisions are clean,
   and the descrambler emits the correct V.22 idle pattern bytes
   (0x11/0x91) during line-idle periods — which the byte-emission
   logic recognizes and pass through normally, but they're cheap
   "I'm idle" bytes rather than "I'm garbage" bytes.

2. **symbolMag stability**. Pre-phase3 trajectory drifted 1.5→1.2 over
   the call. Post-phase3 it stays at 1.53–1.56 throughout the
   entire 138-second cap-phase2 capture. Symbol energy lands on the
   matched-filter peak, decisions are made on full-energy points,
   and the demod stays locked.

**V.22 idle pattern detection** as a quality marker. The V.22 idle
scrambler running on input = all-1s produces a known repeating
sequence that, when decoded correctly, frames as alternating bytes
0x11 and 0x91 in the UART output. Pre-phase3 we saw idle-pattern
bytes at 0.1–0.2% of total emission (essentially noise). Post-phase3
the cap-phase2 capture shows **21.1% idle-pattern bytes during the
quiet stretches** — the demod is genuinely tracking the V.22 carrier
and decoding what's actually on the wire.

**Wire-clock drift measurement.** Across the cap-phase2 capture's
540 Gardner kicks, 504 advanced phase and 36 retarded — a 14:1 bias
indicating consistent clock-rate difference between calling modem
and synthmodem. Net 504 − 36 = 468 effective phase advances at
0.05 samples each = 23.4 samples drift over 138 seconds, or
~22 ppm of clock-rate difference. Within V.22 spec (±100 ppm
allowed) but more than enough to fully break a fixed-timing demod
within seconds.

**Architectural placement** of Gardner: inline in the per-sample
process() loop alongside the existing matched-filter pipeline.
Not implemented as a separate Primitives class — the existing
`GardnerTiming` in `Primitives.js` is real-valued only and replaces
symbol-strobe logic entirely, neither of which fits our pipeline.
The new code is ~50 lines in V22Demodulator.js with full inline
documentation.

**Diagnostic sink design rationale:**

Production code MUST pass `debugSink: null` (or omit it entirely;
that is the default). The sink receives event objects of three
types:
- `{ type: 'symbol', t, mag, I, Q, dQuad, signalPresent }` — fired
  every symbol (~600/sec). Used by offline analysis to characterize
  per-symbol behavior.
- `{ type: 'gardner_kick', t, integrated, samplesNudged, newSymPhase }`
  — fired whenever Gardner crosses threshold and applies a phase
  correction. Used to visualize Gardner aggressiveness over time.
- `{ type: 'carrier_edge', t, edge: 'up'|'down', mag }` — fired
  when the carrier gate flips, mirroring the corresponding
  `carrierUp` / `carrierDown` events emitted via EventEmitter.

The sink is set at construction and persists across `reset()` calls
(consumer code may want to collect telemetry across protocol
restarts). When unset, the per-symbol overhead is a single null
check — verified to not impact existing test timings.

**Subsequent drops (planned, not in this drop):**

1. **FSK carrier gate.** V.21 / Bell103 / V.23 demodulators all
   have the same problem the V.22 code had pre-phase2: they emit
   bytes from line noise during silence. The phase-2 gate pattern
   (power threshold + hysteresis on a smoothed magnitude metric +
   state flush on signal-loss edge) applies directly. The FSK
   power source needs adapting (mark-tone power vs space-tone
   power, or sum of both) but the structure is identical.
2. **Costas carrier tracking** for V.22. After Gardner, this is
   the next loop. With current results (~22 ppm clock drift fully
   tracked by Gardner), Costas may have less to do than expected
   — Gardner is implicitly absorbing some of what Costas would
   otherwise correct. Worth measuring before / after to see how
   much Costas adds.
3. **Complex LMS equalizer** for V.22. Channel-response correction.
4. **V.22bis port** once V.22 is fully wire-stable.

**Future-work notes captured during phase 3:**

- **Live-call quality metrics.** The offline %print/%junk metric
  remains heuristic. Idle-pattern fraction is a useful new metric
  (post-phase3: 21% on cap-phase2 vs 0.5% pre-phase3) and could
  be promoted to a per-second tracking number in the offline tool.
- **Gardner threshold tuning.** Threshold = 16 was chosen as a
  direct port from spandsp; we haven't optimized it for our
  floating-point pipeline. Lower threshold = faster adaptation
  but more jitter; higher = slower but smoother. The current
  value works well empirically; could be tunable later.
- **Synthetic V.22 self-loopback still broken.** Not a regression
  from any phase, just remains. Gardner doesn't fix it (the bug
  is in matched-filter warmup state machinery, not in timing
  tracking). Logged in earlier phases.

### V.22 native fix — phase 2 of N (April 2026)

Phase 2 of the V.22 native fix work. Shipped as files
`V22Demodulator.js`, `decode-rx-capture-timed.js`,
`v22-loopback.test.js`, and `Handoff.md`.

**What this drop does:**

1. **Carrier-presence gate** — the headline fix. Suppresses `data`
   emission when no V.22 carrier is detected on the line. Solves
   the cap1 case (no connection, but the demod was producing 2055
   bytes of pure line-noise garbage that got forwarded to telnet)
   and reduces user-visible terminal junk during silent stretches
   of every connected call.

2. **BPF and AGC defaults flipped to false.** The phase-1 BPF and
   AGC additions were empirically net-negative on real-modem
   captures (BPF Q values too narrow for V.22's 600 Hz baud rate;
   AGC convergence too slow — pinned at 10× during silence and
   took ~50 s to converge once signal arrived). Code retained for
   diagnostic comparison via the `enableBpf` / `enableAgc`
   constructor flags. May be removed in a future cleanup once
   it's clear the structural pieces aren't needed.

3. **UART resync improvement retained** unchanged from phase 1.
   The "emit byte regardless of stop bit" change is a clear win
   on its own and is independent of the BPF/AGC question.

**How the gate works:**

The gate uses spandsp's approach (cf. `v22bis_rx.c` lines 877–897)
adapted to our pipeline: hysteresis on power-meter output, with
state flush on signal-loss edge. Specifically:

- Power source: `_symbolMagSmoothed` — the smoothed magnitude of
  the matched-filter symbol output, already computed for handshake
  remote-detection. Naturally rejects out-of-band noise (1800 Hz
  V.32 Signal AA tones, line hum, voice prompts) since it sits
  after the matched filter.
- On-threshold 0.04, off-threshold 0.02. The 2× hysteresis
  matches standard practice (≈3 dB). The off-threshold aligns
  with the existing `V22_REMOTE_MAG_THRESHOLD = 0.02` floor used
  by V.22 handshake. Empirically observed values on real
  captures: silence ≈ 0.001, V.22 carrier 1.0–1.5 (50× the
  on-threshold), plenty of margin.
- On `signalPresent: true → false` edge, flush state that would
  be invalid when next signal arrives: UART framer (a partial
  byte must not "complete" with a fresh-signal bit), differential
  phase reference, warmup counter, descrambler shift register.
- Emits `carrierUp` / `carrierDown` events on edges. The V22 /
  V22bis protocol classes don't currently subscribe; this is a
  decoupled API set up for a cleaner state machine in future work.

**Architectural placement of the gate (per spec review):**

Narrow gate on `_onDataBit` emission only — symbol processing,
matched filter updates, `_symbolMagSmoothed` tracking, and the
V.22bis S1 detection ring buffer all continue to run during
no-signal periods. This keeps handshake-time logic working
correctly across calls. Only the user-data byte stream is gated.

**Empirical results on the three real-modem captures shipped
with this work:**

| Capture | Phase-1 emit | Phase-2 emit | Suppressed | Reduction |
|---------|-------------:|-------------:|-----------:|----------:|
| cap1 (idle, no connection) | 2487 | 1769 | 714 | −29% |
| cap2 (live BBS session)    | 3953 | 3233 | 715 | −18% |
| cap3 (V.22 forced + AT&Q0) | 4011 | 3351 | 660 | −16% |

Each capture sees ~660–715 bytes of suppression — accounting for
the leading silence (4–6 s) plus the V.32 AA fallback period
(~3 s). Once the calling modem is actually transmitting V.22
carrier, the gate lets bytes flow normally. **Note this is the
visible-terminal-relevant reduction**: the suppressed bytes are
specifically the ones that would have been forwarded to
telnet → BBS as fake user input and echoed back as visible
garbage in the user's terminal.

**Diagnostic findings from this work (worth recording):**

The phase-1 drop's offline-tool numbers were misleading because
the analysis was run on the wrong side of the call. The RX wav
(audio FROM calling modem TO synthmodem) carries only the user's
keystrokes plus idle scrambler — a few real bytes against a sea
of mostly-junk-decoded noise. The TX wav (synthmodem TO calling
modem) carries the BBS content. My phase-1 "+95% printable"
claim came from decoding the RX side and finding more bytes of
noise that happened to fall in the printable ASCII range, not
from any genuine quality improvement on user-visible output.

A correct quality assessment requires either (a) decoding the
TX wav with synthmodem's *own* demodulator (a self-loopback
which today is broken — see phase-1 deferred items) or (b)
comparing the live transcript side-by-side with what the offline
tool decodes from the RX wav. Both are beyond this drop's scope;
flagged for future work.

The cap3 transcript ("AT&Q0 + AT+MS=V22,0,1200,1200" call,
which performed visibly better than cap1/cap2) was investigated
in detail. The marked improvement is from three independent
factors:

1. `AT&Q0` disables V.42 LAPM — no V.42 ODP/ADP detection
   patterns on the wire after training. Synthmodem can't
   respond to them, and during the timeout the calling modem's
   wire activity is non-data signaling that confuses our demod.
2. `AT+MS=V22,0,1200,1200` forces V.22 (4-point DPSK) only —
   no V.22bis 16-QAM constellation ambiguity in the slicer.
3. The two together mean cap3 enters data mode in a clean
   state without leftover negotiation residue that cap1/cap2
   carry through their early seconds.

Importantly, **cap3 still degraded over time** — the cleaner
start did not produce a permanently clean call. The transcript
shows clean text up through the LORD intro screen, then progressive
corruption, ending in "NO CARRIER" (calling modem dropped the
call, manually verified). This is consistent with cumulative
phase/timing drift past the demod's tolerance — the kind of
issue Gardner timing recovery and Costas carrier tracking are
designed to address. Logged for future-phase work.

The byte-distribution analysis also ruled out a previously-held
hypothesis: cap1/cap2 are **not** in V.42 LAPM/HDLC mode (verified
by checking byte histograms — HDLC framing through our async UART
would produce >99% 0x7E; we see 0xFF at 12-14% instead). All three
captures are in async mode. The root cause for cap1/cap2 vs cap3's
quality difference is the negotiation-state-during-data point, not
sync-vs-async framing.

**spandsp comparison summary:**

Reading the spandsp `v22bis_rx.c` source end-to-end revealed the
following architectural differences from our PUREJS code (in rough
order of impact on the kind of issues the user reported):

| Feature | spandsp | PUREJS pre-phase2 | PUREJS post-phase2 |
|---------|---------|-------------------|---------------------|
| Carrier-presence gating | yes (power meter + hysteresis, restart on drop) | none | yes ✓ |
| AGC | one-shot during symbol acquisition, then locked | continuous slow-converge (broken) | off (code retained) |
| Pulse shaping | quadrature pair → complex baseband direct | NCO mix + real SRRC matched filter | unchanged |
| Symbol timing | Gardner with integrate-and-dump | fixed phase | fixed phase (deferred) |
| Carrier tracking | PI loop on slicer error | none | none (deferred) |
| Equalization | adaptive complex T/2-spaced LMS | none | none (deferred) |
| Training stages | multi-stage state machine, per-stage loop gains | warmup-symbols counter | unchanged |
| Signal-loss recovery | full restart on carrier drop | none | flush-state-on-edge ✓ |

Phase 2 closes the **carrier-presence gating** and (partially)
the **signal-loss recovery** rows — the two highest-impact items
from the user-visible-garbage perspective. Symbol timing,
carrier tracking, and equalization remain for subsequent phases.

**Subsequent drops (planned, not in this drop):**

1. **Gardner timing recovery** — replaces the fixed
   `_symPhase = SPS / 2` with a tracking loop. Addresses the
   "cap3 progressive corruption" symptom: cumulative sample-rate
   drift between calling modem and synthmodem within a long
   call, which currently has no correction.
2. **Costas loop** — replaces the fixed-frequency carrier NCO.
   Addresses carrier frequency drift.
3. **Complex LMS equalizer** — addresses channel response
   distortion. Existing Primitives `LMSEqualizer` is real-only;
   needs a complex variant.
4. **V.22bis port** — once V.22 is wire-stable.

**Future-work notes captured during phase 2:**

- **Live-call quality measurement methodology.** Need a clean
  way to assess "did the user-visible terminal text improve."
  Currently we have: (a) live call observation by the maintainer
  (subjective, slow), (b) offline-tool RX-wav decoding (the
  phase-1 misleading metric), (c) comparing offline-tool output
  against the live transcript (manual, brittle). A future drop
  could add a per-second decoded-text matcher that scores how
  much of an expected-text snippet appears in the offline
  decode. Worth thinking about before the Gardner phase so we
  have a quantitative metric to evaluate it against.
- **The "cap3 dies" event.** The transcript ends in "NO CARRIER"
  which the user confirmed was the calling modem dropping the
  call (not a manual hangup, not synthmodem's silenceHangup).
  Possible causes: cumulative bit errors past whatever the BBS
  uses to detect garbage input; the BBS's idle timeout firing
  because actual user keystrokes weren't reaching it; the
  hardware modem itself losing carrier lock. We can't tell from
  this end without longer-window captures past the drop.

### V.22 native fix — phase 1 of N (April 2026)

After Phase 2 removed spandsp, the native V.22 / V.22bis demodulator
reverted to the historical pure-JS implementation that the spandsp
binding had originally replaced. Real-modem dial-in to that pure-JS
demod produces partial decoding — long clean stretches interleaved
with corruption bursts — because the demodulator has none of the
adaptive loops that spandsp ran continuously to keep the receiver
locked to the calling modem's clock and channel response.

The fix path is to wire the missing loops into the receive pipeline
in the canonical order: BPF → AGC → mix-to-baseband → matched
filter → Gardner timing recovery → Costas loop → LMS equalizer →
slicer. Phase 2 deliberately retained the AGC, CostasLoop,
GardnerTiming, LMSEqualizer, and Scrambler classes in
`src/dsp/Primitives.js` precisely so this work would have building
blocks ready.

Phase 1 of the fix (this drop) lays the structural groundwork and
adds the two cheapest, lowest-risk loops: BPF and AGC. Subsequent
drops will add Gardner, then Costas, then a complex-LMS variant
(the existing Primitives `LMSEqualizer` is real-valued only and
needs a complex extension for QAM).

Shipped in `synthmodem-v22-fix-phase1-v1.tar.gz`.

**What landed in this drop:**

#### Code organization
- New file `src/dsp/protocols/V22Demodulator.js`. Houses the
  demodulator + shared spec constants + SRRC helpers + V22Scrambler.
  Extracted verbatim from `V22.js` (modulo the additions below) so
  the file split itself is a no-op refactor.
- `src/dsp/protocols/V22.js` retains the modulator, the V22 / V22bis
  protocol classes, and their handshake state machines. Imports the
  demodulator from `./V22Demodulator`. Re-exports the moved symbols
  in its `module.exports` for backwards compatibility.
- V22.js drops from 1714 lines to ~1100; new V22Demodulator.js is
  ~580 lines.

#### Pre-pipeline additions (BPF + AGC)
- Bandpass filter at the head of the receive pipeline. Q=4 at 2400Hz
  carrier, Q=2 at 1200Hz carrier (the lower-frequency carrier needs
  a wider band to pass its 600 Hz baud sidebands). Implemented via
  `BiquadFilter.makeBandPass` from Primitives.
- AGC after the BPF. Target level 0.28 (matches the Phase-2-removed
  config default). Real-valued operation on input before complex
  conversion. Bypasses the legacy config-based instantiation path
  by passing a small cfg-shaped object directly.
- Both opt-in via constructor flags `enableBpf` / `enableAgc`,
  defaulting to true. Setting both to false reproduces the
  pre-v22-fix-phase1 demodulator behavior for diagnostic comparison.

#### UART resync improvement
- Previously, `_onDataBit` silently discarded any byte whose stop
  bit decoded as 0. On a noisy line where occasional single-bit
  slicer errors are common, that turned one corrupted bit into one
  DROPPED byte — and dropped bytes break visible text flow more
  than corrupted bytes do. After this drop, the byte is emitted
  regardless of stop-bit value.
- This is a one-byte change in scope but produces a measurable
  improvement on real-wire captures (see verification below).

#### Tests
- New file `test/native/v22-loopback.test.js`. 9 tests, 5 pass,
  4 skipped. The 5 passing tests cover: UART resync framer
  (direct `_onDataBit` test), BPF/AGC opt-in/opt-out,
  empty-input safety, RTP-sized chunk acceptance.
- The 4 skipped tests are synthetic V.22 modulator → V.22
  demodulator self-loopback at the same carrier. They are skipped
  with a header comment documenting that self-loopback is a
  PRE-EXISTING bug — verified by running the equivalent test
  against the pre-v22-fix-phase1 snapshot of the tree and
  reproducing the same garbage output. The tests remain in the
  file so they activate automatically when self-loopback is
  fixed in a future drop.

#### Tools delivered with this drop
- `tools/decode-rx-capture.js` — load a WAV and run the V.22
  demodulator against it, printing decoded bytes.
- `tools/decode-rx-capture-timed.js` — same, with per-second
  bucketed breakdown and `--no-pre` flag to disable the BPF+AGC
  pre-pipeline for diagnostic comparison.
- Both are useful for anyone debugging real-wire V.22 RX from a
  captured WAV (set `config.modem.captureAudio = true` in
  config.js to produce one).

**Verification on a real-modem capture:**

A 64-second RX capture from a real V.22 dial-in (calling modem at
1200 Hz originate carrier, synthmodem answering at 2400 Hz) was
decoded three ways:

| Config                        | Total bytes | Printable    | Junk |
|-------------------------------|-------------|--------------|------|
| Pre-fix (no changes)          | 1525        | 260          | 676  |
| UART resync only              | 1895 (+24%) | 375 (+44%)   | 883  |
| UART resync + BPF + AGC       | 2785 (+83%) | 506 (+95%)   | 1318 |

The UART change alone roughly doubles printable bytes; adding
BPF + AGC roughly doubles again. Each additive change clearly
contributes. Junk bytes also rise (not unexpected — the UART
change converts previously-dropped bytes into emitted-but-
sometimes-corrupted bytes), but absolute correctly-decoded text
nearly doubles overall.

Live-call validation by the maintainer is the gating criterion;
the offline numbers are just a sanity check that the pipeline is
not regressed.

**Subsequent drops (planned, not in this drop):**

1. **Gardner timing recovery.** Replaces the current fixed
   `_symPhase = SPS / 2` with a tracking loop driven by mid-symbol
   vs symbol-edge sample comparison. The existing `GardnerTiming`
   class in Primitives.js operates on real samples and outputs a
   single-channel symbol stream; for QAM the demod needs a complex
   variant or two coupled instances. This is the next loop to add.
2. **Costas loop.** Replaces the fixed-frequency carrier NCO. The
   existing `CostasLoop` is BPSK-only (decision-directed with
   `sign(I)*Q - sign(Q)*I` error metric); for QPSK/16-QAM it needs
   a different error function (`Im(target × conj(slicer_decision))`
   after the slicer). Costas + LMS share the same slicer-error tap
   and update simultaneously per symbol.
3. **Complex LMS equalizer.** The existing `LMSEqualizer` is
   real-valued only. For QAM, need a complex variant — 4 cross-
   coupled real taps, or use complex math directly. Decision-
   feedback path needs the slicer's QAM decision as the target.
4. **V.22bis port.** Once V.22 is stable on the wire, the V.22bis
   class (currently in V22.js, banner-flagged TESTING) gets the
   same pipeline. Most of the work is already shared because the
   demodulator handles both modes via `bitsPerSymbol`.

**Future-work notes captured during this work:**

- **V.22 self-loopback is broken.** Synthetic modulator →
  demodulator at same carrier produces garbage. Pre-existing,
  not introduced by this drop. Likely cause is the matched-filter
  warmup leaving `_prevI` / `_prevQ` in a state that the
  warmup-symbols logic doesn't actually correct for. Worth fixing
  for testability — would let us write proper synthetic test
  vectors with known signal characteristics.
- **UART framer affects FSK protocols too.** V.21, Bell103, and
  V23 all have the identical `if (bit === 1) emit; else drop`
  stop-bit pattern. The same noise-tolerant fix should apply to
  all four FSK protocols. Likely the next non-V.22 work after
  V.22 settles, before V.22bis.
- **V32bisAnswerer.js followup.** The deleted file (Phase 2)
  may have had spandsp-independent functionality (V.32 Signal AC
  signaling sequence is pure DSP). Worth investigating its git
  history to determine whether it ever worked end-to-end with
  the native backend, and if it did and the spandsp surface was
  shallow, whether to bring it back. That would let synthmodem
  respond to the V.32 Signal AA that real modems transmit during
  Automode fallback (currently it's ignored, costing ~5 seconds
  of pre-V.22 setup time on every call).
- **`config.modem.captureAudio` is native-only.** WAV captures
  on the slmodemd-pjsip backend require hooking `RtpBridge._forward`
  to emit per-direction WAV files. Logged in earlier handoff
  sections; not in scope for V.22 work.


### Step 6 (end-to-end BBS call) — complete

Verified 2026-04-24: incoming call from a real SoftK56 HSF softmodem
over a physical phone line → SIP INVITE → slmodemd-pjsip VM →
V.8 negotiation selects V.34 → V.34 training → CONNECT at 33600/21600
bps → post-train hold (6s) → TelnetProxy attaches → TCP to bbs.birdenuf.com:2323
→ BBS session, keystroke echo working, full interactive terminal.

After the modemd-ctrl rebuild (see next section), Node also gets
a structured `MODEM_STATUS {event:connect, rate:N}` frame on every
CONNECT so the rate appears reliably in `[PjsipBackend] CONNECT N`
log lines without dependence on PTY-text-line reassembly.

### V.34 stability tuning — SPA2102 ATA configuration

Long-duration testing revealed that V.34 retrain failures depended
heavily on the ATA's RTP timing settings. The known-good SPA2102
configuration for stable V.34 33600/21600 over PSTN is:

- **RTP packet size: 30 ms** (the SPA2102 default — counterintuitively
  better than 20 ms despite d-modem's internal frame size also being
  20 ms). PJSIP's reframing handles 30→20 cleanly, and the size
  mismatch gives the `jb_init=40ms` jitter buffer natural slack.
  Both 20 ms and 40 ms made V.34 distinctly less reliable.
- **Network Jitter Level: Low** — the biggest single win. Default
  "High" added ~150 ms buffering that interacted poorly with V.34's
  symbol-rate tracking. Low + 30 ms = 10+ minute idle stable runs.
- **Jitter Buffer Adjustment: Disabled** (mandatory — adaptive
  buffers drop or insert frames which corrupts modem signal).
- **Codec: G.711u forced** (Use Pref Codec Only).
- **Echo cancellation, VAD, silence suppression: all OFF**.
- **DTMF Tx Mode: Strict, DTMF Tx Method: InBand** (irrelevant
  during data mode but no harm).
- **Hook Flash Tx Method: none** (avoids spurious signaling).

The architectural lesson worth remembering: **the SPA's RTP packet
size and d-modem's internal frame size are independent.** PJSIP
reframes between them. A larger RTP packet size relative to the
internal frame size gives the jitter buffer more effective slack.

### VM-side line-aware modemd-ctrl rebuild — DONE

`vm/ctrl/modemd-ctrl.c` has been rewritten with line-aware emit
logic. Two production bugs are fixed at the source:

1. **Data_mode transition boundary fixed.** Previously
   `handle_pty_readable` did `wire_write(wire_type, ...)` BEFORE
   running transition detection. When slmodemd split a result line
   across two write()s — common pattern: result-code text first,
   then the trailing `\r\n` separately — the result code went out
   as AT_RESPONSE but the terminator went out as DATA_RX (data_mode
   had flipped). Node never saw a complete CONNECT line and waited
   indefinitely (production logs showed 128–168 seconds before
   stray bytes provided a terminator). The same shape applied
   symmetrically to NO CARRIER going out as DATA_RX bytes because
   data_mode was still true at read time.

   The new code scans the combined (pending + new) buffer for the
   transition keywords FIRST, splits the byte stream at the keyword
   boundary, and emits each portion with the correct wire type. If
   a keyword is present but its `\r\n` hasn't arrived yet, the
   keyword bytes are held in `pending_buf` (256 B) until the
   terminator completes the line; bytes BEFORE the keyword are
   still emitted immediately so keystroke latency is unaffected.

2. **MODEM_STATUS frame emission on CONNECT and NO CARRIER.** The
   new modemd-ctrl emits a JSON status event for each transition:
   `{"event":"connect","rate":21600}` and `{"event":"nocarrier"}`.
   Node's `_onCtrlFrame` MODEM_STATUS handler (added in the polish
   drop with first-wins semantics) consumes these to populate
   `_currentBps` / `_currentProtocol` reliably.

Test coverage: `test/ctrl/standalone.test.js` extended from 7 to
11 tests, including 4 new tests specifically for the line-splitting
cases. All pass. Full integration regression also passes against
the rebuilt rootfs (`make rootfs-pjsip` was run; the new binary is
in `vm/prebuilt/modemd-ctrl-i386` and baked into
`vm/images/rootfs-slmodemd-pjsip.cpio.gz`).

Node's `_maybeScheduleUnterminatedFlush` defensive debounce remains
in place as forward-protection. With the new VM image installed the
debounce will essentially never fire — line terminators always
arrive paired with their result codes — but the code adds no cost
in the steady state and is one less subtle thing to debug if a
future shim binary regresses.

### Latent chardev audit — April 2026 findings

Question raised: is there buffering on the wire path from modemd-ctrl
to TelnetProxy's outbound TCP that adds avoidable keystroke latency?

Path audited:
- VM: slmodemd PTY write → modemd-ctrl read → wire_write(DATA_RX)
- QEMU: virtio-serial chardev → TCP loopback socket (nodelay=on set)
- Node: controlSocket 'data' event → wire.Parser.feed → 'frame' event
  → `_onCtrlFrame` → `emit('data', payload)` synchronously
- CallSession: data handler `buf => this._telnet.receive(buf)`
  synchronously
- TelnetProxy: `this._tcpSocket.write(data)` to the BBS

Findings:
1. **QEMU chardev socket**: `setNoDelay(true)` on Node side,
   `nodelay=on` on QEMU's -chardev spec. ✓ No issue.
2. **Wire.Parser**: synchronous feed-then-emit. ✓ No issue.
3. **CallSession listener**: synchronous passthrough. ✓ No issue.
4. **TelnetProxy's outbound TCP socket is NOT configured with
   `setNoDelay(true)`.** Default Node sockets have Nagle ON. For
   a character-at-a-time remote-echo telnet session this adds up
   to ~40-200 ms (delayed-ACK window) per keystroke in worst case.
   **Not yet fixed — logged as a future item.** Trivial two-line
   change: `this._tcpSocket.setNoDelay(true)` after connect, and
   `this._tcpSocket.setKeepAlive(true, 30_000)` for long-lived
   sessions.

### Other deferred items

- **Test client (`test-client/index.js`) revival.** At some point
  we used it to place outbound calls for testing but it has bit-
  rotted through backend churn. Phase 5 territory in
  `CLEANUP.md`. Useful for automated regression calls without
  needing a physical phone. Likely first work on the next session.
- **TelnetProxy outbound TCP `setNoDelay(true)` + `setKeepAlive(
  true, 30_000)`.** Trivial 2-line fix in TelnetProxy.js; default
  Node sockets have Nagle ON which adds 40-200 ms (delayed-ACK
  window) per keystroke on character-at-a-time remote-echo telnet
  sessions. Not yet done; logged here. See "Latent chardev audit"
  above for the analysis.
- **UART resync logic for FSK protocols (V.21, V.23, Bell 103).**
  Logged April 28: V.22's UART improvements may benefit V.21 /
  V.23 / Bell 103 too, since all four use the same start-bit /
  8-data-bits / stop-bit framing pattern. Not yet evaluated.
- **slmodemd-pjsip-phase audio capture for `auto` mode.** Auto
  currently captures only the post-swap (native) portion of the
  call. Phase 4-5 territory in `CLEANUP.md`. Useful for diagnosing
  V.8-phase issues in auto mode without dropping back to a fixed
  `slmodemd-pjsip` backend just to capture.
- **Possible install script.** Mentioned during the documentation
  pass — would simplify first-time setup on Windows especially
  (QEMU path discovery, addon prebuilt verification, config.js
  default scaffolding).
- **Ctrl-chardev instrumentation is now debug-gated.** Automatically
  inert at `config.logging.level = 'info'` or higher. Set to
  `'debug'` to see the periodic summaries and gap-burst hexdumps
  for diagnosing future wire issues. See `_setupControlParser` in
  PjsipBackend.js.

---

## 1. Sandbox setup

### Environment
- Ubuntu 24.04 (gVisor), amd64, glibc 2.39
- Node 22+, gcc 13 with `-m32` multilib support
- `qemu-system-i386` for VM testing (tcg accelerator — no KVM in sandbox)
- Python 3 with numpy/scipy for audio analysis
- Bash tool, file tools (`view`, `str_replace`, `create_file`), `present_files`

### How the user interacts with you
- User is on Windows 10/11, QEMU TCG. They have a physical SoftK56 HSF
  softmodem connected to a real phone line for end-to-end testing.
- User uploads tarballs of changes into their GitHub → you'll pull from
  that GitHub to get a clean working copy.
- User runs tests on their Windows host by phoning in, captures the
  resulting files, and uploads them to you as a ZIP.
- You deliver new tarballs via `/mnt/user-data/outputs/`.

### Starting work
```bash
# Typical first steps at the start of a session
cd /home/claude
rm -rf synthmodem   # If an old copy is lingering
# User will have pushed the latest tarball to github beforehand:
git clone <user's github URL> synthmodem
cd synthmodem
# Read this file, plus any transcripts you need. Then dig in.
```

### Transcripts for historical context
`/mnt/transcripts/` contains full turn-by-turn logs of prior sessions.
`journal.txt` is the catalog.

**If `/mnt/transcripts/` is empty on your session** (likely — it's not
persisted across sandboxes), the user should upload
`synthmodem-context.tar.gz` alongside the main tarball. Unpack it:

```bash
mkdir -p ~/synthmodem-context
cd ~/synthmodem-context
tar -xzf /mnt/user-data/uploads/synthmodem-context.tar.gz --strip-components=1
ls
# README.md  dmodem-reference/  transcripts/
```

This pack contains:
- All prior conversation transcripts (~10 files, ~10 MB)
- A pruned copy of synexo/D-Modem for diffing (~560 KB, no pjproject
  bundle, no dsplibs blobs)

Most useful recent transcripts:

| Transcript | Topic |
|---|---|
| `2026-04-22-05-03-19-synthmodem-audio-pipeline-fix.txt` | Audio pipeline work, RTP concealment fix |
| `2026-04-22-16-16-17-synthmodem-frame-dup-investigation.txt` | Frame duplication investigation |
| `2026-04-22-19-13-50-synthmodem-clock-pump-handoff.txt` | Clock-pump design + lifecycle gating (the current candidate fix) |

Use `conversation_search` and `recent_chats` to find older context if
the pack isn't available — those also access the same transcripts via
a different mechanism.

---

## 2. Project at a glance

**SynthModem** is a SIP-attached modem gateway. Windows and Linux hosts
accept SIP calls, run an answering modem DSP against them, and proxy the
post-connect data stream to a Telnet target. The primary user case is
reaching vintage BBS systems from modern Windows over a VoIP line.

### Architecture

```
PSTN  →  SIP gateway  →  RTP  →  Node (src/)  →  TCP loopback  →  QEMU VM  →  slmodemd
                                                                               ↓ PTY
                                                                     modem-shim ← AT
                                                                               ↓
                                                                     Node ← TCP ← shim
                                                                       ↓
                                                                  TelnetProxy  →  target BBS
```

Two modem backends, selected by `config.modem.backend`:
- `native` — pure-JS DSP + spandsp C binding, supports V.21/V.22/V.22bis
  reliably, V.32bis+ is experimental
- `slmodemd` — proprietary Smart Link softmodem running in a Linux VM,
  supports up to V.90. This is the current focus.

### Key layers, Node side
- `src/sip/` — SIP UA (INVITE, 200 OK, ACK, BYE)
- `src/rtp/RtpSession.js` — RTP socket + jitter buffer (see §3 for mode)
- `src/backends/SlmodemBackend.js` — Node side of the VM interface
- `src/backends/ModemBackendPool.js` — pre-warmed VM pool, one per call
- `src/session/CallSession.js` — per-call state, bridges RTP ↔ DSP ↔ Telnet
- `src/telnet/TelnetProxy.js` — talks to the BBS

### Key layers, VM side
- `vm/images/bzImage` — Debian bookworm i386 kernel (frozen artifact)
- `vm/images/rootfs-slmodemd-pjsip.cpio.gz` — runtime initramfs (contains slmodemd + d-modem + modemd-tunnel + modemd-ctrl)
- `vm/prebuilt/slmodemd` — slmodemd binary, built in a bookworm VM
- `vm/prebuilt/d-modem` — D-Modem PJSIP integration, built in a bookworm VM
- `vm/prebuilt/modemd-tunnel-i386` — UDP-over-TCP tunnel (in-VM endpoint)
- `vm/prebuilt/modemd-ctrl-i386` — PTY ↔ control-channel bridge
- `vm/slmodemd/` — slmodemd source (D-Modem-derived, see §7)
- `vm/d-modem/d-modem.c` — vendored from synexo/D-Modem
- `vm/tunnel/` — UDP-over-TCP tunnel source (our code)
- `vm/ctrl/` — control-channel bridge source (our code)
- `vm/qemu-runner/` — Node-side QEMU launcher, wire protocol codec
- `vm/overlay/` — init scripts that run in the VM at boot

### Wire protocol (host ↔ shim)
Two TCP loopback connections:
- Audio channel: `127.0.0.1:25800`
- Control channel: `127.0.0.1:25801`

Framing: `u16 length (LE) | u8 type | payload`. Types in
`vm/ctrl/wire.h` and `vm/qemu-runner/wire.js` (kept in sync).

### Test counts
- 90 tests pass: 8 suites under `test/slmodem/` and `test/rtp/`
- Run individually: `node test/<suite>/<name>.test.js`
- Full regression pattern:
  ```bash
  for t in test/slmodem/*.test.js test/rtp/*.test.js; do
    r=$(timeout 180 node "$t" 2>&1 | tail -1)
    printf '%-45s %s\n' "$(basename "$t")" "$r"
  done
  ```

---

## 3. Current state

> **HISTORICAL NOTE (cleanup-phase-1):** This entire section describes
> the architecture and tuning of the **host-paced slmodemd backend**
> (`SlmodemBackend.js` + `modemd-shim`), which was REMOVED in
> cleanup-phase-1. The current shipping backends are `native` (pure-JS
> in-process), `slmodemd-pjsip` (PJSIP+slmodemd in a VM, B2BUA on
> the host), and `auto` (composes the previous two via V.8-timeout
> swap; recommended default); see Section 0 ("Backend strategy"). The
> Clock Pump v2, the dumb-shim split, and the tuning notes here are
> kept for context only — none of the code referenced exists in the
> tree anymore.

### TL;DR — Clock Pump v2 is working

**Handshake**: 100% reliable (verified across multiple phone tests).
**Data mode**: stable enough to browse a BBS end-to-end. User has
successfully opened a telnet connection to an external site (via
their slmodemd-driven modem + caller-side HSF softmodem) and
interacted with it.

This is the new baseline. Not every post-CONNECT pathology is
eliminated — some garbled characters may still appear — but the
modem no longer self-hangs-up in 8-60 seconds like prior versions.
It stays connected and usable.

### The working architecture in one sentence

Node paces writes to slmodemd at exactly 50 fps via a 100-frame ring
buffer with wall-clock catch-up, matching D-Modem's PJSIP software-
clock pattern; the shim is a dumb forward-on-arrival pipe with
nothing smart in it.

### The key components (all kept, all in this repo)

1. **Clock Pump v2** in `src/backends/SlmodemBackend.js`. State
   machine: IDLE → PREBUFFERING → PUMPING. Drives a 20ms cadence
   to slmodemd via a wall-clock catch-up loop running on a 10ms
   `setInterval`. Writes explicit silence on underrun. 100-frame
   ring buffer absorbs bursts.

2. **Dumb shim** in `vm/shim/modemd-shim.c`. Reads wire audio from
   host, writes to slmodemd's socketpair. No pacing, no gating, no
   ATA/NO_CARRIER triggers. All intelligence lives in Node now.

3. **Fixed-buffered jitter buffer** in `src/rtp/RtpSession.js`. 40-
   packet pre-buffer, no concealment silence, no drops except on
   extreme overflow. D-Modem-style behavior.

4. **TelnetProxy null-guards** in `src/session/CallSession.js`.
   Crash safety for post-BYE callback races.

5. **Banner simplification** in `src/backends/SlmodemBackend.js`.
   Any CONNECT fires the connected event regardless of rate.

6. **Audio capture analysis tooling** (`scripts/compare-audio-dumps.py`
   plus inline Python recipes in §6).

### The Clock Pump v2 in detail

Location: `src/backends/SlmodemBackend.js`.

**State machine**:
- `IDLE`: no call active. `receiveAudio` is a no-op (ring untouched).
- `PREBUFFERING`: `activate()` was called, ATA is in flight. Incoming
  RTP audio accumulates into the ring.
- `PUMPING`: ring reached 40 frames (800 ms). Tick timer starts. Each
  tick pops frames and writes to slmodemd.

Transitions:
- `activate()` → `_pumpArm()` → PREBUFFERING. Called right before
  the shim forwards ATA to slmodemd.
- `_pumpPush` checks fill level; when ≥ 40, calls
  `_pumpMaybeStartClock()` → PUMPING.
- `stop()` or any nocarrier/busy/nodialtone → `_pumpReset()` → IDLE.

**Wall-clock catch-up tick**:
```js
const elapsed = Date.now() - p.lastWriteMs;
const due = Math.floor(elapsed / 20);  // how many frames are due
for (let i = 0; i < due; i++) {
  const frame = this._pumpPop() || Buffer.alloc(320);  // silence on underrun
  this._vm.sendAudio(frame);
}
p.lastWriteMs += due * 20;  // advance by consumed ms
```

Why this matters: Node.js `setInterval` on Windows has ~15.6 ms
resolution and drifts badly under load. A naive `setInterval(20)` +
write-one-frame-per-tick gave ~27 writes/sec (measured). The catch-up
loop trusts the wall clock instead of the timer: if a tick fires
late, it writes multiple frames to compensate. Unit-tested to give
49.7 fps under a 37 ms-period simulated timer.

The timer itself runs at `setInterval(10)` so it fires at least as
often as needed — the extra wake-ups are cheap (each checks elapsed
and returns if nothing is due).

**Underrun handling**: explicit 160-zero silence frame, not skip.
Missing a tick would let slmodemd's DSP timer drift out of phase.
Silence is expected during idle line; an absent write is not.

**Overrun handling**: when ring hits 100 frames (2 seconds of
buffered audio, meaning sender clock is faster than ours long-term),
drop the oldest 20 frames. During normal calls this doesn't fire.

### Telemetry line

Every 5 seconds during PUMPING:
```
[SlmodemBackend] pump stats 5s: ticks=500  writes=250  silences=0
                 drops=0  overflows=0  maxDepth=40  slmTx=50  ringNow=40
```

Healthy values:
- `ticks` ≈ 500 (10 ms timer). Higher on Linux, may be lower on
  Windows under load — doesn't matter as long as it's ≥ 250.
- `writes` ≈ 250 (50 fps × 5 s) — this is the actual cadence.
- `silences` = 0 normally. Occasional is fine; sustained means
  upstream is starving.
- `drops` = 0 normally. Occasional is fine; sustained means sender
  clock drift.
- `maxDepth` ≈ 40 (pre-buffer size). Occasional spikes to 60-80 are
  fine (burst absorbed). Persistently high = sender clock fast.
- `ringNow` ≈ 40 in steady state.

### What's still imperfect

1. **Some post-CONNECT characters may garble.** The 20-30% frame-dup
   pattern we spent a session characterizing still exists in
   slmodemd's rx8k dump. Clock Pump v2 reduced the per-call decoder-
   error accumulation enough that the line stays up, but the dup
   pattern has not been fully eliminated. Candidates for where the
   dup comes from: TCP segmentation on loopback, kernel socketpair
   double-delivery, slmodemd's own DSP timing-catchup. Not pursued
   further because the line-stays-up behavior is a large enough
   improvement to ship and observe.

2. **Windows timer jitter**. The catch-up loop fixes the long-term
   average rate but individual writes are still bursty on Windows
   (one tick may fire after 40 ms and deliver 2 frames back-to-back
   rather than 20 ms apart). On Linux this is less pronounced. If
   persistent data corruption is eventually traced to this, the fix
   is either (a) use `setImmediate`/`process.nextTick` to yield
   sooner between the two writes in a catch-up batch, or (b) accept
   that the VM's TCP buffering smooths out sub-40ms bursts anyway.

3. **No V.34/V.90 yet**. All testing has been V.32bis at 4800/9600.
   High speeds are the strategic prize but require separate work.

### Config to run the phone test (user-side)

```js
// config.js — slmodemd backend, V.32bis forced
modem: {
  backend: 'slmodemd',
  captureAudio: true,
  dumpModemPipeline: true,
  slmodemd: {
    atInit: ['AT&Q0', 'AT+MS=132,1,4800,4800'],  // V.32bis 4800
  },
},
rtp: {
  playoutMode: 'fixed-buffered',  // D-Modem style, KEEP
}
```

On the caller-side terminal:
```
ATZ
ATX0
AT&Q0
AT+MS=V32B,1,4800,4800
ATDT<number>
```

### Recommended priorities if work resumes

1. **Ship the current state.** It works. User has successfully
   browsed a BBS over this setup.

2. **Investigate the remaining ~20% dup pattern** only if new
   character-level corruption becomes blocking. Tools and hypothesis
   list are in §7 under "The frame-dup saga".

3. **Test higher rates.** Try V.32bis 9600, V.34, V.90 in succession.
   Each will reveal different DSP tolerances.

4. **If high rates fail hard, consider in-VM PJSIP** (PJSIP.md) as
   the strategic fix. But Clock Pump v2 at least gives us a working
   baseline to diff against.

---

## 4. Building slmodemd (glibc-pinned VM build)

### The constraint
`slmodemd` must run inside the VM, which ships Debian bookworm glibc
2.36. If you build on the sandbox host (Ubuntu 24.04 / glibc 2.39),
gcc 13 silently redirects `strtol`/`strtoul`/`atoi` to `__isoc23_*`
variants via stdlib.h, producing a binary that references `GLIBC_2.38`
symbols and **fails to load in the VM with "version not found"**.

There is also an `__isoc23_` suppressing flag (`-U__GLIBC_USE_C2X_STRTOL`)
but it didn't work reliably when we tried it earlier. Don't go down
that road; the VM build works and is robust.

### The solution: build inside a Debian bookworm VM
Script: `scripts/build-slmodemd-in-vm.sh`

It spins up a temporary QEMU VM with:
- The same kernel we ship (Debian bookworm linux-image-6.1.0-42)
- A temporary initramfs built from bookworm `.debs` containing `gcc -m32`,
  `libc6-dev-i386`, `make`, etc.
- A 9p share of the repo so the VM can `make` against `vm/slmodemd/`
- Output stages into `vm/prebuilt/slmodemd`

```bash
# First run downloads ~300MB of .debs, cached in ~/.cache/synthmodem/debs.
# Later runs are fast (~30s).
./scripts/build-slmodemd-in-vm.sh

# Options:
./scripts/build-slmodemd-in-vm.sh --dry-run        # plan only
./scripts/build-slmodemd-in-vm.sh --keep-work      # don't clean temp dir
./scripts/build-slmodemd-in-vm.sh --cache /path    # override .deb cache
```

Updates `vm/prebuilt/PROVENANCE.txt` with input hashes and output hash.

### The shim is easier

(Historical: the modemd-shim binary was part of the host-paced
slmodemd backend, removed in cleanup-phase-1. It is no longer
built or shipped. References to it elsewhere in this document
predate cleanup-phase-1.)

### Rebuild prebuilts after a source change

The maintainer-side workflow is wrapped in two scripts:

```bash
# One-time setup (~285 MB GPL source + ~115 MB toolchain .debs).
scripts/vendor-sources.sh

# Rebuild from source — only when an upstream pin or our in-tree
# source has actually moved. The committed vm/prebuilt/* is
# authoritative between rebuilds.
scripts/rebuild-prebuilts.sh
```

After rebuild, compare hashes against `vm/prebuilt/PROVENANCE.txt`
and commit any intentional changes together (binaries +
PROVENANCE.txt + the source diff).

See `MAINTAINERS.md` for the full procedure.

### Rebuild rootfs after binary changes
```bash
cd vm
make          # assembles /.rootfs-build, produces images/rootfs-slmodemd-pjsip.cpio.gz
```

Output: `vm/images/rootfs-slmodemd-pjsip.cpio.gz`, typically 4.0 MB.
Commit this binary to git along with the prebuilts; users don't
rebuild on install.

### Verify the new rootfs boots
```bash
node test/slmodem-pjsip/vm-smoke.test.js
# Should pass: boot + HELLO, AT→OK, ATI3, unknown-cmd, clean stop
```

### Practical workflow for modemd-ctrl-only changes (the common case for VM-side edits)
```bash
# 1. Edit vm/ctrl/modemd-ctrl.c
# 2. Build (native + i386)
cd /home/claude/synthmodem/vm/ctrl && make
# 3. Check glibc symbol versions on the i386 build
nm -D modemd-ctrl-i386 | grep GLIBC_2 | sed 's/.*GLIBC_//' | sort -Vu | tail
# 4. Install into prebuilt
cp modemd-ctrl-i386 ../prebuilt/modemd-ctrl-i386
sha256sum ../prebuilt/modemd-ctrl-i386   # note for PROVENANCE update
# 5. Update vm/prebuilt/PROVENANCE.txt
# 6. Rebuild rootfs
cd .. && make
# 7. Smoke test (native binary)
cd .. && node test/ctrl/standalone.test.js
# 8. Smoke test (in-VM)
node test/slmodem-pjsip/vm-smoke.test.js
```

For changes that touch d-modem.c, modemd-tunnel, or pjsip-test-peer
— those need the full PJSIP build chain — use
`scripts/rebuild-prebuilts.sh --pjsip` instead of editing in
`vm/ctrl/`.

---

## 5. Tarball packaging

The user runs on Windows; they can't easily checkout from your sandbox.
Delivery is via tarballs through `present_files`.

### Output location
`/mnt/user-data/outputs/synthmodem-m3-complete-v2.tar.gz`

Filename is historical ("m3" = milestone 3); don't rename — user has
workflow around this exact name.

### Build command (use exactly this invocation)
```bash
cd /home/claude
rm -f /mnt/user-data/outputs/synthmodem-m3-complete-v2.tar.gz
tar --exclude='synthmodem/.git' \
    --exclude='synthmodem/node_modules' \
    --exclude='synthmodem/captures/*' \
    --exclude='synthmodem/build' \
    --exclude='synthmodem/vm/.rootfs-build' \
    --exclude='synthmodem/vm/slmodemd/*.o' \
    --exclude='synthmodem/vm/slmodemd/slmodemd' \
    --exclude='synthmodem/vm/slmodemd/modem_test' \
    --exclude='*.raw' \
    --exclude='.DS_Store' \
    -czf /mnt/user-data/outputs/synthmodem-m3-complete-v2.tar.gz \
    synthmodem
```

Rationale for each exclude:
- `.git/` — too big, user has their own repo
- `node_modules/` — user runs `npm install` on receipt
- `captures/*` — per-call WAV/RAW dumps, huge and user-specific. Note
  the wildcard: we keep `captures/.gitkeep` so the directory itself
  ships, but skip every captured artifact inside it
- `build/` — node-gyp intermediate
- `.rootfs-build/` — vm Makefile staging dir
- `*.o`, `slmodemd` (source-dir binary), `modem_test` — intermediates;
  the committed `vm/prebuilt/` binaries are what ships
- `*.raw` — raw audio dumps

### Expected size
~19-21 MB. Much larger means something got un-excluded.

### Present to user
```
# Call present_files after building
```
```python
present_files(["/mnt/user-data/outputs/synthmodem-m3-complete-v2.tar.gz"])
```

Then write a brief post-delivery note explaining what's in this drop and
what the user should look for when they test.

---

## 6. Audio capture analysis

### How captures are produced
Set `config.modem.captureAudio = true` and `config.modem.dumpModemPipeline = true`.
Per-call, you get these files in `captures/`:

| File | Content | Source |
|------|---------|--------|
| `<ts>_<id>_rx.wav` | Raw RTP RX, PCMU-decoded to int16 mono 8kHz | Node's RtpSession |
| `<ts>_<id>_tx.wav` | Raw RTP TX, int16 mono 8kHz | Node's RtpSession |
| `<ts>_<id>_modem_rx_8k.raw` | What slmodemd received on its socketpair, int16 mono 8kHz | slmodemd's `rx8k_dump_write()` |
| `<ts>_<id>_modem_rx.raw` | After slmodemd's 8→9.6kHz resample, int16 mono 9600Hz | slmodemd's `rx_dump_write()` |
| `<ts>_<id>_modem_tx.raw` | slmodemd's TX output pre-resample, int16 mono 9600Hz | slmodemd's `tx_dump_write()` |
| `slmodemd-boot.log` | VM console output including shim logs | QemuVM boot log |

### The key comparison: Node RX WAV vs modem_rx_8k.raw
These two files should be BYTE-IDENTICAL in steady state. Both are
int16 mono 8kHz. Node's WAV is what Node delivered to the shim; the
raw file is what slmodemd actually read from its end of the socketpair.
Any divergence means the pipeline (TCP → virtio → shim → socketpair)
corrupted, duplicated, or dropped frames.

### Automated comparison script
`scripts/compare-audio-dumps.py` — runs length check, amplitude
comparison, FFT comparison, cross-correlation.

```bash
python3 scripts/compare-audio-dumps.py \
    captures/2026-04-22T16-53-07-467Z_e0f04aea-1e199526-192-168-1-105
# Pass the timestamp prefix, NOT a filename
```

### Manual analysis recipes you'll need
All inline Python, using `numpy`/`scipy`.

**Load files**:
```python
import array, numpy as np, wave

w = wave.open('captures/XXX_rx.wav')
node_rx = np.array(array.array('h', w.readframes(w.getnframes())), dtype=np.int16)

slm_rx = np.array(
    array.array('h', open('captures/XXX_modem_rx_8k.raw', 'rb').read()),
    dtype=np.int16)
```

**Check lengths and starting alignment**:
```python
print(f'Node samples: {len(node_rx)}, {len(node_rx)/8000:.2f}s')
print(f'SLM  samples: {len(slm_rx)}, {len(slm_rx)/8000:.2f}s')
# Node usually has MORE — slmodemd's dump ends on hangup
# If slm has fewer samples than expected for call duration, something stalled
```

**Find where slm's audio starts inside Node's**:
```python
L = 160  # one RTP frame
for off_frames in range(0, 500):
    off = off_frames * L
    if np.array_equal(node_rx[off:off+L], slm_rx[:L]):
        print(f'slm[0] matches node[{off}] = {off/8000:.3f}s into call')
        break
```

**Detect adjacent-frame duplicates in slm** (classic frame-dup signature):
```python
dups = 0
for i in range(0, len(slm_rx) - 2*L, L):
    if np.array_equal(slm_rx[i:i+L], slm_rx[i+L:i+2*L]):
        dups += 1
print(f'SLM adjacent duplicates: {dups}')
# Node should be ~0; slm being large means frame corruption
```

**Per-second RMS correlation** (detects when DSP stopped processing):
```python
def rms(arr):
    return float(np.sqrt(np.mean((arr.astype(np.float32)/32768)**2)))

for t in range(0, max(len(slm_rx), len(node_rx)) // 8000):
    s, e = t*8000, (t+1)*8000
    nr = rms(node_rx[s:e]) if e <= len(node_rx) else float('nan')
    sr = rms(slm_rx[s:e])  if e <= len(slm_rx)  else float('nan')
    print(f't={t:2d}  node_rms={nr:.5f}  slm_rms={sr:.5f}')
```

**Scan VM log for DSP state transitions and decoder errors**:
```bash
grep -iE "state:|change dp|Decoder Error|modem_hup|STATE_ERROR|NO CARRIER" \
    captures/slmodemd-boot.log
```

### Interpreting `Decoder Error = N` lines
slmodemd's V.32bis DSP emits this during training/data mode. Counts
per second. Small numbers during training (< 100) are normal. Large
numbers (> 1000) sustained for more than a few seconds are pathological
and usually precede STATE_ERROR → internal hangup.

Handshake phases:
- `DP_ESTAB` — carrier detection, V.8 tones exchanged
- `EC_ESTAB` — V.42 error correction established
- `MODEM_ONLINE` — data mode, application data flowing
- `DP_DISC` — disconnecting
- `STATE_ERROR` — DSP gave up; typically followed by modem_hup and DP_DISC

---

## 7. Decisions and solutions

### Clock Pump v2 (WORKING — current baseline)

**Location**: `src/backends/SlmodemBackend.js`, methods prefixed
`_pump*`.

**Problem solved**: slmodemd's DSP expects audio input at exactly
50 fps. Node's RTP receive path delivers at *average* 50 fps but
with realistic network jitter (coalesced bursts, small gaps). The
cadence jitter degrades the DSP's decoder, accumulating errors that
eventually triggered STATE_ERROR in every prior version.

**Mechanism**: A state machine in the backend (IDLE → PREBUFFERING
→ PUMPING) owns a 100-frame ring buffer. Incoming RTP audio (already
repacketized to 160-sample units by the existing `_appendRxBuf` +
drain loop) is pushed into the ring. A tick handler running on
`setInterval(10)` drains the ring at exactly 50 fps via wall-clock
catch-up: each tick computes `floor(elapsed_ms / 20)` and writes
that many frames. Underrun writes 160 zeros (not skip). Overflow at
100 frames drops oldest 20.

**Why a 10 ms timer with catch-up and not a 20 ms timer**: Node.js
`setInterval` on Windows has ~15.6 ms resolution and drifts under
load. A naive `setInterval(20)` gave ~27 fps on Windows (measured in
user's captures). The 10 ms timer wakes up more often than needed,
and the catch-up loop makes individual tick timing irrelevant — only
wall-clock elapsed time drives the write rate. Unit-tested to give
49.7 fps under a 37 ms-period simulated timer.

**Why latch state in Node, not the shim**: prior attempts put the
clock pump in the shim (C, timerfd). They failed because (a) the
shim has no natural way to know when a call is active vs idle, and
(b) debug/iteration cycles required rebuilding the shim binary and
rootfs every time. Putting it in Node makes all the state visible
to the developer, trivially changeable, and naturally tied to the
CallSession lifecycle.

**Empirical result**:
- Handshake: 100% reliable across multiple phone tests
- Data mode: browsed a BBS end-to-end without self-disconnect
- Banner: displays
- User confirmed: "connecting reliably, 100% of the time so far,
  showing banner, and I actually connected to an external site via
  telnet"

**Files touched**:
- `src/backends/SlmodemBackend.js` — the pump itself (constructor
  init, `receiveAudio` routing, `activate` arms, `stop`/nocarrier
  resets, pump helper methods `_pumpPush`/`_pumpPop`/`_pumpArm`/
  `_pumpMaybeStartClock`/`_pumpTick`/`_pumpReset`).

**What could still go wrong**:
- Extreme sender clock drift — ring fills past 100 and drops kick in.
  Occasional is fine; sustained means the sender is emitting > 50
  fps. Would need investigation of the RTP timestamps.
- Host CPU saturation — tick timer stops firing at all for seconds.
  The catch-up clamp caps the batch at 500 ms (25 frames) to avoid
  flooding. If this clamp fires, we've got bigger problems.

### The shim is gone (cleanup-phase-1)

The host-paced slmodemd backend used a small in-VM helper called
`modemd-shim` (`vm/shim/modemd-shim.c`) that bridged audio + control
between Node and slmodemd over wire-framed TCP. That whole backend
was removed in cleanup-phase-1 along with `vm/shim/`,
`src/backends/SlmodemBackend.js`, and `vm/images/rootfs.cpio.gz`.

The remaining VM-side helpers are:

- `vm/ctrl/modemd-ctrl.c` — PTY ↔ control-channel bridge for AT
  commands and data-mode bytes. Standalone, native + i386 builds
  at `vm/prebuilt/modemd-ctrl-i386`.
- `vm/tunnel/modemd-tunnel.c` — UDP-over-TCP tunnel for the SIP/RTP
  carried between Node and PJSIP inside the VM. Built into
  `vm/prebuilt/modemd-tunnel-i386`.
- `vm/d-modem/d-modem.c` — D-Modem's `pjmedia_port` subclass that
  bridges PJSIP's audio to slmodemd's socketpair. Built into
  `vm/prebuilt/d-modem`.

All cadence intelligence lives in PJSIP+d-modem now (or in Node for
the native backend). The synthmodem control plane just shuttles
AT/DATA across the VM boundary; the audio plane is owned end-to-end
by PJSIP inside the VM.

### The fixed-buffered jitter buffer (keep)

**File**: `src/rtp/RtpSession.js`
New `'fixed-buffered'` playout mode, matching D-Modem's PJSIP config:
- Pre-buffer 40 packets (800 ms) before starting playout
- Never emit concealment silence on tick miss — just skip and wait
- Only give up on a missing seq after `missSkipTicks` consecutive
  missed ticks (default 50 = 1 second)
- Drop oldest on buffer overflow past `jitterBufferMaxDepth`

Config: `config.rtp.jitterBufferInitDepth`, `jitterBufferMaxDepth`,
`jitterBufferMissSkipTicks`, `playoutMode: 'fixed-buffered'`.

**Result**: Brought handshake from ~25% to 100% (working in concert
with Clock Pump v2).

### The crash fix (keep)

**File**: `src/session/CallSession.js`
Null-guards around `this._dsp.write` and `this._dsp.receiveAudio`
callbacks, with `try/catch` to tolerate post-BYE teardown races.

### CONNECT banner simplification (keep)

**File**: `src/backends/SlmodemBackend.js`
Answer-side V.32bis emits rateless CONNECT; don't try to parse a
rate. Any CONNECT fires the connected event.

### Attempted fixes that regressed and were discarded

These are documented so a future session doesn't re-attempt them.

#### Full shim-side clock pump with timerfd (FAILED)
**What**: `timerfd` 20 ms tick inside the shim, 8-frame ring buffer,
silence on underrun, overflow-drop-oldest, lifecycle gating on
pump_active boolean, kick-off silence frame at ATA detection.
**Outcome**: severe handshake regression, never reached MODEM_ONLINE.
**Why it failed**: ring was too small (overflowed on bursts → frame
drops), silence-fill during real audio corrupted training signal.
**What to learn**: if pacing in the shim is ever re-attempted, the
ring needs to be 40+ frames matching the jitter buffer depth so
overflow never happens.

#### Shim-side lifecycle gating (FAILED)
**What**: a `pump_active` boolean in the shim, set on ATA detection
and cleared on NO_CARRIER/HANGUP. When dormant, drop incoming audio
instead of forwarding.
**Outcome**: handshake 1-in-4 with kick-off silence, 1-in-2 without.
**Why it failed**: dropped frames during handshake-preamble window
where ATA was in flight but Node's jitter buffer was already
draining. The gating introduced a race between "is the modem ready"
and "is audio flowing" that caused corruption.
**What to learn**: Node is the clock master. Shim should stay dumb.

#### The kick-off silence frame (FAILED)
**What**: write one frame of 160 zeros to slmodemd's socketpair at
ATA detection, mirroring D-Modem's `on_call_media_state` behavior.
**Outcome**: handshake 1-in-4.
**Why it failed**: our ATA detection fires BEFORE slmodemd processes
ATA, so the silence sat in the kernel socketpair buffer for 100-500
ms until `modemap_start` completed. slmodemd then read that stale
silence as its FIRST frame followed by a gap — classic cadence
shock. D-Modem gets away with this because PJSIP's kick-off happens
AFTER pjsua_call_answer completes, which is AFTER slmodemd has
already entered m->started=true.
**What to learn**: timing of kick-off writes matters. If you need
one, defer it until slmodemd has emitted its own first frame (proof
that m->started=true).

### spandsp port-faithful methodology (recurring approach)

The single most reliable approach for fixing native modem
protocols turned out to be: **read the spandsp source for the
relevant protocol, compare to ours line-by-line, and reconcile.**
Used successfully for the V.22 stabilization arc (April 28-29),
V.22bis answer-side completion (April 30), V.8 sequencer rewrite
(April 30), and V.23 (extracted from the deleted V32bis.js).

What this means in practice:

1. **Don't reason from the spec alone.** ITU specs describe the
   protocol but not the dozen non-obvious tuning constants that
   make it work in real-world conditions (Costas-loop bandwidth,
   Gardner timing damping, LMS leak rate, signal-detect
   thresholds). Spandsp encodes the answers from a couple of
   decades of debugging real modems.
2. **Don't trust other AIs / consults / reasoning chains** when
   they disagree with spandsp source on an implementation detail.
   They were wrong multiple times during this session arc;
   spandsp source was right every time. (This isn't because
   spandsp is infallible — it's because it's been tested against
   hardware modems at scale and we haven't.)
3. **Direct port = same constants, same control flow, same field
   names.** When the port deviates structurally, regressions
   surface. The V.8 rewrite was successful precisely because it
   was structurally identical to spandsp's V.8 sequencer — `queue_flush`
   on CJ, sample-accurate post-CJ silence via a counter (not
   `setTimeout`), JM topup-per-block (not `setInterval`), etc.

When you reach for "let me think about this from first
principles," consider instead: "let me read what spandsp does
here." Faster, more correct, easier to review. **Licensing
note**: spandsp is LGPL-2.1; direct ports require attribution.
The COPYING file has the relevant block.

### Capture-driven diagnostic methodology (recurring approach)

Almost every native-protocol fix in this arc started with a
real-modem audio capture and ended with a "now it's clean"
capture. The methodology:

1. Get the operator (the user) to set `config.modem.captureAudio
   = true` and reproduce the failure with a real modem.
2. Receive the WAV files at `captures/<timestamp>-rx.wav` and
   `<timestamp>-tx.wav` (RX = audio coming IN to synthmodem from
   the caller; TX = what synthmodem is emitting).
3. Listen by ear first (V.22/V.22bis training has a distinctive
   "BONG-BONG-screeeech" signature that diverges audibly when
   training fails). Then run through `decode-rx-capture-timed.js`
   or equivalent for symbol-level analysis.
4. Identify the divergence point (X seconds in, Y phase
   transition) and look at the surrounding code.

This worked for V.22 stabilization (the early-call-burst
diagnosis), the UART-resync investigation, the V.22bis answer-side
S1 detector fix, the FskDiscriminator design, and dozens of
smaller fixes.

**Tip:** synchronous `fs.writeSync` per audio chunk in
`AudioCapture.js` adds enough latency to dampen Windows
timer-quantum bursts (~50-200 µs per write). This is why "with
capture enabled, the V.22 issue doesn't reproduce" was a
diagnostic clue, not a coincidence. See the Windows multimedia
timer entry below.

### V.22 stabilization fix list — what landed (April 28-29)

For posterity, the full set of fixes that took V.22 from "no
usable connection" to user-confirmed "working very well, just as
good as V.21, Bell103":

- **V22Demodulator extracted** from the monolithic V22.js into
  its own module. Lets the demod be unit-tested separately and
  lets V.22 / V.22bis share a clean interface to it.
- **RRC pulse-shape filter** matched to spandsp's coefficients.
  Earlier attempts had different beta and span values that
  produced ISI under real-line conditions.
- **V22Scrambler** verified bit-identical with spandsp via
  side-by-side test vectors. The scrambler is the same in
  V.22 and V.22bis (different seeds for caller vs answerer).
- **Costas loop bandwidth** matched spandsp's tuning. Earlier
  attempts had loop bandwidth that converged too quickly,
  producing carrier-phase oscillation under real-call SNR.
- **Gardner symbol-timing recovery** sign-corrected. The error
  signal direction was inverted vs spandsp's answer-side
  implementation; this was the same bug found later in V.22bis.
- **LMS equalizer leak rate** set to spandsp's value (was zero).
  Without leak, the equalizer adapted to noise during long
  pure-marking idle and the demod went off the rails.
- **6-second early-call burst mitigation.** During the first ~6 s
  of V.22 data mode the modem RX is still settling — Costas not
  fully locked, equalizer still adapting, occasional UART
  misframes leaking through. Mitigation was a combination of
  tighter detection thresholds and the no-op UART frame
  heartbeat (next item).
- **No-op UART frame heartbeat** in `src/sip/TelnetProxy.js`.
  When the menu is idle and the receive carrier has been silent
  for `terminal.menuIdleHeartbeatMs`, synthmodem emits a zero-
  length UART frame on the line. This keeps the V.22 demod's
  internal UART resync recovery on the right side of an internal
  threshold; without it, receivers misframe after long silences.
  User-configurable; can be disabled with `menuIdleHeartbeatMs:
  0`. **The heartbeat is reset on TX (correct: outbound bytes
  prove the line is live) but NOT on RX (incoming bytes don't
  substitute for outbound TX).** This subtle distinction was a
  late correctness fix during this session arc.

### V.32 Signal AA — captured-but-not-our-protocol noise (recurring)

Modern modems doing automode-fallback after a non-V.8 ANSam will
transmit **V.32 Signal AA at 1800 Hz for ~3 s**, time out
waiting for our (non-existent) Signal AC response, go silent for
800 ms, and only then fall back to V.22bis / V.22. This adds 5-7
seconds to the call setup time vs an ideal "V.22 right out of
the gate" path.

This is **not synthmodem's fault** and **not in scope** for
either backend. We don't speak V.32 (the V32bisAnswerer was
removed in Phase 2 along with V.32bis/V.34 protocols). Future
real-modem captures will keep showing this 1800 Hz interval; do
not chase it as a defect. If we ever wanted to shave the
fallback time, the answer would be answer-side V.32 AC support —
which is essentially what V32bisAnswerer.js used to do, and
which is exactly the protocol surface that the `slmodemd-pjsip`
backend now handles. So: in `auto` mode, modern callers will
take the V.8 path on slmodemd-pjsip and never hit V.32 fallback;
in `native`-only mode, the 5-7 s overhead remains.

### Windows multimedia timer — must claim for any backend running native DSP

`src/index.js` calls `timeBeginPeriod(1)` at startup via the
`win-timer-resolution` addon. The startup-time guard currently
keys off `config.modem.backend === 'native' || backend === 'auto'`.
**This guard MUST be extended whenever a new backend is added that
runs the modem DSP on the host event loop.** Forgetting causes
intermittent terminal garbage on real-modem calls during pure-
marking idle, often subtle enough to be misattributed to other
recent changes.

The diagnostic pathology (April 30, ~3 days to identify):

- **Symptom**: continuous garbage characters appearing on the
  caller's terminal starting ~6 seconds after CONNECT and not
  stopping until the call disconnects. ~80% reproduction rate
  in `auto` mode; 0% rate in `native` mode (which had the timer
  fix); 0% rate in `auto` mode of pre-QoL builds.
- **First false hypothesis**: the QoL drop introduced this. It
  hadn't.
- **Second false hypothesis**: the menu-idle heartbeat or the
  receive-side TelnetProxy logic regressed. They hadn't (though
  there was a small unrelated correctness fix on `receive` in
  the same vicinity).
- **Decisive clue from the user**: capture-on works, capture-off
  broken. This isolated the cause to event-loop pacing — sync
  `fs.writeSync` per audio chunk in `AudioCapture.js` was
  inadvertently smoothing TX pacing enough to dampen the
  timer-quantum bursts.
- **Root cause**: `src/index.js`'s timer-claim block was gated on
  `backend === 'native'`. Auto mode was a third backend value
  added later; the guard was never updated. Auto runs the
  native DSP post-swap on the host event loop, so it equally
  needs the 1 ms timer.
- **Fix** (one line of expression change): extend the guard to
  `backend === 'native' || backend === 'auto'`, plus a defensive
  cleanup of two error paths in `_buildModemBackendSync`.
- **Lesson recorded**: in `MAINTAINERS.md` Windows-timer
  paragraph. Maintainers reading that section before touching
  `src/index.js` should be alerted.

### "Two and only two backends" reasoning has been superseded

Earlier Section 0 said "the project maintains two and only two
backends" (native + slmodemd-pjsip). That framing was correct at
the time but is now superseded — `auto` ships as a third backend
value. The decision rationale is preserved here for context:

- The reason for "two and only two" was to avoid a fragmented
  build matrix with each backend having its own caller-coverage
  surface and its own failure modes.
- The auto backend doesn't violate this — it's a *composer* of
  the two existing primitives, with deterministic dispatch
  (V.8 timeout signature). It adds a third value to
  `config.modem.backend` but no new C code, no new VM, no new
  protocol implementation. The build matrix is unchanged.
- New caller modes added in the future should be considered for
  composition into `auto`, not as additional standalone backend
  values, unless they fundamentally do not fit either primitive.

#### The frame-dup saga (real phenomenon, cause never fully isolated)
**Symptom**: slmodemd's RX dump shows 20-30% adjacent-duplicate
frames pattern `[A, B, B, C, D, D, ...]`. Second opinion initially
attributed this to a 1.2× (9.6 kHz / 8 kHz) rate mismatch; later
correction showed the long-term rate is 1:1 with local bursts
creating the pattern.

**Investigation summary**:
- Shim delivers clean 50 fps with zero backlog (telemetry proved).
- Synthetic test (500 uniquely-tagged frames) produces zero
  duplicates in slmodemd's dump.
- Node's pre-backend WAV capture has zero duplicates.
- So the duplicates appear only under real-RTP live-modem load.
- Clock Pump v2 reduced the harm enough that the line stays up,
  but the underlying dup pattern is not fully eliminated.

**Current thinking**: likely kernel TCP coalescing on loopback
combined with slmodemd's DSP-timing-catchup loop. Not worth chasing
further unless high-rate modes fail. The D-Modem reference
implementation bypasses this entirely by running PJSIP inside the
VM (see PJSIP.md), which would be the strategic fix if ever needed.

---

## 8. Tech notes / gotchas

### The `__isoc23_` trap
If you build VM-side code on the sandbox host:
```
/usr/bin/ld: warning: ... __isoc23_strtol@GLIBC_2.38
```
That binary won't load in the VM. Either:
- Build it in the bookworm VM via `scripts/build-slmodemd-in-vm.sh`
  or `scripts/build-pjsip-in-vm.sh` (or run the wrapper
  `scripts/rebuild-prebuilts.sh`)
- Or avoid `strtol`/`strtoul`/`atoi`/`sscanf` entirely; the in-tree
  helpers under `vm/ctrl/` and `vm/tunnel/` ship with hand-rolled
  parsers for this reason

### TCP chardev on Windows
The VM↔host transport is TCP loopback, not named pipes. Named pipes
were tried earlier (transcripts have this debate) but Windows has a
~15ms small-write coalescing penalty. TCP + `TCP_NODELAY` + QEMU
`nodelay=on` on both ends avoids it.

### Slmodemd's socketpair is `SOCK_STREAM`
Not `SOCK_SEQPACKET` and not `SOCK_DGRAM`. This means partial reads
are possible (though we never observed them). The shim's
`handle_slm_audio_readable` uses a persistent staging buffer and
byte-granular framing to tolerate partial reads; the slmodemd side
(`mdm_device_read`) does not — it reads `sizeof(socket_frame)` bytes
and errors on short. This is upstream behavior we preserve verbatim.

### Pool worker VMs
`src/backends/ModemBackendPool.js` pre-boots one VM and holds it in
idle until checkout. On BYE, the used backend is discarded (we don't
reuse VMs because slmodemd state is sticky across calls in ways that
aren't well documented). The pool replenishes in the background.

### Why no Claude-style hot reload
Node's `require` cache + spawned QEMU processes mean you can't just
edit-and-rerun. Always `npm start` from scratch after changes.

### Memory notes for your benefit
- Claude has long-conversation context limits that bite in multi-hour
  sessions. Periodic summarization happens automatically via a system
  `compact` operation; your context will be replaced with a summary
  when this happens. If it does, re-read this file to reorient.
- Prior transcripts (in `/mnt/transcripts/`) are searchable; use
  `conversation_search` for topics, `recent_chats` for by-time lookup.
  Citations in conversation-search results use the internal chat URI
  and can be rehydrated via `https://claude.ai/chat/{uri}`.

---

## 9. Quick reference

### Typical edit-build-test cycle (modemd-ctrl, the common case)
```bash
cd /home/claude/synthmodem
# 1. Edit vm/ctrl/modemd-ctrl.c
# 2. Build + install + rootfs + smoke test
cd vm/ctrl && make && cp modemd-ctrl-i386 ../prebuilt/ && \
  cd .. && make && \
  cd .. && timeout 90 node test/slmodem-pjsip/vm-smoke.test.js
# 3. If smoke test passes, run full regression
for t in test/ctrl/standalone.test.js test/rtp/fixed-buffered.test.js \
         test/rtp/bridge.test.js test/sip/uac-unit.test.js \
         test/session/b2bua.test.js; do
  r=$(timeout 60 node "$t" 2>&1 | tail -1)
  printf '%-45s %s\n' "$(basename "$t")" "$r"
done
# 4. If all pass, build tarball (see §5)
# 5. present_files the tarball
```

For changes that touch d-modem.c, modemd-tunnel, or pjsip-test-peer
— these need PJSIP linked statically so they go through the in-VM
build chain — use `scripts/rebuild-prebuilts.sh --pjsip` instead of
the inline `cd vm/ctrl && make` step.

### If you need to inspect D-Modem's upstream
```bash
# Clone fresh (or reuse from /tmp/dmodem if still there)
cd /tmp && git clone --depth=1 -b pjsip2.15 \
    https://github.com/synexo/D-Modem.git dmodem
# Then grep/compare as needed
diff <(tr -d '\r' < dmodem/slmodemd/modem_main.c) \
     <(tr -d '\r' < /home/claude/synthmodem/vm/slmodemd/modem_main.c)
```

### Expected modemd-ctrl log format
```
[ctrl I 5.700] HELLO emitted, build=v0.4-12-g1234567-dirty
# The "I" is INFO; "D" is DEBUG; "E" is ERROR.
# The number is helper uptime seconds since startup.
# SYNTHMODEM_LOG_LEVEL=info or debug via kernel cmdline
# (QemuVM sets synthmodem_log=<level> on -append from
#  config.modem['slmodemd-pjsip'].logLevel)
```

### Key file paths cheat-sheet
```
vm/ctrl/modemd-ctrl.c              — PTY/control bridge source
vm/tunnel/modemd-tunnel.c          — UDP-over-TCP tunnel source
vm/d-modem/d-modem.c               — vendored from synexo/D-Modem
vm/slmodemd/modem_main.c           — slmodemd source (D-Modem derived, usually frozen)
vm/prebuilt/slmodemd               — shipped slmodemd binary
vm/prebuilt/d-modem                — shipped d-modem binary
vm/prebuilt/modemd-tunnel-i386     — shipped tunnel binary
vm/prebuilt/modemd-ctrl-i386       — shipped ctrl bridge binary
vm/prebuilt/pjsip-test-peer-i386   — shipped test-only PJSIP UAS
vm/prebuilt/PROVENANCE.txt         — hash manifest for prebuilts
vm/images/{bzImage,rootfs-slmodemd-pjsip.cpio.gz} — shipped VM images
src/backends/PjsipBackend.js       — Node side of VM interface (b2bua)
src/rtp/RtpBridge.js               — RTP forwarding for b2bua mode
src/rtp/RtpSession.js              — jitter buffer (native mode)
src/session/CallSession.js         — per-call orchestration
config.js                          — all runtime knobs
COPYING                            — license attribution
MAINTAINERS.md                     — release / vendoring / rebuild workflow
scripts/vendor-sources.sh          — Phase 1: populate vm/sources/ + cache
scripts/rebuild-prebuilts.sh       — Phase 2: rebuild vm/prebuilt/* + images
scripts/build-slmodemd-in-vm.sh    — in-VM glibc-pinned slmodemd build
scripts/build-pjsip-in-vm.sh       — in-VM glibc-pinned d-modem + helpers build
scripts/compare-audio-dumps.py     — automated capture analysis
test/ctrl/standalone.test.js       — modemd-ctrl unit test (no VM)
test/slmodem-pjsip/vm-smoke.test.js — boot-and-AT smoke test (with VM)
test/rtp/fixed-buffered.test.js    — jitter buffer unit tests (native mode)
test/rtp/bridge.test.js            — RTP bridge unit tests (b2bua mode)
test/sip/uac-unit.test.js          — SIP UAC unit tests
test/session/b2bua.test.js         — CallSession b2bua-mode tests
```

### Project Git / GitHub notes
The user pushes tarballs to GitHub for your convenience. If they tell
you "pull the latest", they mean the uploaded tarball has been merged
into the repo main. A clean `git clone` is the fastest way to pick up.

---

## End of Handoff.md

If something in here is wrong or missing in your session, update it
before building the next tarball so the NEXT next session has an
accurate one.

