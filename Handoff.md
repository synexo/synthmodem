# SynthModem — Session Handoff

This document is intended for a new Claude session picking up work on
SynthModem. You will typically be told:

> *Start sandbox and pull the synthmodem repo. Read Handoff.md.*

**Current state (as of this handoff): Clock Pump v2 is working.**
Connect rate 100% so far, banner displays, external telnet connections
succeed, BBS browsing works. The code in the main repo IS the good
state. No tarball-switching needed. See §3 for the architecture
summary and watch-points.

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
- `vm/images/rootfs.cpio.gz` — initramfs we build (contains shim + slmodemd)
- `vm/prebuilt/slmodemd` — slmodemd binary, built in a bookworm VM
- `vm/prebuilt/modemd-shim-i386` — our shim binary
- `vm/slmodemd/` — slmodemd source (D-Modem-derived, see §7)
- `vm/shim/` — shim source (our code)
- `vm/qemu-runner/` — Node-side QEMU launcher, wire protocol codec
- `vm/overlay/` — init scripts that run in the VM at boot

### Wire protocol (host ↔ shim)
Two TCP loopback connections:
- Audio channel: `127.0.0.1:25800`
- Control channel: `127.0.0.1:25801`

Framing: `u16 length (LE) | u8 type | payload`. Types in
`vm/shim/wire.h` and `vm/qemu-runner/wire.js` (kept in sync).

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
The shim only uses symbols ≤ glibc 2.34 (verified via `nm -D`). Build
on the sandbox host:

```bash
cd vm/shim
make          # builds native + i386
nm -D modemd-shim-i386 | grep GLIBC_2 | sed 's/.*GLIBC_//' | sort -Vu | tail
# Max should be 2.34 for VM compatibility.
```

Then install:

```bash
cp vm/shim/modemd-shim-i386 vm/prebuilt/modemd-shim-i386
# Update hash in vm/prebuilt/PROVENANCE.txt
sha256sum vm/prebuilt/modemd-shim-i386
```

### Rebuild rootfs after binary changes
```bash
cd vm
make          # assembles /.rootfs-build, produces images/rootfs.cpio.gz
```

Output: `vm/images/rootfs.cpio.gz`, typically 3.3 MB. Commit this
binary to git along with the prebuilts; users don't rebuild on install.

### Verify the new rootfs boots
```bash
node test/slmodem/vm-smoke.test.js
# Should pass 5/5: boot + HELLO, AT→OK, ATI3, unknown-cmd, clean stop
```

### Practical workflow for shim-only changes (the common case)
```bash
# 1. Edit vm/shim/modemd-shim.c
# 2. Build
cd /home/claude/synthmodem/vm/shim && make
# 3. Check glibc symbol versions
nm -D modemd-shim-i386 | grep GLIBC_2 | sed 's/.*GLIBC_//' | sort -Vu | tail
# 4. Install into prebuilt
cp modemd-shim-i386 ../prebuilt/modemd-shim-i386
sha256sum ../prebuilt/modemd-shim-i386   # note for PROVENANCE update
# 5. Update vm/prebuilt/PROVENANCE.txt
# 6. Rebuild rootfs
cd .. && make
# 7. Smoke test
cd .. && node test/slmodem/vm-smoke.test.js
```

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
    --exclude='synthmodem/captures' \
    --exclude='synthmodem/build' \
    --exclude='synthmodem/vm/.rootfs-build' \
    --exclude='synthmodem/vm/slmodemd/*.o' \
    --exclude='synthmodem/vm/slmodemd/slmodemd' \
    --exclude='synthmodem/vm/slmodemd/modem_test' \
    --exclude='synthmodem/vm/shim/modemd-shim' \
    --exclude='synthmodem/vm/shim/modemd-shim-i386' \
    --exclude='*.raw' \
    --exclude='.DS_Store' \
    -czf /mnt/user-data/outputs/synthmodem-m3-complete-v2.tar.gz \
    synthmodem
