# synthmodem

A software modem-to-telnet gateway. Accepts SIP calls from a SIP
gateway, negotiates a real modem handshake in software, and bridges
the resulting data-mode stream to a telnet host. Lets a real modem
on a phone line dial into a modern BBS over SIP.

```
   Real Modem            SIP Gateway            synthmodem            Telnet Host
   on RJ11 line  ────►   (e.g. SPA2102) ────►   (this app)    ────►   (TCP/IP BBS)
   (V.21..V.34)          SIP/RTP/PCMU
```

End-to-end verified at V.34 33600 bps, plus the
classic low-end protocols (V.21, V.22, V.22bis, Bell 103) for
period-correct dial-in to vintage software.

Using with a Tandy TRS-80 Color Computer 3 using original Direct Connect Modem Pak: <https://www.youtube.com/watch?v=KmrtVg1ozqg>

## Quickstart

### Windows (zero-toolchain deployment)

This is the simplest path and the recommended option for Windows
users. No Node.js install, no QEMU install, no build tools, no
shell needed.

1. Download `SynthModem-win-x64.zip` from the latest release at
   <https://github.com/synexo/synthmodem/tree/main/release>.
2. Unzip it anywhere — the contents extract into a `synthmodem/`
   folder.
3. (Optional) Open `config.js` in any text editor and adjust the
   **COMMON CONFIG** block at the top — typically the LAN IP your
   SIP gateway will reach you on, and the AT init sequence you want
   answered modems to start in. Leave the QEMU and Node paths alone;
   their defaults assume the bundled layout.
4. Double-click `START.BAT`. A console window opens, runs a
   one-time `npm install` step (offline; the bundled prebuilt
   addon is loaded automatically), then starts the gateway.

The bundle ships everything needed to run:
`win/qemu/qemu-system-i386.exe` plus the firmware files our
i386 VM actually loads, `win/nodejs/` (Node.js + npm), the prebuilt
runtime VM image (`vm/images/bzImage`,
`vm/images/rootfs-slmodemd-pjsip.cpio.gz`), and the prebuilt
Windows multimedia-timer addon (`native/win-timer-resolution/
prebuilt/win32-x64/win_timer_resolution.node`).

To stop the gateway, press Ctrl-C in the console window or close it.

You will need (by default) port 5060 UDP/TCP open on Windows Firewall.

### Linux / macOS / Windows from a developer checkout

```sh
# 1. Clone the repository.
git clone https://github.com/synexo/synthmodem.git
cd synthmodem

# 2. Install Node dependencies. There are no runtime npm dependencies.
#    On Windows x64 a small prebuilt N-API addon is loaded automatically
#    (no compiler required); on other Windows archs `npm install` will
#    try to build it from source and fall back gracefully if the
#    toolchain isn't present. On Linux/macOS the addon step is skipped.
npm install

# 3. Edit config.js if needed. Most users only need to edit the
#    "COMMON CONFIG" block at the top of the file (LAN IP, backend
#    selection, AT init sequence, QEMU path on Windows).
$EDITOR config.js

# 4. Run.
node src/index.js
```

Default backend is `auto`. The repository ships with prebuilt VM
binaries (`vm/prebuilt/*`) and runtime images (`vm/images/bzImage`,
`vm/images/rootfs-slmodemd-pjsip.cpio.gz`), so no VM build is needed
at install time.

For a single-backend setup, set `config.modem.backend = 'native'` or
`'slmodemd-pjsip'` instead.

### System requirements

For the **Windows zip deployment** above, no prerequisites are
needed — Node.js and QEMU are bundled.

For a **developer checkout** on Linux, macOS, or Windows:

