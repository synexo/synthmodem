# SynthModem + slmodemd Integration Plan

Complete integration plan for adding a slmodemd-based modem backend to
synthmodem via a QEMU VM, while preserving the existing pure-JS / spandsp
backend for protocols we don't need slmodemd for.

This document captures the architecture, layering, build flow, licensing
decisions, and milestones agreed for this effort. It is the source of
truth for the integration. Individual milestone work may diverge in
implementation detail; this document should be updated when it does.

## 1. Guiding principles

**Never fork slmodemd.** Treat it as a vendored subtree pulled from
upstream. Any behavior changes we need happen in a tiny wrapper program
that sits beside slmodemd and talks to it over its existing
`socket_start()` / `-e <exec>` interface, which is the same interface
d-modem.c currently uses. When upstream moves, we replace the subtree
and rebuild.

**One cross-platform story.** A single QEMU system-mode VM image is the
runtime on both Linux and Windows. (macOS later, not targeted in v1.)
Read-only rootfs, boots from a known-good image every time, no persistent
state. Windows and Linux get the same VM image; only the QEMU host
binary differs.

**Clean interface boundary.** The only things crossing the host↔guest
boundary are PCM audio frames and AT-style control/status messages.
Two separate virtio-serial channels. No PTY bridging across the VM
boundary, no networking, nothing that requires virtualization-specific
workarounds.

**Everything redistributable.** GPL throughout, Smart Link DSP blob
under its existing redistribution terms (as shipped by the Debian
`sl-modem-daemon` package), QEMU under GPLv2, Linux kernel under GPLv2,
musl libc + Buildroot for the userspace. No AGPL anywhere.

**Explicit backend selection.** No auto-detection. `config.modem.backend`
must be set to `'slmodemd'` or `'native'` explicitly. If the selected
backend is unavailable at startup, synthmodem fails loudly rather than
silently falling back. This avoids the common class of bug where a
misconfigured system "works" on the wrong backend.

**One call at a time.** v1 is strictly single-session. slmodemd itself
only handles one modem, and synthmodem's architecture already has a
single `activeSession` global. No pooling, no multiplexing.

## 2. Repository layout

```
synthmodem/
├── IMPLEMENTATION.md                this file
├── config.js                        existing — backend selector added here
├── package.json                     existing
├── src/                             existing, mostly untouched
│   ├── sip/  rtp/  telnet/  session/
│   ├── dsp/                         existing pure-JS backend stays
│   └── backends/
│       ├── NativeDSPBackend.js      wraps existing ModemDSP
│       └── SlmodemBackend.js        drives the VM, conforms to ModemDSP API
├── vm/                              everything VM-related
│   ├── README.md
│   ├── Makefile                     top-level: build-image, clean
│   ├── buildroot-config             pinned Buildroot .config
│   ├── kernel-config                minimal i386 kernel .config
│   ├── overlay/                     files overlaid onto Buildroot rootfs
│   │   ├── etc/inittab
│   │   └── etc/init.d/S99modem
│   ├── shim/                        the in-guest glue program
│   │   ├── modemd-shim.c
│   │   ├── wire.h                   shared wire-protocol header
│   │   └── Makefile
│   ├── slmodemd/                    vendored subtree of D-Modem's slmodemd/
│   │   ├── UPSTREAM.txt             pinned commit hash + fetch date
│   │   └── ...                      (from synexo/D-Modem, slmodemd/ subdir)
│   ├── qemu-runner/                 cross-platform VM lifecycle code
│   │   ├── qemu-args.js
│   │   ├── qemu-detect.js
│   │   └── SlmodemVM.js
│   └── images/                      build output (gitignored)
│       ├── bzImage
│       ├── rootfs.cpio.gz
│       └── VERSION
├── vendor/
│   └── qemu/                        redistributed QEMU binaries, per-host
│       ├── linux-x86_64/
│       └── windows-x86_64/
├── scripts/
│   ├── fetch-slmodemd.sh            pulls slmodemd/ from synexo/D-Modem
│   ├── fetch-qemu.sh                downloads QEMU binaries per host
│   └── build-vm.sh                  orchestrates buildroot + kernel + image
└── test/
    └── slmodem-smoke.js             end-to-end smoke test (M1-aware)
```