```

Rationale for each exclude:
- `.git/` — too big, user has their own repo
- `node_modules/` — user runs `npm install` on receipt
- `captures/` — per-call WAV/RAW dumps, huge and user-specific
- `build/` — node-gyp intermediate
- `.rootfs-build/` — vm Makefile staging dir
- `*.o`, `slmodemd` (source-dir binary), `modem_test` — intermediates;
  the committed `vm/prebuilt/` binaries are what ships
- `modemd-shim*` (source-dir) — same reason
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

### The shim is now dumb (this is a feature)

**Location**: `vm/shim/modemd-shim.c`.

The shim is a plain forward-on-arrival pipe: reads wire audio from
host TCP, writes to slmodemd's socketpair. Reads slmodemd's output,
sends to host. Handles the PTY control channel (AT, DATA_RX, AT
responses). No pacing, no gating, no ATA/NO_CARRIER/HANGUP triggers.

**Why**: all cadence intelligence is in Node now. The shim has one
job: deliver bytes across the VM boundary without changing them.

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

### Earlier misattributed theories

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
If you build slmodemd-adjacent code on the sandbox host:
```
/usr/bin/ld: warning: ... __isoc23_strtol@GLIBC_2.38
```
That binary won't load in the VM. Either:
- Build it in the bookworm VM via `scripts/build-slmodemd-in-vm.sh`
- Or (for the shim) avoid `strtol`/`atoi` entirely; we wrote
  `parse_dec_int` in modemd-shim.c for this reason

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

### Typical edit-build-test cycle
```bash
cd /home/claude/synthmodem
# 1. Edit vm/shim/modemd-shim.c
# 2. Build + install + rootfs + smoke test
cd vm/shim && make && cp modemd-shim-i386 ../prebuilt/ && \
  cd .. && make && \
  cd .. && timeout 90 node test/slmodem/vm-smoke.test.js
# 3. If smoke test passes, run full regression
for t in test/slmodem/*.test.js test/rtp/*.test.js; do
  r=$(timeout 180 node "$t" 2>&1 | tail -1)
  printf '%-45s %s\n' "$(basename "$t")" "$r"
done
# 4. If all 90 pass, build tarball (see §5)
# 5. present_files the tarball
```

### If you need to inspect D-Modem's upstream
```bash
# Clone fresh (or reuse from /tmp/dmodem if still there)
cd /tmp && git clone --depth=1 -b pjsip2.15 \
    https://github.com/synexo/D-Modem.git dmodem
# Then grep/compare as needed
diff <(tr -d '\r' < dmodem/slmodemd/modem_main.c) \
     <(tr -d '\r' < /home/claude/synthmodem/vm/slmodemd/modem_main.c)
```

### Expected shim log format
```
[shim I 5.700] DSP clock pump created (dormant); arms on ATA, ...
# The "I" is INFO; "D" is DEBUG; "E" is ERROR.
# The number is shim uptime seconds since startup.
# SYNTHMODEM_LOG_LEVEL=info or debug via kernel cmdline
# (QemuVM sets synthmodem_log=<level> on -append)
```

### Key file paths cheat-sheet
```
vm/shim/modemd-shim.c              — shim source (yours to edit)
vm/slmodemd/modem_main.c           — slmodemd source (D-Modem derived, usually frozen)
vm/prebuilt/modemd-shim-i386       — shipped shim binary
vm/prebuilt/slmodemd               — shipped slmodemd binary
vm/prebuilt/PROVENANCE.txt         — hash manifest
vm/images/{bzImage,rootfs.cpio.gz} — shipped VM images
src/backends/SlmodemBackend.js     — Node side of VM interface
src/rtp/RtpSession.js              — jitter buffer
src/session/CallSession.js         — per-call orchestration
config.js                          — all runtime knobs
scripts/build-slmodemd-in-vm.sh    — in-VM glibc-pinned build
scripts/compare-audio-dumps.py     — automated capture analysis
test/slmodem/vm-smoke.test.js      — boot-and-AT smoke test
test/rtp/fixed-buffered.test.js    — jitter buffer unit tests
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

## Update to human operator

Summary of the Handoff.md changes
Top banner — rewritten. Used to warn "don't use the main repo, pick up from old tarball". Now says Clock Pump v2 is working, use the main repo as-is.
§3 Current state — rebuilt around the working baseline:

TL;DR: Clock Pump v2 works, 100% handshake, BBS browsing confirmed
The working architecture in one sentence
The 6 key components (Clock Pump v2, dumb shim, fixed-buffered jitter, null-guards, banner simplification, audio tooling)
Clock Pump v2 in detail with state machine, tick algorithm, rationale
Telemetry line with healthy-value ranges
What's still imperfect (residual dup pattern, Windows timer jitter, V.34/V.90 not tested)
Config block with current recommended AT+MS=132,1,4800,4800
Recommended priorities if work resumes

§7 Decisions and solutions — reorganized:

Leads with Clock Pump v2 (WORKING — current baseline) including why it's in Node not the shim, why 10ms timer with catch-up
"The shim is now dumb (this is a feature)"
Kept sections for jitter buffer, crash fix, banner simplification
"Attempted fixes that regressed and were discarded" — documents the full shim-side clock pump, shim-side lifecycle gating, and kick-off silence failures so a future session doesn't re-attempt them
The frame-dup saga moved to "Earlier misattributed theories" since it's no longer the blocker

The mental model is now clear for a future session: this is the working code. The pump lives in Node. The shim is dumb. Don't regress these decisions.