- Node.js 16 or later
- For the `slmodemd-pjsip` backend (and `auto`, which starts every
  call on slmodemd-pjsip): `qemu-system-i386`
  - **Linux**: `apt install qemu-system-x86`
  - **macOS**: `brew install qemu`
  - **Windows**: download from <https://www.qemu.org/download/#windows>
    and set the path in the `QEMU_PATH` constant at the top of
    `config.js` (alternatively in `config.modem['slmodemd-pjsip'].qemu.qemuPath`).
    Or use the bundled QEMU by leaving `QEMU_PATH` at its default
    `.\\win\\qemu\\qemu-system-i386.exe` and running from a clone
    that includes the `win/qemu/` directory.

No C/C++ toolchain is required for normal use. The native backend
is pure JavaScript (the previous spandsp-based addon was removed)
and the test client doesn't pull in any native packages. The one
optional native component is a tiny N-API addon
(`win-timer-resolution`, ~16 KB) that raises the Windows multimedia
timer to 1 ms — needed for stable RTP TX pacing whenever the host
event loop is running the modem DSP, which means the `native`
backend AND the post-swap phase of the `auto` backend. The repo
ships a prebuilt for **win32-x64** so that platform needs no
toolchain. On other Windows architectures (x86, arm64),
`npm install` tries to build it from source if Visual Studio Build
Tools and Python 3 are installed; if they aren't, the install still
succeeds with a clean warning and the app still runs (just without
the timer fix — modems will exhibit garbage characters during long
idle on those Windows installs). On Linux and macOS the addon step
is skipped entirely. See `QUICKSTART.md`'s "Verifying the timer fix
on Windows" section for what to look for at startup, and
`MAINTAINERS.md` plus `native/win-timer-resolution/README.md` for
the maintainer-side workflow.

### Basic Troubleshooting / SIP Gateway settings

If you have unstable connections, the likely fixes are to ensure
your SIP gateway and PC are hardwired (not wi-fi) and/or lower your
connection speed. I've tested up to 9600bps with reasonable stability
on wi-fi. Common modem connection strings for hayes compatible modems:
```
ATZ <- resets config
ATX0 <- disable dial tone detection, unless you've set it up on your SIP gateway
AT+MS=V32B,1,9600,9600 <- lock to 9600bps
```
Vintage modems (2400bps and below) should be more stable, but lack of
error correction in their protocols may still result in some garbage
characters over wi-fi.

Known good SIP gateway settings (these are from a SPA-2102)
```
RTP Packet Size: 0.030
Jitter Buffer Adjectment: disable
SIP Transport: UDP
Preferred Codec: G711u
Use Pref Codec Only: yes
Silence Supp Enable: no
Echo Canc Enable: no
Echo Supp Enable: no
Fax SED Detect Enable: yes
Fax CNG Detect Enable: yes
FAX Passthru Codec: G711u
FAX Codec Symmetric: yes
FAX Passthru Method: ReINVITE
FAX Process NSE:
Dial Plan: (*xx|<:modem@192.168.100.2>S0) <- adjust for IP, likely other methods viable, this provides no tone and requires no dial [ATX0 to disable dial tone, ATDT (no digits) to dial]
```
Need a SIP gateway? There are hundreds available on auction sites for < $20.

## How it works

synthmodem is a SIP server with a modem DSP attached. An incoming
INVITE creates a `CallSession`, which in turn brings up a backend.

The three backends differ in where the DSP runs and how that's chosen:

### `native` — pure-JavaScript, in-process

```
   ┌─────────── synthmodem (Node.js) ────────────┐
   │                                             │
   │   SipServer ──► CallSession ──► ModemDSP    │
   │                                  ▲      │   │
   │       PCMU RTP ◄──────────────── │      ▼   │
   │                                          TelnetProxy
   └─────────────────────────────────────────────┘
                                                  ▼
                                              Telnet host
```

- Node decodes RTP PCMU directly to Float32 PCM.
- Pure-JS protocol implementations under `src/dsp/protocols/` —
  V.21, V.22, Bell 103 (active), V.22bis and V.23 (TESTING) — run
  inline in the Node event loop.
- No external process, no VM, no compiled native addon. Runs the
  same on Linux / macOS / Windows.