The `vm/slmodemd/` directory is a vendored subtree (`git subtree` or a
plain extracted snapshot, with the pinned commit hash recorded in
`vm/slmodemd/UPSTREAM.txt`). We do not modify files inside it. All
synthmodem-specific logic lives in `vm/shim/modemd-shim.c`.

## 3. Architecture

```
┌─────────────────────── Host (Linux or Windows) ─────────────────────────┐
│                                                                         │
│  synthmodem (Node.js)                                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  SipServer → CallSession → SlmodemBackend                         │  │
│  │                                 │                                 │  │
│  │                                 ▼                                 │  │
│  │                            SlmodemVM ─ spawns ─► qemu-system-i386 │  │
│  │                              │   │                                │  │
│  │                       audio  │   │  control                       │  │
│  │                   (net.Socket)   (net.Socket)                     │  │
│  └──────────────────────┼──────────┼────────────────────────────┬────┘  │
│                         │          │                            │       │
│              TCP loopback 127.0.0.1 (chardev=socket in QEMU)    │       │
│                         │          │                            │       │
│                         ▼          ▼                            │       │
│  ┌─────────────── QEMU process ────────────────────────────┐    │       │
│  │                                                         │    │       │
│  │   ┌─────────── Guest Linux VM ─────────────────────┐    │    │       │
│  │   │                                                │    │    │       │
│  │   │  /dev/vport0p1 (audio)  /dev/vport0p2 (ctrl)   │    │    │       │
│  │   │         │                       │              │    │    │       │
│  │   │         ▼                       ▼              │    │    │       │
│  │   │   ┌───────────────────────────────────┐        │    │    │       │
│  │   │   │          modemd-shim              │        │    │    │       │
│  │   │   │  - reads virtio-serial            │        │    │    │       │
│  │   │   │  - bridges slmodemd's socketpair  │        │    │    │       │
│  │   │   │    audio + PTY AT/data            │        │    │    │       │
│  │   │   └───────────────────────────────────┘        │    │    │       │
│  │   │                   │                            │    │    │       │
│  │   │                   ▼                            │    │    │       │
│  │   │   ┌───────────────────────────────────┐        │    │    │       │
│  │   │   │            slmodemd               │        │    │    │       │
│  │   │   │  - unmodified, vendored upstream  │        │    │    │       │
│  │   │   │  - DSP via dsplibs.o              │        │    │    │       │
│  │   │   │  - owns /dev/ttySLn PTY           │        │    │    │       │
│  │   │   │  - audio over socketpair          │        │    │    │       │
│  │   │   │  - `-e /usr/local/bin/modemd-shim`│        │    │    │       │
│  │   │   └───────────────────────────────────┘        │    │    │       │
│  │   └────────────────────────────────────────────────┘    │    │       │
│  └─────────────────────────────────────────────────────────┘    │       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key hook point.** slmodemd has a documented `-e <exec>` flag: on modem
start, slmodemd creates two `socketpair(AF_UNIX)` pairs, `fork()`s, and
`execv()`s the program named by `-e`, passing the child's ends as
argv[2] (audio fd) and argv[3] (sip-info fd). d-modem.c is the existing
consumer of this contract. We write a new consumer (`modemd-shim`) that
takes d-modem.c's place. slmodemd's source stays 100% untouched.

## 4. Components

### 4.1 modemd-shim (guest-side glue, new C code, ~300 lines)

The only code we write on the guest side. Invoked by slmodemd via `-e`,
with three argv values: `dialstr audio_sock_fd sip_info_fd` — matching
d-modem.c's contract exactly.

Its job:

- Parse argv, obtain the two inherited file descriptors
- Open `/dev/vport0p1` (audio virtio-serial port) and
  `/dev/vport0p2` (control virtio-serial port)
- Open slmodemd's PTY (`/dev/ttySL0`) for AT commands and data
- Relay streams in a `poll()` loop:

```
  [audio virtio]   <-- PCM16 frames -->    [slmodemd audio socketpair]
  [control virtio] <-- AT cmds + status --> [slmodemd PTY]
