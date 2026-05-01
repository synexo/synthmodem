# Cleanup Tracker

This file tracks the multi-phase cleanup work transitioning synthmodem from
"working prototype with both backends in tree" to "shipping codebase with
the slmodemd-pjsip backend only, documentation matching reality, and
verified offline reproducibility."

Goal: get through the entire cleanup arc (code + docs + offline-build) before
the next handoff. Documentation cleanup intentionally trails code cleanup
because the docs need a stable target to describe.

## Phases

### Phase 1 — Remove deprecated slmodemd backend (Backend A) ✅

In progress. See "Status by area" below.

Scope: remove all code, tests, build outputs, and configuration paths
specific to the host-paced `slmodemd` backend (`SlmodemBackend.js` +
`modemd-shim.c` + Backend-A rootfs). The `slmodemd-pjsip` backend is now
the sole VM-backed backend; native (pure-JS) is the sole non-VM backend.

Out of scope (deferred to later phases):
- Spandsp/native-DSP-protocols cleanup (next_steps.txt #2, #4).
- Documentation rewrite (multiple READMEs, PJSIP.md, slmodemd-pjsip.md, etc.).
- Config restructure to reflect just-two-backends shape (next_steps.txt #3).

### Phase 2 — Spandsp removal from native backend ✅ (DONE, April 2026)

Shipped in `synthmodem-cleanup-phase2-v1.tar.gz`.

Driving factors (preserved for context):
- The `npm install` toolchain dependency existed almost entirely for
  the spandsp addon (and for the `speaker` test-client dep). Removing
  both eliminated the toolchain prerequisite for the common case
  (`slmodemd-pjsip` backend) — particularly useful on Windows.
- `speaker` had an open security advisory.
- The user decided to ship initially without V.22bis on the native
  side. That removed the last reason to keep spandsp; V.21 / V.22 /
  Bell 103 are pure-JS.

**What landed:**

- `src/native/` (vendored spandsp + V.22bis/V.32bis bindings + the
  MSVC `win-compat/` shim + spandsp-patches/) deleted entirely.
- `binding.gyp` deleted.
- `src/dsp/protocols/V32bis.js`, `src/dsp/protocols/V34.js`,
  `src/dsp/V32bisAnswerer.js` deleted.
- `src/dsp/protocols/V22.js` replaced by the historical PUREJS
  reference, banner-flagged: V22 active; V22bis preserved as
  TESTING / not-known-working (foundation for any future native
  V.22bis fix work).
- `src/dsp/protocols/V23.js` newly extracted from the old
  V32bis.js (V.23 was co-located with V.32bis there). Banner-
  flagged TESTING — promote-or-delete pending operator validation
  against a real V.23 peer.
- `src/dsp/Handshake.js`: V.32bis/V.34 dispatch and the
  V32_AC_SEND state plus its three helper methods removed.
  `_buildCapabilityModes` left untouched — V.8 spec bits are spec
  compliance, governed by what's in config.
- `src/dsp/ModemDSP.js`: AGC dropped (no surviving protocol uses
  it). Pre-existing config-access bug fixed (the file was reading
  native-only keys via the wrong path; introduced
  `ncfg = config.modem.native`).
- `src/dsp/Primitives.js`: AGC / CostasLoop / GardnerTiming /
  LMSEqualizer / Scrambler classes *retained* with a banner
  documenting they're kept as building blocks for future native
  V.22bis fix work.
- `package.json`: dropped `gypfile`, `install`/`rebuild` scripts,
  the `speaker` dependency. Corrected `MIT` → `GPL-2.0-or-later`
  (rest of the tree was already GPL).
- `test-client/AudioOutput.js` deleted; `test-client/index.js`
  trimmed (`--audio` / `--volume` flags, AudioOutput require, and
  audio-out side-effects all gone).
- `config.js`: `protocolPreference` and `v8ModulationModes`
  defaults now `['V22', 'V21', 'Bell103']`. V22bis/V23 entries
  remain in `trainingDurationMs` and `carriers` because their
  classes still exist in the registry as TESTING. Dropped: 4 AGC
  keys, the `equalizer` block, `scramblerPolynomial`,
  `timingRecovery` block, `carriers.V32bis`, `carriers.V34`, 3
  testClient `audio*` keys. Each removal documented in-place via
  comment.
- `.gitignore`: `build/` line removed. (Maintainer-side
  `git rm --cached -r build/` is a separate local action.)

**Tests:** all non-VM tests pass on a clean checkout.
- `test/ctrl/standalone.test.js`: 11/11
- `test/rtp/fixed-buffered.test.js`: 13/13
- `test/rtp/bridge.test.js`: 4/4
- `test/sip/uac-unit.test.js`: 6/6
- `test/session/b2bua.test.js`: 5/5
- `test/suite.js`: 15/15 (V.22bis/V.32bis/V.34 QAM child-process
  tests removed; HandshakeEngine V.8 negotiation real-time test
  marked SKIPPED with comment documenting a pre-existing decode
  failure verified against the pre-Phase-2 tree).
- VM smoke not exercised in this session; slmodemd-pjsip path is
  unaffected.

**Documentation:** README.md, QUICKSTART.md, Handoff.md updated.
WIN_FIX_NOTES.md deleted. LICENSE-spandsp (top-level spandsp
attribution file) deleted — verified zero spandsp source remains
in the tree. COPYING and licenses/ unchanged (SPANDSP-LGPL was
already absent from those before Phase 2 — verified at the start
of this session).

**Verification:** `npm install` on a clean clone takes ~2 seconds
and compiles nothing. `node src/index.js` loads cleanly. Real-PSTN
regression on either backend was not exercised this session
(sandbox has no phone line); the slmodemd-pjsip end-to-end path is
unaffected by Phase 2 changes by inspection.

**Deferred items / TESTING-status protocols:**

V.22bis (in `V22.js`) and V.23 (in `V23.js`) are not advertised by
default. To test them, opt in via
`config.modem.native.protocolPreference` and `v8ModulationModes`,
or use `--proto` from the test client. A future phase will fix or
delete them. The retained Primitives building blocks
(LMSEqualizer / CostasLoop / GardnerTiming / AGC / Scrambler) and
the Phase-2 in-line config comments give that future work a clean
starting point.

### Phase 2 — pre-completion scoping notes (historical)

### V.22 native fix — phase 1 of N ✅ (DONE, April 2026)

Shipped in `synthmodem-v22-fix-phase1-v1.tar.gz`.

Not strictly a cleanup phase — this is feature work on a TESTING-
status protocol that became user-visible after Phase 2 swapped
the spandsp V.22 binding for the historical pure-JS implementation.
See `Handoff.md` section "V.22 native fix — phase 1 of N" for full
details on what landed, what's deferred to subsequent drops, and
what future-work notes were captured during the work (V.22 self-
loopback bug, FSK UART tolerance fix, V32bisAnswerer.js followup).

### Phase 3 — Restructure config.js for the two-backend reality ✅ (absorbed into Phase 6 Tier-1)

Originally a separate phase. Substantially completed in Phase 6
Tier-1: the three-zone config shape was implemented (top-level
`modem.*` for shared, `modem.native.*`, `modem['slmodemd-pjsip'].*`),
8 dead/deprecated keys dropped, 15 source-side renames threaded
through. The Phase-6-followup added the COMMON CONFIG const block
on top.

**What still belongs here as Phase 3:** essentially nothing
substantive. If a future audit finds residual misplaced keys, fold
into whichever phase touches that section. Leaving the heading as
a marker so newcomers don't think it was skipped — it was rolled
forward into Phase 6.

### Phase 4 — Native backend autoneg + protocol-via-config

`next_steps.txt` #4. Autonegotiation on native broke during spandsp
implementation. Restore. Move explicit protocol choice into config.

**Scope shrinks dramatically after Phase 2.** If Phase 2 removes
V.22bis, V.32bis, V.34 from native (only V.21, V.22, Bell 103
remain), autoneg becomes a small problem — the V.8 menu is short
and the protocol dispatch is straightforward.

Sequence: do Phase 2 first, then Phase 4. Phase 4 inherits Phase
2's smaller surface area.

### Phase 4-5 (parallel/small) — slmodemd-pjsip captureAudio (PCMU snoop)

Genuine value, modest size, surfaced during the Phase 6 followup
discussion. Today `config.modem.captureAudio` is a no-op for
`backend = 'slmodemd-pjsip'` because Node only sees raw PCMU bytes
on the RtpBridge, never decoded PCM. The fix is to hook
`RtpBridge._forward` (the single chokepoint where every RTP packet
in both directions passes through Node) and emit:

- per-direction WAV with PCMU codec (RFC 7656; WAV mu-law format
  code 7) — playable in any media player, ear-test value
- and/or per-direction `.pcap` of the RTP datagrams — replayable
  through the actual stack for regression analysis

The hook itself is ~10 lines. The format / on-disk layout / file
naming convention needs design (timestamping, side-tag, single
file vs. paired). config.js already documents this as future work
in the captureAudio comment block.

Can be its own small phase, or folded into Phase 4 or Phase 5
since both will exercise the test client and benefit from
better-than-today capture for regression diffing.

### Phase 5 — Test client revival

`next_steps.txt` #5. Revive `test-client/` for native first, then
slmodemd-pjsip. Useful for automated regression without a phone.

**Sub-items uncovered during Phase 6 work:**

- Test client uses `speaker` for local audio playback. `speaker`
  is removed in Phase 2. Phase 5 must adapt the test client to
  work without local audio playback (or replace `speaker` with a
  vulnerability-free alternative).
- Test client config block (`testClient:` in `config.js`) was not
  restructured in Phase 6 — keys still reflect older shape.
  Phase 5 should align it with the restructured `modem.*` zones.
- For slmodemd-pjsip support in test client: the test client
  currently emulates only an originating native modem. To exercise
  the slmodemd-pjsip backend end-to-end without a real PSTN
  caller, the test client would need to know how to drive a SIP
  UAC against the synthmodem server. Some of this scaffolding
  exists (`test-client/index.js`); needs survey.

### Phase 6 — Documentation rewrite ✅ (Tier 1)

**Tier 1 complete:** structural lies removed and licensing+config
restructured. The work this phase delivered:

- `config.js` — restructured into three zones: top-level `modem.*`
  for shared keys (`backend`, `role`, `captureAudio`, `captureDir`),
  `modem.native.*` for native-only keys (V.8, answer-tone, protocol
  selection, DSP tuning, post-train, carriers, etc.),
  `modem['slmodemd-pjsip'].*` for VM-only (`qemu:`, `transport:`,
  `diagnostics`, `atInit`). Dropped 8 dead/deprecated keys
  (`mode`, `slmodemdPath`, `shimPath`, `slmodemdArgs`, `ptyPath`,
  `dumpModemPipeline`, `v8CiTimeoutMs`, the old `slmodemd:`
  subsection wrapper).
- 15 source-side renames across `src/index.js`,
  `src/session/CallSession.js`, `src/dsp/Handshake.js`,
  `src/dsp/Primitives.js`, `src/dsp/protocols/{V21,V32bis,V34}.js`,
  `src/backends/PjsipBackend.js`,
  `vm/qemu-runner/{QemuVM,transport}.js`, `test-client/index.js`,
  `test/loopback_v22bis.js`, `test/loopback_v32bis.js`,
  `test/session/b2bua.test.js`.
- `dumpModemPipeline` dead-code block removed from
  `_finalizeTeardown` in CallSession.js (steps renumbered).
- Archaeological framing dropped from `PjsipBackend.js` (9 sites),
  `at-result-line.js`, `vm/ctrl/wire.h`, `signaling.test.js`.
- **Licensing pass complete:** `COPYING` rewritten (drops modemd-shim
  & mock entries; adds modemd-tunnel, modemd-ctrl, kernel, busybox,
  glibc as separate components); `licenses/README.md` table fixed;
  `licenses/DSPLIBS-NOTICE` backend reference fixed; `vm/sources/README.md`
  table fixed (drops `vm/shim/`, fixes script ref); kernel-tarball-split
  decision moved to MAINTAINERS.md; `vm/prebuilt/PROVENANCE.txt`
  rewritten with clean structure and all 5 binary hashes; `vm/prebuilt/README.md`
  rewritten to document all 5 binaries.
- **New top-level docs:** `MAINTAINERS.md` (vendoring procedure,
  GPL compliance checklist, kernel-tarball deferral, release
  packaging exclusions, quick-reference recipes).
- **New wrapper scripts:** `scripts/vendor-sources.sh` (Phase 1:
  vendor sources + toolchain cache) and `scripts/rebuild-prebuilts.sh`
  (Phase 2: rebuild prebuilts + assemble images), with `--slmodemd`
  / `--pjsip` / `--images` selectors.
- **README.md** rewritten — GitHub-appropriate structure: tagline →
  status → quickstart → backends (with two ASCII diagrams) → how it
  works → repo layout → building from source → license.
- **QUICKSTART.md** rewritten — 3-5 commands path, both backends,
  troubleshooting.
- **vm/overlay-pjsip/README.md** — drops "placeholder/scaffolding"
  framing; describes the actual init scripts.
- **Handoff.md** — sweep complete: VM-side layers list updated,
  build/rebuild section replaced with vendor + rebuild script refs,
  shim-edit workflow replaced with modemd-ctrl equivalent, "shim is
  now dumb" replaced with historical note, Section 3 ("Current state")
  banner-flagged as historical (it described the host-paced
  Clock-Pump-v2 architecture), Section 9 quick-reference updated
  with current paths and Phase-2 territory note.
- **Historical doc banners:** added to IMPLEMENTATION.md, PJSIP.md,
  PJSIP-PROGRESS.md, slmodemd-pjsip.md preamble updated. The
  historical docs are kept in tree as reference but their banners
  point readers to README/QUICKSTART/MAINTAINERS for current
  authoritative content.
- **Tests:** 39/39 non-VM tests still passing after all edits. VM
  smoke test (3/3) confirms rootfs boots and S99modem-pjsip runs.
  Rootfs reassembles cleanly from `make -C vm clean && make -C vm`.

**Deferred for follow-up Phase 6 work:**
- Phase-2 territory (WIN_FIX_NOTES.md, src/native/spandsp-patches/README.md):
  noted in Handoff.md at the time of Phase 6, picked up and resolved
  in Phase 2 (April 2026). Both files deleted.
- BrowserModem.md: separate roadmap, untouched.

### Phase 6 (original scope, kept for reference)

10+ `.md` files with overlapping/stale content. Likely outcomes:
consolidate, delete obsoletes, refresh remainders.

### Phase 7 — Offline build / GPL compliance gaps (mostly done)

Most of the original Phase 7 scope was completed in Phase 6 Tier-1
(`scripts/vendor-sources.sh`, `scripts/rebuild-prebuilts.sh`,
`MAINTAINERS.md`, `COPYING` accuracy with all 9 components, the
GPL §3(a) corresponding-source statement, `vm/sources/README.md`
table fixes, the table fixes, kernel-tarball-split decision
documented as deferred).

**Remaining items, no longer needing a full phase:**

- **Kernel tarball >100 MB** — exceeds GitHub limit. Maintainer
  must pick an approach (LFS, unpacked tree, external host, split
  tarball) at first public release time. Documented as a per-release
  decision in `MAINTAINERS.md` under "Kernel tarball size: GitHub
  100 MB limit." Not blocking until first public push to GitHub.

- **`build/` directory in git history** — `.gitignore` now excludes
  `build/`, but if it's already committed to git, a one-time
  `git rm --cached -r build/` is needed to stop tracking it. Tiny,
  one command. Will become moot when Phase 2 removes
  `binding.gyp` and there's no `build/` to track at all.

- **Toolchain `.deb` cache** — `~/.cache/synthmodem/debs/` is fetched
  by `scripts/fetch-vm-binaries.sh` with SHA256 verification, on
  demand. Not committed (it's host-side cache, not GPL corresponding
  source — that lives in `vm/sources/` already). Documented in
  MAINTAINERS.md. No action needed.

These can be cleaned up opportunistically; no Phase 7 ceremony
required.

### Tier-2/3 doc retirement (small follow-up)

During Phase 6, four large historical documents (`IMPLEMENTATION.md`,
`PJSIP.md`, `PJSIP-PROGRESS.md`, `slmodemd-pjsip.md`) were
banner-flagged as historical with explicit pointers to the
authoritative current docs (README, QUICKSTART, MAINTAINERS, Handoff).

Per maintainer direction during Phase 6 followup discussion: these
will likely be removed from the repo at some future point and kept
internally (in transcripts, archive, or maintainer's notes). They
are not currently misleading — the banners do their job — but they
add ~140 KB of historical noise to a fresh checkout.

When ready: `git rm` these four files, add a one-line note to
`Handoff.md` Section 0 referencing where they migrated. Tiny work,
suitable to fold into whichever phase touches the historical
material next (most likely the same commit as Phase 2 since
several of them describe the now-removed host-paced backend).

`BrowserModem.md` is **separate roadmap territory** (Phase 9+,
post the Phase 8 below), not in the same retirement bucket — it
describes future work, not historical work.

### Phase 8 — Native modem stabilization + `auto` backend ✅ (DONE, April 2026)

Shipped across two real-modem-driven sessions (April 28-30) culminating
in the `auto` backend (drop v5) and a final QoL / Windows-timer-fix
extension. The arc is one coherent unit: the auto backend was only
buildable because the native protocols had reached real-modem
reliability. Delivered as a series of incremental drops with
real-modem-test feedback at each step rather than a single tarball.

**Driving factor.** After Phase 2 left native covering V.21 / V.22 /
Bell 103 with V.22bis / V.23 banner-flagged TESTING, the user had
two backends in tree but neither alone covered every caller they
wanted to support: slmodemd-pjsip didn't handle V.22-only / V.22bis-
only / Bell-103-only callers under `atInit = ['']` (the default
slmodemd state), and native didn't speak V.32bis / V.34. The
solution was to make the two backends compose cleanly enough that
either would handle whatever the caller wanted.

**What landed:**

*Native protocol stabilization (April 28-29, prerequisites):*

- **V.22 stabilization arc.** Port-faithful refactor against
  spandsp source: `V22Demodulator` extracted into its own module;
  RRC filter, scrambler, and Costas-loop tuning brought to the
  spandsp implementation's equivalent of "known good." Gardner
  symbol-timing recovery sign-corrected; LMS equalizer leak rate
  set to spandsp's value. Real-modem testing took the call from
  "no usable connection" through "essentially clean call after a
  6-second early-call burst" to user-confirmed "working very well,
  just as good as V.21, Bell103."
- **No-op UART frame heartbeat** — `src/sip/TelnetProxy.js`. When
  the menu is idle and the receive carrier has been silent for
  `terminal.menuIdleHeartbeatMs`, synthmodem emits a zero-length
  UART frame. This keeps the V.22 demodulator's UART resync
  recovery on the right side of an internal threshold; without it,
  receivers misframe after long silences. (User-configurable; can
  be disabled by setting to 0.)
- **Bell 103 / V.21 / V.23.** All three confirmed working at
  protocol level after the V.22 arc's UART improvements. V.23
  added via `FskCommon` shared base, extracted from the deleted
  `V32bis.js`.

*V.22bis answer-side completion (April 30):*

- Three fixes after a port-faithful spandsp re-read: spectral S1
  detector replacing the symbol-stream detector (Goertzel at
  900 Hz with carrier null verification); Gardner symbol-sync sign
  inversion (sign matched spandsp originate-side, not answer-side);
  LMS equalizer leak rate (was zero, should match spandsp). Result:
  V.22bis at 2400 bps user-confirmed working.

*V.8 sequencer rewrite (April 30):*

- Spandsp-faithful `V8Sequencer.js`: 75 ms post-CJ silence
  sample-accurate (counter, not setTimeout); `queue_flush` on CJ
  detection; JM topup-per-block instead of `setInterval(250)`;
  byte-identical CM matching (no merging hack, no grace-period
  acceptance). The non-spec band-aids from earlier prototypes were
  removed.

*V.25 legacy automode (April 30, drops v1-v5):*

- For non-V.8 callers (pure V.22bis / V.22 / V.21 / Bell103 with
  no V.8 advertising), the V.8 sequencer's `'failed'` branch enters
  a probe chain: V.22bis (5 s) → V.21 (3 s) → Bell 103 (5 s). Each
  probe instantiates a fresh protocol object (with `removeAllListeners`
  on the previous to prevent ghost CD events). Worst-case Bell 103
  connect ~22 s; fits inside 30 s S7.
- **`FskDiscriminator`** runs alongside FSK probes (V.21, Bell 103)
  to disambiguate cross-band leakage. Without it the V.21 and Bell
  103 demodulators would each false-positive on the other's caller
  mark, with whichever probe ran first winning regardless of the
  actual caller. Discriminator gates `hasCD()` on in-band-dominant
  energy with a 1.5× ratio over cross-band.
- **V.22bis anti-Bell103 spectral test**: `fskEnergy <= 4 *
  carrierEnergy + 0.002` at 1270 Hz (Bell 103 caller mark) vs
  1200 Hz (V.22 answer-side carrier). Rejects pure-tone Bell 103
  during V.22bis training without rejecting real V.22 QAM carrier.

*Auto backend (drop v5):*

- New value `'auto'` for `config.modem.backend`. Every call starts
  in `b2bua` mode (slmodemd-pjsip). `CallSession` watches for the
  pattern `_dspIsPooled && !_everConnected` at the moment of
  slmodemd-pjsip's `silenceHangup` — the deterministic 12 s V.8-
  timeout signature of a non-V.8 caller. On match, it tears down
  the internal SIP leg, hands the same RTP UDP socket off to a
  new `RtpSession.adoptSocket(...)` call, instantiates `ModemDSP`
  with `start({ skipV8: true, skipAnsam: true })`, and the native
  V.25 probe chain takes over.
- `RtpSession.adoptSocket(socket, remoteAddr, remotePort, ssrc)`
  and `RtpBridge.stop()` updated to release the socket without
  closing it. The caller has already heard ANSam from PJSIP, so
  native skips its own ANSam and goes straight to the V.25
  "answer-tone-heard, awaiting training" state.
- `_buildModemBackendSync` extended: `'auto'` requires a
  `ModemBackendPool` (same as `'slmodemd-pjsip'`), and the error
  enumeration is updated to list all three valid backend values.
- 6/6 new tests in `test/session/auto.test.js` + 0 regressions
  across the existing 88-test suite (94 total).

*QoL polish + Windows multimedia timer fix (April 30):*

- **Banner placeholders.** `terminal.banner` substitutes
  `{{protocol}}` and `{{bps}}` at TelnetProxy attach time. The
  per-call CONNECT info is captured during handshake and bound
  into the banner string before send.
- **publicHost auto-resolution.** New `src/sip/PublicHostResolver.js`
  (~140 LOC). When `config.sip.publicHost === ''`, the resolver
  picks per-call by INVITE source-IP-subnet match → first non-loopback
  → 127.0.0.1 fallback. Eliminates the most common LAN-side
  misconfiguration (manual PUBLIC_HOST mismatches HOST after a DHCP
  rebind).
- **Defaults updated** to `HOST = '0.0.0.0'`, `PUBLIC_HOST = ''`
  (was per-instance LAN IP for both).
- **RTP heartbeat log-level.** `RtpBridge.js` heartbeat lowered
  from `info` → `debug` (was visually noisy).
- **Windows multimedia timer extended to `auto`.** This is the
  most important fix in the session. The startup-time
  `timeBeginPeriod(1)` claim in `src/index.js` was gated only on
  `backend === 'native'`; auto mode runs the native DSP after the
  swap and equally needs the 1 ms timer, but the guard was never
  updated when auto was added. Symptom: intermittent garbage
  characters on the caller's terminal during pure-marking idle,
  often masked by audio capture being enabled (sync `fs.writeSync`
  per audio chunk happened to dampen the timer-quantum bursts).
  When the user disabled capture the symptom appeared and was
  initially misattributed to the QoL drop. **Lesson recorded in
  MAINTAINERS.md and Handoff.md: any future fourth backend that
  runs the native DSP on the host event loop MUST extend this
  guard.**

**Documentation that landed with this phase:**

- `README.md` — added `'auto'` backend in Status section,
  How-it-works section, and `modem.backend` config bullet. Updated
  System Requirements to clarify QEMU and the win-timer-resolution
  addon now serve `auto` too.
- `QUICKSTART.md` — added `'auto'` to BACKEND value list, "Pick
  auto if" guidance bullet, new HOST/PUBLIC_HOST defaults
  documentation, expanded "Verifying the timer fix on Windows"
  section to cover auto and explain the prebuilt vs build-from-source
  paths thoroughly.
- `MAINTAINERS.md` — Windows-timer paragraph extended to cover
  `auto`, plus a maintainer-warning note about the guard condition.
- `slmodemd-pjsip.md` — top-of-file note that auto mode also
  exercises this code path during its first-attempt phase.
- `IMPLEMENTATION.md` — superseded the "Automatic backend selection"
  non-goal in §9 (now shipping).
- `Handoff.md` — full sweep treatment as a separate step covering
  the entire arc from V.22 stabilization through the Windows-timer
  fix. New methodology entries in "Decisions and solutions" for
  spandsp-port-faithful work and capture-driven diagnostics.

**Pending / deferred (logged here, not in scope for Phase 8):**

- UART resync logic for FSK protocols (V.21, Bell 103, V.23).
  Logged April 28 — the V.22 UART improvements may benefit them
  too; not yet evaluated.
- TelnetProxy outbound TCP `setNoDelay(true)` + `setKeepAlive(true,
  30000)`. Trivial 2-line fix, logged in Handoff §0.
- Audio capture for the slmodemd-pjsip phase of `auto` mode.
  Auto currently captures only the post-swap (native) portion of
  the call. Phase 4-5 territory.
- Test client revival. Phase 5 territory.

## Status by area (Phase 1)

| Area | State | Notes |
|------|-------|-------|
| `src/backends/SlmodemBackend.js` | pending | Helpers `parseResultLine`, `RATE_TO_PROTOCOL` extracted to `src/backends/at-result-line.js` first |
| `src/backends/ModemBackendPool.js` | pending | Drop `_defaultFactory` for SlmodemBackend; PjsipBackend factory becomes mandatory |
| `src/session/CallSession.js` | pending | Drop `'slmodemd'` branch in `_buildModemBackendSync` |
| `src/index.js` | pending | Drop `if (backend === 'slmodemd')` pre-warm branch |
| `config.js` | minimal touch | Drop only Backend-A-exclusive keys; remainder marked TODO(cleanup) for Phase 3 |
| `vm/shim/` | pending | Delete entire directory; relocate `wire.h` → `vm/ctrl/wire.h` first |
| `vm/overlay/` | pending | Delete entire directory; `vm/overlay-pjsip/` is the surviving overlay |
| `vm/prebuilt/modemd-shim-i386` | pending | Delete |
| `vm/images/rootfs.cpio.gz` | pending | Delete (Backend-A image) |
| `vm/Makefile` | done | `rootfs-pjsip` is the default target. New `rootfs-builder-base` target produces a minimal cpio (busybox + libc + virtio modules, no synthmodem-specific binaries) used by the build scripts as the toolchain-VM foundation — replaces the cycle-prone "use the runtime rootfs as the build base" pattern. |
| `vm/qemu-runner/SlmodemVM.js` | KEEP, name is misleading | Base class for `QemuVM`. Used by both backends conceptually; `slmodemd` is still in the runtime VM. Possible later rename, not now. |
| `vm/qemu-runner/QemuVM.js` | KEEP | Subclasses `SlmodemVM` |
| `test/slmodem/` | pending | Delete entire directory (8 files, 1691 LoC) |
| `test/mock-slmodemd/` | pending | Delete entire directory |
| `test/pjsip/*.test.js` | pending | Retarget initrd to `rootfs-slmodemd-pjsip.cpio.gz` |
| `test/tunnel/echo.test.js` | pending | Retarget initrd to `rootfs-slmodemd-pjsip.cpio.gz` |
| `scripts/build-slmodemd-in-vm.sh` | pending | Drop shim build section. Repoint base rootfs to pjsip image. Keep slmodemd build (Backend B uses it). |
| `scripts/build-pjsip-in-vm.sh` | pending | Repoint base rootfs to pjsip image. Replace shim/wire.h fallback copy with ctrl/wire.h. |
| `scripts/fetch-vm-binaries.sh` | minor | Update comments referring to "slmodemd and modemd-shim" |
| `scripts/fetch-slmodemd.sh` | minor | Update comments referring to vm/shim/ |
| `scripts/fetch-vm-sources.sh` | unchanged | Sources unchanged by Phase 1 |
| `captures/*.log` | pending | Delete stale `slmodemd-boot.*.log` files (the directory and bootlog mechanism stay) |

## Reproducibility gaps (Phase 7 detail)

From the analysis done at the start of Phase 1:

1. **vm/sources/ is empty of actual tarballs.** `git ls-files vm/sources/`
   shows only `.gitkeep`, `README.md`, `SHA256SUMS`. The README claims
   sources travel with every clone for GPL compliance, but they don't.
   `fetch-vm-sources.sh` exists, has pinned SHA256s, and works — it just
   hasn't been run + committed.

2. **`vm/sources/linux_6.1.159.orig.tar.xz` is 131 MB**, exceeds GitHub's
   per-file 100 MB limit. `vm/sources/README.md` lists three options
   (Git LFS, unpacked tree, external hosting); none chosen yet.

3. **Toolchain `.debs` are fetched at build time, not vendored.** The build
   scripts download ~300 MB of `.debs` from `deb.debian.org` and cache in
   `~/.cache/synthmodem/debs/`. A truly offline cold rebuild requires that
   cache to be pre-populated. Strategy decision needed: vendor vs.
   formally document the network dependency.

4. **vm/sources/README.md references `scripts/build-vm-binaries.sh`**
   (lines 110, 202, 206) which does not exist. Stale doc reference.

5. **vm/prebuilt/README.md** documents only `slmodemd` and
   `modemd-shim-i386`. It's missing `d-modem`, `modemd-tunnel-i386`,
   `modemd-ctrl-i386`, `pjsip-test-peer-i386`. Stale.

What is NOT a gap (verified):
- `vm/kernel/`, `vm/libc/`, `vm/busybox/` are all committed binaries.
  `make clean` does not touch them; only `make distclean` removes them.
  Even if Debian's archive vanished, an existing checkout could still
  build the runtime rootfs.
- `vm/slmodemd/` source tree is committed in full. `fetch-slmodemd.sh`
  is the maintainer-side refresh tool, not a bootstrap requirement.
- `vm/d-modem/d-modem.c` is committed.
- All `vm/prebuilt/` binaries are committed.

## Verification protocol for Phase 1 — results

### Static tests (sandbox) — ✅ all passed

- `make -C vm rootfs-pjsip` from clean state produces 4.0 MB rootfs +
  5.5 MB bzImage with the four pjsip helper binaries packed.
- `make -C vm rootfs-builder-base` produces a 2.6 MB minimal cpio
  (busybox + libc + virtio modules) for build-script use.
- `vm/ctrl/` builds clean (native + i386 verified).
- 39/39 non-VM Node tests pass: 11 ctrl/standalone, 13 rtp/fixed-buffered,
  4 rtp/bridge, 6 sip/uac-unit, 5 session/b2bua.

### Functional tests (operator host) — ✅ confirmed

User confirmed slmodemd-pjsip and native both still functioning from
the v1 tarball. Highest-confidence validation possible.

### Cold-clone level 1 — ✅ COMPLETED

Reproduced the entire `vm/prebuilt/` tree from source in a clean
sandbox (gVisor/Ubuntu 24.04). Two cold-build runs (slmodemd then
pjsip+helpers), all binaries built inside fresh i386 Debian-bookworm
VMs running on QEMU TCG.

Hash comparison of cold-built vs. committed binaries:

| binary                | result      | notes |
|-----------------------|-------------|-------|
| slmodemd              | ✅ identical | byte-for-byte match |
| d-modem               | ✅ identical | byte-for-byte match |
| modemd-tunnel-i386    | ✅ identical | byte-for-byte match |
| modemd-ctrl-i386      | ⚠ differs    | embeds `git describe --dirty` BUILD_ID; this rebuild ran from a dirty working tree (Phase-1 edits uncommitted), original was built clean at commit `322fd93`. Rebuilding from a clean checkout would match exactly. |
| pjsip-test-peer-i386  | ✅ identical | byte-for-byte match |

All five binaries: ELF 32-bit i386 PIE, GLIBC max symbol version 2.34
(under runtime's 2.36), zero `__isoc23_*` symbols. Reproducibility is
real and the modern-glibc gotcha is fully avoided.

Wallclock: slmodemd cold-build ~9 min, pjsip cold-build ~32 min, both
under sandbox TCG. Operator hosts with KVM/HVF acceleration finish in
a few minutes total.

### Cold-clone level 2 — deferred to Phase 7

Full offline rebuild (no `~/.cache/synthmodem/debs` populated, no
network) requires the vendored .debs strategy decision documented in
the "Reproducibility gaps" section above.

### Bugs found and fixed during verification

1. **`build-pjsip-in-vm.sh` only installed d-modem**, ignoring
   modemd-tunnel, modemd-ctrl, and pjsip-test-peer that the in-VM
   init script also produces. Fixed: added an `install_one()` shell
   function that installs all four, with d-modem required and the
   others best-effort with WARN on missing.

2. **No persistent cache for `pjsip.install.tar`** between cold-clone
   runs. The `mktemp -d` workdir was wiped on every script exit, so
   even though the in-VM logic supports skipping the ~25-min PJSIP
   compile when `/output/pjsip.install.tar` is present, the host
   side never preserved the artifact. Fixed: added persistent
   `~/.cache/synthmodem/pjsip/pjsip.install.tar` (configurable via
   `--pjsip-cache` flag or `SYNTHMODEM_PJSIP_CACHE` env). Subsequent
   cold-clone runs will reuse the cached PJSIP install and finish in
   ~3 min instead of ~32 min.

3. **`vm/Makefile` lacked a builder-base target.** The build scripts
   were trying to use the runtime rootfs as their toolchain-VM base,
   but the runtime rootfs requires `vm/prebuilt/d-modem` (a
   recursive dependency on what the build scripts produce). Fixed:
   added `rootfs-builder-base` target producing a 2.6 MB minimal
   cpio (busybox + libc + virtio modules) that build scripts use
   instead.

4. **`build-pjsip-in-vm.sh` qemu timeout 1800s was too tight under
   sandbox TCG.** Build legitimately takes ~32 min, original cap
   fired at 30:07. Bumped to 3600s.

5. **`captures/dsplibs.o`** was clobbered when stale .o cleanup
   accidentally globbed too aggressively. Restored from git index.

6. **`CallSession.js` lost `backend` local variable** when the
   slmodemd-only playoutMode override branch was removed. Caught by
   `test/session/b2bua.test.js` failure; reinstated the variable.

## Tarball delivery (this phase)

| file | content | operator-tested |
|------|---------|-----------------|
| `synthmodem-cleanup-phase1.tar.gz` (v1) | initial Phase 1 work | ✅ slmodemd-pjsip + native both confirmed |
| `synthmodem-cleanup-phase1-v2.tar.gz` | adds `rootfs-builder-base` + 3600s timeout | not yet |
| `synthmodem-cleanup-phase1-v3.tar.gz` | adds `install_one()` + persistent pjsip cache; cold-clone level 1 fully verified | next |