### `slmodemd-pjsip` — slmodemd inside a VM, B2BUA on the host

```
   ┌─── synthmodem (Node.js) ───┐         ┌─── QEMU VM (i386) ───────┐
   │                            │         │                          │
   │   SipServer                │         │   PJSIP    ──► slmodemd  │
   │      │                     │         │     ▲       (DSP)        │
   │      ▼                     │         │     │                    │
   │   CallSession              │         │  d-modem ◄───── modem-   │
   │      │  external SIP/RTP   │         │                  ctrl    │
   │      ▼     leg             │         │                    │     │
   │   PjsipBackend             │         │                    │     │
   │      │                     │ tunnel  │                    ▼     │
   │      ▼                     │ (TCP    │  modemd-tunnel    PTY    │
   │   internal SIP leg ────────┼─chardev─┼──►                       │
   │   (UDP-over-TCP)           │         │                          │
   │                            │         │                          │
   └────────────────────────────┘         └──────────────────────────┘
            │                                              │
            ▼                                              │
        TelnetProxy ◄─────────── AT command + data ────────┘
            │
            ▼
        Telnet host
```

- Node terminates the external SIP/RTP leg, runs as a B2BUA, and
  INVITEs a PJSIP instance running inside a QEMU VM.
- Inside the VM, [d-modem](https://github.com/synexo/D-Modem)
  bridges PJSIP's audio to slmodemd's socketpair. slmodemd handles
  the full V.21 → V.34/V.90 protocol stack with its proprietary
  Smart Link DSP blob (`dsplibs.o`).
- A small in-VM helper (`modemd-ctrl`) bridges slmodemd's PTY to
  Node so AT commands and data-mode bytes flow back through the
  control channel.
- Audio between Node and the VM travels as raw RTP datagrams over
  a TCP virtio-serial chardev (no decode/encode round-trip on
  Node's side). All of D-Modem's media optimizations apply
  (software clock, fixed jitter buffer, PLC/VAD/EC off, PCMU
  priority, direct socketpair coupling).

The result is significantly more robust handshake reliability for
V.32bis and faster protocols than the in-process native DSP,
because the DSP and the SIP/RTP scheduler share an OS-level event
loop with tightly bounded jitter inside the guest.

### `auto` — slmodemd-pjsip first, native fall-through on V.8 timeout

Composes the two backends above. Every call starts on slmodemd-pjsip
in the same `b2bua` topology shown above. If the caller is V.8-capable,
the slmodemd-pjsip path completes the handshake (including high-rate
modes like V.32bis/V.34) and the call stays there for its duration.

If V.8 times out without a CONNECT — the deterministic signature of
a non-V.8 vintage caller (Bell 103, V.21, V.22, V.22bis-without-V.8) —
synthmodem **swaps the call mid-flight to native**: it tears down the
internal SIP leg, hands the same RTP socket from `RtpBridge` to a new
`RtpSession`, instantiates `ModemDSP` with `start({ skipV8: true,
skipAnsam: true })`, and enters the V.25 legacy automode probe chain
(V.22bis 5 s → V.21 3 s → Bell 103 5 s). The caller has already heard
ANSam from slmodemd-pjsip's PJSIP and is sitting in V.25's
"answer-tone-heard, awaiting training" state, so the chain picks up
seamlessly.

Trade-offs:

- Best protocol coverage of any backend (V.21 through V.34/V.90 via
  slmodemd, plus V.21 / V.22 / V.22bis / V.23 / Bell 103 via native
  with no overlap on the slow end).
- Worst-case Bell 103 connect ~22 s from off-hook, well inside the
  30 s S7 ("wait for carrier") timer hardcoded in vintage terminal
  software like HyperTerminal and Procomm Plus.
- Inherits the native backend's Windows multimedia-timer requirement
  for the post-swap phase. The `win-timer-resolution` addon is
  claimed at startup for `auto` mode for the same reasons it is for
  `native`.
- Audio capture currently only covers the post-swap native phase;
  the slmodemd-pjsip phase is not yet captured (see Phase 4-5 in
  `CLEANUP.md`).

## Configuration

Every runtime knob lives in `config.js` at the repository root.

The top of the file contains a **COMMON CONFIG** block — a flat list
of named constants for the settings most users edit (LAN IP, SIP
port, backend selection, role, QEMU path, AT init sequence, log
levels, etc.). The structured sections below reference these
constants, so editing a value at the top changes it everywhere it's
used. For fine-grained tuning, edit the relevant section directly.

Section overview:

- `sip` — SIP server bind address, ports, NAT settings
- `rtp` — RTP port range, packet interval, playout/jitter mode
- `modem.backend` — `'auto'`, `'native'`, or `'slmodemd-pjsip'`
  (default `'auto'`)
- `modem.role` — `'answer'` (server) or `'originate'` (test client)
- `modem.captureAudio`, `modem.captureDir` — per-call WAV capture
  for the native backend, and for the post-swap (native) phase of
  the auto backend (slmodemd-pjsip-phase support is future work)
- `modem.native.*` — protocol selection, V.8 timing, DSP tuning,
  per-protocol carriers (only consumed when `backend = 'native'`)
- `modem['slmodemd-pjsip'].*` — QEMU launch parameters, transport
  ports, AT command init sequence (only consumed when
  `backend = 'slmodemd-pjsip'`)
- `telnet` — connect timeout, allowed/blocked hosts, terminal type
- `terminal` — banner, menu prompt, behavior

The file is heavily commented; read it to learn what each option
does and what side-effects to expect.

## Repository layout

```
.
├── COPYING                  License attribution and corresponding-source statement
├── MAINTAINERS.md           Release / GPL-compliance / rebuild workflow
├── README.md                This file
├── QUICKSTART.md            More detailed setup walkthrough
├── START.BAT                Windows entry point (used by SynthModem-win-x64.zip)
├── config.js                All runtime configuration
├── package.json             Node manifest (no runtime npm dependencies)
├── package-lock.json
│
│ ── Application (always shipped, runtime-required) ──
├── src/                     Node.js source — SIP, RTP, DSP, telnet proxy
├── vm/qemu-runner/          Node.js side of the QEMU launch / chardev wiring
├── vm/images/               Runtime VM images (bzImage + rootfs-slmodemd-pjsip.cpio.gz)
├── native/win-timer-resolution/
│                            Optional Windows multimedia-timer addon
│                            (source + win32-x64 prebuilt)
├── licenses/                License texts and per-component notices
│
│ ── Windows-only runtime (shipped in the .zip; in repo for completeness) ──
├── win/nodejs/              Bundled Node.js + npm for Windows
├── win/qemu/                Bundled QEMU for Windows (i386 system emulator + DLLs + share/)
│
│ ── Maintainer / development (not shipped in the .zip) ──
├── docs/                    Internal-development documentation
├── test/                    Test suites (unit, integration, loopback)
├── test-client/             SIP UAC + simulated originating modem for testing
├── scripts/                 Maintainer-side build, vendor, and release scripts
├── tools/                   Maintainer utilities
├── build/                   Build artifacts directory (gitignored output)
├── release/                 Windows release archive
|
│ ── VM build infrastructure (corresponding source; not shipped in the .zip) ──
└── vm/                      Runtime VM image build infrastructure
    ├── Makefile             Assembles vm/images/* from vm/prebuilt/* + vm/kernel/*
    ├── prebuilt/            Committed prebuilt binaries (slmodemd, d-modem, helpers)
    ├── kernel/              Linux kernel image and modules (build inputs)
    ├── libc/                glibc shared libraries baked into the rootfs
    ├── busybox/             busybox binary baked into the rootfs
    ├── slmodemd/            Vendored slmodemd source
    ├── d-modem/             Vendored d-modem.c (PJSIP audio bridge)
    ├── tunnel/              UDP-over-TCP tunnel (in-tree C source)
    ├── ctrl/                PTY ↔ control-channel bridge (in-tree C source)
    ├── pjsip-test-peer/     Test-only PJSIP UAS (in-tree C source)
    ├── pjsip/               PJSIP build customization (config_site.h, UPSTREAM.txt)
    ├── overlay-pjsip/       Static files baked into the runtime rootfs
    └── sources/             GPL/LGPL upstream source tarballs (corresponding source)

  Two further "corresponding source" trees live alongside win/:
    win/nodejs-release/      Node.js source mirror (MIT)
    win/qemu-source/         QEMU source mirror (GPL-2.0)
  Both are present in the git repository and excluded from the .zip.
```
## Backend Status

- **`auto` backend** (recommended) — Composes the two backends below
  to handle every supported caller without per-call configuration.
  Every call starts on slmodemd-pjsip; if the caller is V.8-capable,
  the high-rate handshake completes there and the call stays on the
  VM-backed path. If V.8 times out (a non-V.8 vintage caller), the
  call swaps mid-flight to the native backend's V.25 legacy probe
  chain (V.22bis → V.21 → Bell 103) for a low-speed handshake.
  Worst-case Bell 103 connect ~22 s, well inside the 30 s S7 timer
  hardcoded in vintage terminal software.
- **`slmodemd-pjsip` backend** — Stable. V.21 through V.34 via
  slmodemd's DSP inside a QEMU VM, paced by D-Modem's PJSIP
  integration. End-to-end tested.
- **`native` backend** — Pure JavaScript, in-process. All five
  low-speed protocols are validated end-to-end against real hardware
  modems over SIP/RTP: **V.21**, **V.22** (1200 bps), **V.22bis**
  (2400 bps), **V.23** (1200/75 split-speed FSK), and **Bell 103**.
  V.32bis and V.34 were removed in cleanup-phase-2 along with the
  spandsp dependency; for those higher speeds use the slmodemd-pjsip
  backend (or `auto`).

## Building from source

End users do not need to build anything beyond `npm install`. The
git repository ships with prebuilt VM binaries and runtime images,
and the Windows .zip release includes everything needed to run.

If you do need to rebuild — because you've patched slmodemd, bumped
PJSIP, or are auditing reproducibility — see `MAINTAINERS.md`. The
short version:

```sh
scripts/vendor-sources.sh        # populate vm/sources/ + toolchain cache
scripts/rebuild-prebuilts.sh     # rebuild vm/prebuilt/* + vm/images/*
```

The first run takes ~40 minutes total under sandbox/TCG; ~5
minutes on a host with KVM (Linux) or HVF (macOS) acceleration.

## Releases

Binary releases are published at
<https://github.com/synexo/synthmodem/tree/main/release>. The Windows
deployment bundle is named `SynthModem-win-x64.zip` and is the
recommended way for Windows users to install — see "Quickstart →
Windows (zero-toolchain deployment)" above.

The bundle is a curated subset of the repository: application code,
runtime VM image, bundled QEMU and Node.js, license documentation.
Build infrastructure (`vm/sources/`, `win/qemu-source/`,
`win/nodejs-release/`, `vm/prebuilt/`, `vm/kernel/`, `scripts/`,
`docs/`, `test/`, `test-client/`, `tools/`) is not included in the
zip — that material is for maintainers and is available from the
git repository. See `MAINTAINERS.md` for the bundle build procedure.

## Development

Made possible by D-Modem <https://github.com/cryan209/D-Modem>, spandsp <https://github.com/freeswitch/spandsp> and Claude. Synthmodem was built by Artificial Intelligence, incorporating open source code and binaries developed by humans.

## License

synthmodem is licensed under GPL-2.0-or-later. See `COPYING` for the
full attribution table covering bundled third-party components
(slmodemd, d-modem, PJSIP, the Linux kernel, busybox, glibc, plus
the spandsp-derived JavaScript ports under `src/dsp/`) and the
GPL §3(a) corresponding-source statement.