```

Framing on the virtio side is length-prefixed messages (u16 length + u8
type + payload, little-endian), defined in `wire.h` shared between the
shim and the Node host-side parser. We deliberately do NOT pass
slmodemd's `struct socket_frame` across the VM boundary — C struct
layout is a portability hazard, and this way the wire format is ours
and stable.

Build: statically linked against musl, 32-bit i386 to match slmodemd's
ABI.

### 4.2 VM image (Buildroot, no custom code, just configs)

Buildroot because: mature, reproducible, handles the
i386-userspace-on-arbitrary-kernel case cleanly, large package catalog,
entire image driven by one `.config` file.

Image contents:

- **Kernel**: mainline Linux, minimal i386 `.config`: virtio-pci,
  virtio-serial, serial console, tmpfs, /proc, /sys, devtmpfs. No
  networking stack compiled in. Target ~2 MB bzImage.
- **Userspace**: musl libc, busybox for init+shell+utilities, the shim,
  slmodemd, and `dsplibs.o`. All i386.
- **Init**: busybox init; `/etc/init.d/S99modem` mounts /proc, /sys,
  waits for virtio-serial devices, execs slmodemd with
  `-e /usr/local/bin/modemd-shim`.
- **Rootfs format**: `cpio.gz` initramfs. Loaded entirely into RAM at
  boot. Read-only by definition.

Target image size after compression: 3–5 MB total. Boot time from QEMU
start to "slmodemd ready": under 2 seconds on any modern host.

Build: one `make` in `vm/`. Buildroot downloads kernel sources, builds
the cross-compiler, builds musl, busybox, slmodemd (via a Buildroot
package we define that points at vendored `vm/slmodemd/`), the shim,
packs the initramfs, outputs `vm/images/bzImage` + `vm/images/rootfs.cpio.gz`.

**slmodemd update workflow:**

```
./scripts/fetch-slmodemd.sh         # refreshes vm/slmodemd/ from D-Modem
cd vm && make                       # rebuilds image with new slmodemd
```

No patching unless upstream breaks the d-modem.c exec contract (no
reason for them to).

### 4.3 Host-side Node components (new JS, ~600 lines)

#### `vm/qemu-runner/SlmodemVM.js` — VM lifecycle class

```
SlmodemVM (EventEmitter)
  constructor(opts)          opts.qemuBinary, opts.kernelPath,
                             opts.initrdPath, opts.socketDir
  start()                    spawns QEMU, returns Promise resolved on 'ready'
  stop()                     SIGTERM qemu, wait 2s, SIGKILL if needed
  writeAudio(pcm16)          send audio frame to guest
  sendAT(string)             send AT command to guest
  writeData(buf)             send modem-data bytes to guest (post-CONNECT)
  on('ready')                guest shim announced itself
  on('audio', pcm16)         raw 16-bit PCM frame from guest
  on('status', {...})        CONNECT / NO CARRIER / RING / OK / ERROR
  on('data', buf)            modem-data bytes from guest
  on('error')                unrecoverable — caller should respawn
  on('exit')                 QEMU exited
```

Internals: spawns QEMU with flags built by `qemu-args.js`; creates two
server sockets via `net.createServer()` on loopback TCP ports (defaults
25800 audio / 25801 control; configurable via
`config.modem.slmodemd.transport`). QEMU connects to them as client
(`chardev=socket,server=off,nodelay=on`). TCP is used on every platform
— earlier versions split Unix-sockets-on-Linux vs named-pipes-on-Windows,
but both had platform-specific jitter/buffering issues that broke modem
symbol timing. Host-side framer is a small `StreamParser` on each socket.

#### `vm/qemu-runner/qemu-args.js` — QEMU command-line builder

Differences between hosts are small: only the accelerator choice
(KVM on Linux, WHPX on Windows, HVF on macOS, TCG fallback everywhere).
The transport syntax is identical across platforms since we moved to
TCP loopback. Accelerator selection is opportunistic and falls back to
TCG if nothing else is usable. TCG performance is acceptable for this
workload — slmodemd's DSP is trivial on modern CPUs even at ~5×
emulation slowdown.

#### `vm/qemu-runner/qemu-detect.js` — find QEMU binary

Priority: shipped binary in `vendor/qemu/<host>/qemu-system-i386`, then
`$PATH`, then fail clearly.

#### `src/backends/SlmodemBackend.js` — ModemDSP-compatible facade

Implements the same event interface as existing `ModemDSP`:

```
receiveAudio(samples)   Float32Array → pcm16 → vm.writeAudio()
emit('audioOut', ...)   vm.on('audio') → pcm16 → Float32Array
emit('connected', ...)  vm.on('status') CONNECT → parse rate, emit
emit('data', ...)       vm.on('data') → emit
write(buf)              → vm.writeData()
start() / stop()        lifecycle passthrough
```

`CallSession` does not need to know which backend it holds.

### 4.4 QEMU binary vendoring

QEMU is GPLv2, redistributable. Pre-built binaries live under
`vendor/qemu/` per host OS.

- Windows x86_64: official QEMU Windows binaries from qemu.weilnetz.de
- Linux x86_64: minimal static QEMU built from upstream source

Binaries are fetched by `scripts/fetch-qemu.sh` with pinned URLs + SHA256s.
Not run at install time — run at release-build time; artifacts ship in
release archives (not git-tracked).

GPL corresponding-source obligation: release archive includes a `SOURCES.md`
pointing at the exact upstream tarball + our build recipe for each
bundled binary.

## 5. Wire protocol (shim ↔ Node)

Two channels, both length-prefixed framed streams over virtio-serial.

### Frame format

```
  u16 length (LE)  |  u8 type  |  payload[length - 1]
```

The `length` field covers `type + payload`, so a type-only message with
empty payload has `length = 1`.

### Audio channel (`/dev/vport0p1` / `synthmodem-audio`)

| Type       | Value | Direction | Payload                                       |
|------------|-------|-----------|-----------------------------------------------|
| AUDIO      | 0x01  | both      | 320 bytes = 160 int16 LE samples @ 8 kHz (20ms) |
| SILENCE    | 0x02  | both      | empty; semantically 320 zero bytes            |

### Control channel (`/dev/vport0p2` / `synthmodem-control`)

| Type          | Value | Direction     | Payload                                              |
|---------------|-------|---------------|------------------------------------------------------|
| HELLO         | 0x10  | guest→host    | version string (ASCII, no NUL)                       |
| AT            | 0x11  | host→guest    | AT command string (no \r — shim appends it)          |
| AT_RESPONSE   | 0x12  | guest→host    | raw bytes from PTY while in command mode             |
| MODEM_STATUS  | 0x13  | guest→host    | JSON: `{"event":"CONNECT","rate":33600}` etc.        |
| DATA_TX       | 0x14  | host→guest    | bytes to send on the modem data path                 |
| DATA_RX       | 0x15  | guest→host    | bytes received on the modem data path                |
| HANGUP        | 0x16  | host→guest    | request hangup (shim emits `+++ATH` to PTY)          |

Command-vs-data disambiguation: shim tracks PTY state. When shim sees
`CONNECT <rate>` line from the PTY, subsequent bytes become DATA_RX.
When shim sees `NO CARRIER` or returns to command mode, reverts to
AT_RESPONSE.

## 6. Cross-platform concerns

### Transport (TCP loopback)

Node listens on two TCP loopback ports; QEMU connects as client via
`-chardev socket,host=127.0.0.1,port=N,server=off,nodelay=on`.

- Defaults: `127.0.0.1:25800` (audio), `127.0.0.1:25801` (control)
- Configurable via `config.modem.slmodemd.transport.{audioPort,controlPort,bindHost}`
- Ports sit below both Linux (32768+) and Windows (49152+) OS
  ephemeral ranges, so the OS won't accidentally pre-allocate them
  to unrelated outbound sockets before synthmodem binds
- `nodelay=on` disables Nagle on both ends — critical for the
  steady 8 kHz audio stream; otherwise 40 ms coalescing jitter
  corrupts modem symbol timing

Earlier versions used Unix domain sockets on Linux and Windows named
pipes on Windows. Both had platform-specific issues that broke the
steady audio stream:

- Windows named pipes suffered from libuv back-to-back small-write
  corruption (observed as AT command byte corruption) and tight
  default kernel buffers (~4 KB vs TCP's 64–128 KB)
- Even on Linux, splitting the transport by platform meant two code
  paths to maintain and two classes of bugs to chase

Loopback TCP with TCP_NODELAY is battle-tested in libuv and QEMU,
platform-uniform, and sidesteps both classes of problems.

### Accelerator

- Linux: try `-accel kvm`, fall back `-accel tcg`
- Windows: try `-accel whpx`, fall back `-accel tcg`

Detection at start: attempt preferred, on failure parse QEMU's error
output and retry with TCG. Log which is in use. TCG is acceptable for
this workload.

### Orphan QEMU processes

- Linux: Node spawns a small C wrapper (`pdeathsig-exec`) that calls
  `prctl(PR_SET_PDEATHSIG, SIGKILL)` then execs QEMU.
- Windows: tiny Windows-specific C helper that creates a Job Object
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns itself, then
  execs QEMU.

Node-side: `process.on('exit')` and `process.on('SIGINT')` handlers
kill QEMU gracefully on normal exits. OS-level mechanisms handle the
pathological SIGKILL-to-Node case.

### Path, temp dirs, etc.

Standard Node hygiene: `path.join`, `os.tmpdir()`, never hardcode.

## 7. Licensing summary

| Component         | License                                          | Ship?              |
|-------------------|--------------------------------------------------|--------------------|
| synthmodem JS     | relicense to GPLv2+                              | yes, source        |
| slmodemd          | GPLv2                                            | yes, source        |
| dsplibs.o         | Smart Link proprietary, Debian-redistributable   | yes, binary only   |
| modemd-shim       | GPLv2                                            | yes, source        |
| Linux kernel      | GPLv2                                            | yes, source link   |
| musl / Buildroot  | MIT / GPLv2 (all compatible)                     | yes, source link   |
| QEMU binaries     | GPLv2                                            | yes, source link   |
| PJSIP             | not shipped in this architecture                 | N/A                |

We do not ship PJSIP — it was d-modem.c's SIP stack, and the shim has
replaced d-modem.c entirely. Host-side SIP is whatever synthmodem
already has.

Every binary shipped has a corresponding-source story: build recipe
in-tree (`vm/Makefile`, Buildroot config, kernel config), slmodemd and
shim sources vendored, QEMU fetch script pins upstream + SHA256.
Release archive includes `COPYING`, `SOURCES.md`, and per-component
license texts in a `licenses/` directory.

## 8. Build and release flow

### Developer flow (building locally)

```
./scripts/fetch-slmodemd.sh         # first-time: populate vm/slmodemd/
cd vm && make                       # ~15 min first build, cached after
cd .. && npm install                # Node deps
./scripts/fetch-qemu.sh             # downloads/builds QEMU for current host
node src/index.js                   # runs synthmodem
```

### Release flow

VM image is host-independent — same `bzImage` + `rootfs.cpio.gz` runs
on Linux QEMU and Windows QEMU. CI produces three release artifacts:

- `synthmodem-linux-x86_64.tar.gz`
- `synthmodem-windows-x86_64.zip`
- `synthmodem-source.tar.gz`

Each contains the same VM image, the appropriate QEMU binary, and the
same Node code.

### slmodemd upstream update flow

```
./scripts/fetch-slmodemd.sh --rev <new-commit-hash>
cd vm && make
# smoke-test, commit, release
```

Zero synthmodem code changes if the d-modem.c exec contract is stable.

## 9. Explicitly non-goals for v1

- Multi-call / concurrent sessions
- Kernel modules in the guest
- PJSIP in the guest
- PTY bridging across the VM boundary
- Networking in the guest
- Persistent guest state
- macOS host support
- ARM host support
- Automatic backend selection ("auto" mode)

## 10. Milestones

### M1 — Native Linux proof-of-concept, no VM

Goal: prove the shim's wire protocol and the backend's event plumbing
work, without the VM complexity. Develop directly on a host Linux box
with `socketpair`-connected shim + slmodemd.

Deliverables:
- `vm/shim/modemd-shim.c` — initial version speaking the wire protocol
- `vm/shim/wire.h` — wire-format header
- `vm/slmodemd/` — vendored subtree
- Build that produces a working `slmodemd` + `modemd-shim` pair on the host
- `src/backends/SlmodemBackend.js` — first cut, no VM, talks to shim
  over the same sockets the VM will eventually use
- Test harness: script that launches slmodemd + shim, feeds AT commands,
  verifies responses
- No call audio, no handshake. AT echo + ATI + AT+GMI + AT+MS? is enough.

Status: **DONE** (2026-04-21).

What landed:
- `vm/slmodemd/` vendored at commit 902c79aa..., with UPSTREAM.txt pin.
- `vm/shim/modemd-shim.c` + `vm/shim/wire.h`: 862 lines total, builds
  clean in both x86_64 and i386, zero warnings. Includes
  struct socket_frame handling (fixed during M1 — the initial version
  of the shim assumed raw PCM on the slm_audio socketpair; real slmodemd
  writes 324-byte tagged-union frames, so the shim needed a staging
  buffer and type dispatch).
- `vm/qemu-runner/wire.js` + `vm/qemu-runner/SlmodemVM.js`: Node-side
  lifecycle and wire framing.
- `src/backends/SlmodemBackend.js`: ModemDSP-compatible facade. Passes
  the same event surface CallSession already uses, so selecting the
  backend is a config toggle.
- `config.js`: added `config.modem.backend` (default 'native') and
  `config.modem.slmodemd` block.
- `test/mock-slmodemd/`: a faithful host-native mock of slmodemd's
  `-e` exec contract + AT parser. Required because this project's
  development sandbox has no i386 kernel ABI support; the mock makes
  every test runnable on plain x86_64 CI. On real Linux hosts the
  same tests can be pointed at the real slmodemd binary by setting
  `config.modem.slmodemd.slmodemdPath` to it.
- Tests, all passing:
  - `test/slmodem/wire.test.js` — 21 tests: frame encode/decode,
    fragmentation, errors, aliasing, C↔JS constant sync.
  - `test/slmodem/backend.test.js` — 12 tests: PCM conversion,
    result-code parsing, protocol mapping.
  - `test/slmodem/smoke.test.js` — 8 tests: SlmodemVM start/stop,
    HELLO handshake, AT→OK / ATI3→version / unknown→ERROR round
    trips via PTY through shim, SlmodemBackend audioOut path.
- Licensing surface: `COPYING` at repo root, `licenses/` with GPL-2.0,
  SLMODEMD-BSD-3, and DSPLIBS-NOTICE. Covers all redistributed bits.

Sandbox lesson (for future milestones): this dev environment blocks
cross-`bash_tool` process state — backgrounded Unix-socket listeners
don't survive across bash invocations. Any multi-process test that
needs cooperation between a listener, a subprocess, and a client must
happen within a single `bash_tool` call, typically as a single Python
orchestration script. `test/slmodem/smoke.test.js` demonstrates the
pattern: Node drives everything from one process.

### M2 — VM image

Status: **DONE** (2026-04-21).

Runtime VM assembled from pinned Debian bookworm i386 binaries
(kernel, busybox, glibc), not Buildroot. Our slmodemd + modemd-shim
are prebuilt inside a build-VM using the same kernel + glibc 2.36
we ship, to avoid glibc version mismatches on modern hosts. Both
prebuilts are committed to `vm/prebuilt/` with SHA256 pinned in
`PROVENANCE.txt`.

The VM is delivered as a two-file artifact:
  - `vm/images/bzImage`             (5.5 MB, kernel)
  - `vm/images/rootfs.cpio.gz`      (3.3 MB, initramfs)

QEMU loads both directly via `-kernel` and `-initrd`, no disk image.
Guest is stateless; every boot starts from the same bytes.

`QemuVM.js` (subclass of `SlmodemVM`) spawns qemu-system-i386 with:
  - virtio-serial-pci bus
  - two virtserialport children bound to TCP loopback chardevs in
    client mode (`server=off,nodelay=on`) — QEMU connects out
    to the TCP listeners Node set up in the SlmodemVM parent class
    (defaults `127.0.0.1:25800` audio, `127.0.0.1:25801` control)
  - port names `synthmodem.audio` + `synthmodem.control` exposed
    inside the guest as `/dev/virtio-ports/<name>`

Inside the guest:
  - busybox init → rcS (mounts /proc /sys /dev /dev/pts /tmp)
    → inittab respawns S99modem on ttyS0
  - S99modem loads virtio kernel modules (not built-in in bookworm
    i386), enumerates `/sys/class/virtio-ports/vport*/name` to
    create `/dev/virtio-ports/<name>` symlinks ourselves (no
    udev/mdev), chmod 0666 the underlying device nodes, then execs
    slmodemd as a dedicated `slmodemd` user (uid 100)
  - slmodemd sees `getuid() != 0` so skips its drop-privs block
    entirely (upstream slmodemd refuses to keep privileges via a
    `setuid(0) != -1` self-check; running as uid 100 from the
    start bypasses this cleanly)
  - slmodemd creates `/tmp/ttySL0` PTY link (uid 100 can't write
    to /dev, upstream code line 1694 switches to /tmp)
  - slmodemd fork-execs modemd-shim with audio + SIP fds as argv
  - shim opens the virtio-serial char devices for host I/O and
    the PTY symlink for AT command round-trip

End-to-end smoke verified: `test/slmodem/vm-smoke.test.js` passes
all 5 assertions (HELLO, AT/OK, ATI3/version, ATZZZ/terminator,
clean stop). Boot-to-HELLO takes ~7 seconds under TCG emulation.

GPL compliance: all shipped GPL binary's sources are vendored in
`vm/sources/` (kernel 6.1.159-1, busybox 1.35.0-4, glibc
2.36-9+deb12u13). Toolchain sources (gcc 12.2.0, binutils 2.40,
make 4.3) also vendored there for offline reproducibility (not
required by GPL but useful if i386 support is lost upstream).
`scripts/fetch-vm-sources.sh` populates the directory.

Rebuild path: `scripts/build-slmodemd-in-vm.sh` runs a one-shot
build VM that produces both prebuilt binaries. Uses the same
kernel + glibc as the runtime VM, so output is guaranteed
compatible. End users never run this; they install `npm install`
and use the committed binaries. Maintainers re-run when the
slmodemd source is updated or the runtime glibc pin moves.

### M3 — Windows host support

Status: **DONE** (2026-04-21 initial transport layer, 2026-04-22
TCP migration). Verified end-to-end: vm-smoke.test.js all 5
assertions pass under Windows PowerShell with QEMU-TCG.

#### Final design (TCP loopback, both platforms)

Current deliverables:
  - `vm/qemu-runner/transport.js` — single unified transport.
    Node listens on two TCP loopback ports (`127.0.0.1:25800` audio,
    `127.0.0.1:25801` control by default; overridable via
    `config.modem.slmodemd.transport`). QEMU connects as client
    via `-chardev socket,host=...,port=...,server=off,nodelay=on`.
    No platform split; the same code path runs on Linux and Windows.
  - `QemuVM._performStartSequence()` — single flow: start TCP
    listeners, spawn QEMU, await accept of both inbound connections
    in any order, hand sockets to the parent `SlmodemVM`'s audio/
    control handlers.
  - Windows 10/11 QEMU installer doesn't add its directory to
    PATH, so Node's default `spawn('qemu-system-i386')` fails with
    ENOENT. Users must set the `QEMU_SYSTEM_I386` env var or
    configure `config.modem.slmodemd.qemuPath`.
  - Error-path hardening: `_handleFatal` no longer double-emits
    `'error'` while `start()` is still in flight — the Promise
    rejection is the sole error contract during startup, event
    emission is the contract afterwards.

#### Why TCP (rather than the original named-pipe plan)

The initial M3 design used Unix domain sockets on POSIX and Windows
named pipes on Windows — the idea being to use each platform's
native IPC primitive. That shipped and passed vm-smoke, but caller-
side testing against a real Conexant SoftK56 exposed two problems:

  1. **AT command corruption on back-to-back writes.** On Windows
     named pipes, libuv's internal write scheduling coalesced
     back-to-back small writes in a way that corrupted the wire
     framing: bytes from command N overlapped command N-1's payload.
     Papered over with a 50 ms inter-command sleep, but that only
     fixes the visible symptom.
  2. **QAM handshake failure at the training stage.** V.32/V.22bis
     handshakes reached the answer side but never progressed through
     TRN — thousands of decoder errors consistent with sub-ms
     symbol-timing jitter. The audio pipeline Node→named pipe→
     QEMU chardev→virtio-serial→slmodemd was introducing enough
     jitter to break QAM symbol decisions (FSK at 300 bps tolerated
     it fine — Phase 5 Bell 103 succeeded).

Moving both channels to loopback TCP with `TCP_NODELAY` fixed the
first problem directly (no more libuv pipe-write race) and removed
a likely contributor to the second. TCP has 64-128 KB kernel buffers
vs the pipe's ~4 KB, so burst handling is far more forgiving.
Unifying the transport also cut a large chunk of platform-specific
code from `transport.js` and `QemuVM.js`.

#### Historical (pre-TCP) M3 notes, retained for archaeology

The original named-pipe-on-Windows path had these discovered-in-
testing quirks, now irrelevant to the current code but preserved
here in case future contributors revisit pipe-based transports:

  - Windows QEMU took a **bare** pipe name in the chardev argv
    (`path=qemu-audio`), NOT a fully-qualified `\\.\pipe\` path.
    The full-path form created a pipe at an escaped name that
    clients couldn't connect to.
  - Clients had to connect via `\\.\pipe\<name>` (the kernel pipe
    namespace), not the bare name.
  - QEMU created pipes lazily in argv order, so Node had to connect
    serially: audio first, then (once the first pipe had a client)
    control. Parallel connects hung.

#### Pre-warm VM pool (added with the TCP migration)

Booting QEMU+kernel+initramfs+slmodemd takes ~8 seconds. Doing that
at call time meant the caller heard silence (or worse, a truncated
training response) until our side was ready. The fix:
`src/backends/ModemBackendPool.js` pre-warms a single backend at
process start and keeps it hot. `CallSession` pulls the warm
backend from the pool at SIP-ACK time and only then issues `ATA`.
On hangup, the backend is fully torn down (including TCP socket
release) before a replacement VM is booted in the background, so
the next call finds the pool already warm.

  - `SlmodemBackend.start()` — boots the VM, waits for HELLO,
    returns with slmodemd in command mode (no `ATA` yet).
  - `SlmodemBackend.activate()` — runs `atInit` then `ATA`,
    begins answer tone. Called per-call.
  - `ModemBackendPool.recycle(backend)` — awaits the backend's
    stop (so its TCP ports are released) before kicking off a fresh
    warmup. Serialisation of the stop-then-start sequence is
    essential: in testing, firing them concurrently raced
    EADDRINUSE on the replacement VM.

Deferred to M5 (Hardening):
  - Orphan-process protection via Windows Job Objects. Currently
    if Node crashes without clean-stop-ing the VM, QEMU keeps
    running until manually killed. Job Objects guarantee the
    child dies when the parent does.

### M4 — Release engineering

Pin QEMU versions, write fetch/build scripts, CI producing three
release artifacts, install/run docs on both OSes, `vm/README.md`
covering slmodemd-update procedure, `licenses/` bundle, `SOURCES.md`.

### M5 — Hardening

Crash recovery behavior, ready-detection robustness, timeouts on every
wait, structured logging, backend-selection config validation,
documentation of the shim/Node boundary for future contributors.

### M6 — Post-v1 (not scheduled)

VM pool for concurrent calls, macOS support, ARM Linux via
qemu-user-static in the VM.

## 11. Testing strategy

**Layered testing, each layer testable independently:**

1. **Wire protocol unit tests** — frame encode/decode, both languages
   (C test for shim, JS test for Node parser). Fuzz the framer.
2. **Shim integration tests (M1)** — spawn slmodemd + shim connected to
   a local test harness (Python or Node script acting as "the Node
   host side"), exercise AT commands, verify response round-tripping.
   No VM yet.
3. **Backend integration tests (M1+)** — `SlmodemBackend.js` connected
   to a local shim, same test surface as ModemDSP.
4. **VM boot test (M2)** — QEMU launches image, shim announces HELLO
   within timeout.
5. **VM AT test (M2)** — VM version of M1's AT round-trip test.
6. **Full call test (M2+)** — synthmodem SIP + backend + VM + real
   modem / software modem emulator on the other end. Not in M1.
7. **Cross-platform CI (M3+)** — AT round-trip test on Windows runner.

Tests that do not need real hardware or network should be fully
scripted and live under `test/`. Tests requiring a SIP peer or real
modem go under `test/manual/` with clear preconditions documented.

---

This document should be kept up-to-date as implementation progresses.
When a milestone changes scope, edit the relevant section.
