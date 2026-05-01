# SynthModem — slmodemd-pjsip Backend Implementation Reference

This document is the implementation reference manual for the
`slmodemd-pjsip` backend (`config.modem.backend = 'slmodemd-pjsip'`):
how the pieces are laid out, what talks to what, how to build them,
how to debug them.

> **Note.** The `auto` backend (added 2026-04-30) also exercises this
> code path. Every call in `auto` mode begins on slmodemd-pjsip in
> the same b2bua topology described here; only if V.8 times out
> (caller is non-V.8) does the call swap mid-flight to native. Most
> of this manual applies unchanged to the slmodemd-pjsip phase of an
> auto-mode call. See `CallSession.js` (`_dspIsPooled` /
> `_everConnected` discriminator and `RtpSession.adoptSocket`) for
> the swap mechanism.

For the *why* — the motivation, high-level architecture, and
rationale — see [`PJSIP.md`](PJSIP.md). That's the design doc. This
is the manual.

For the implementation history (the step-log kept during the
backend's construction), see [`PJSIP-PROGRESS.md`](PJSIP-PROGRESS.md).

For the user-facing description and quickstart, see [`README.md`](README.md).
For the maintainer-side workflow (vendoring, rebuilding, release
packaging), see [`MAINTAINERS.md`](MAINTAINERS.md).

> **Note.** Some of the cross-references in this document still call
> the slmodemd-pjsip backend "backend B" — historical naming from
> when there were two VM-backed backends in flight. The host-paced
> "backend A" was removed in cleanup-phase-1 along with `vm/shim/`,
> `src/backends/SlmodemBackend.js`, and `vm/images/rootfs.cpio.gz`.
> Where this document compares slmodemd-pjsip to "the shim-based
> backend" or "backend A," that's a description of code that no
> longer exists in the tree.

## Contents

1. [Architecture recap](#architecture-recap)
2. [Repository layout](#repository-layout)
3. [The tunnel](#the-tunnel) — the transport layer
4. [Building](#building)
5. [Debugging](#debugging)
6. [Testing](#testing)
7. [Licensing notes](#licensing-notes)

---

## Architecture recap

```
External caller                Node (host)                        VM (guest)
──────────────                 ───────────                        ──────────

SIP UAC   ─── UDP :5060 ───►  SipServer
(over IP)                          │
                                   ▼
                              CallSession
                              (B2BUA mode)
                           ┌───────┴──────┐
                           │              │
                           ▼              ▼
                     external leg   internal leg
                        (as-is)           │
                           │              ▼
                           │        SipUacInternal  ◄──── (step 4)
                           │         + RtpSession
                           │              │
                           │              ▼
                           │        UdpTcpTunnel    ────►  modemd-tunnel
                           │        (host side)            (VM side)         [step 2]
                           │                                   │             ── COMPLETE
                           │                                   ▼
                           │                             pjsua / PJSIP
                           │                                   │
                           │                                   ▼
                           │                             d-modem.c
                           │                                   │
                           │                                   ▼
                           │                             slmodemd (AT, PTY)
                           │                                   │
                           └──────── PCM via RTP ──────────────┘
                                (modem handshake happens here)
```

The two innovations that make this architecture work:

1. **D-Modem's unchanged `d-modem.c` lives inside the VM alongside
   slmodemd**, with PJSIP providing the audio cadence slmodemd needs.
2. **A single tunnel carries all VM↔host UDP traffic** (SIP and RTP
   for the internal leg) over one virtio-serial chardev backed by a
   TCP loopback socket. No new host networking, no VM exposure.

Status of each step (see `PJSIP-PROGRESS.md` for the current
authoritative state):

| Step | What                                        | Status     |
| :-:  | :--                                         | :--        |
| 0    | Scaffolding, licensing                      | done       |
| 1    | Build pipeline (`d-modem` + PJSIP)          | done       |
| 2    | Tunnel helper                               | done       |
| 3    | PJSIP in VM with trivial test peer          | done       |
| 4a   | `SipUacInternal` (Node-side SIP UAC)        | done       |
| 4b   | `RtpBridge` + `PjsipBackend` + pool factory | done       |
| 5a   | `modemd-ctrl` + dual-chardev `PjsipBackend` | done       |
| 5b   | Real `S99modem-pjsip` + AT smoke test       | done       |
| 5c.1 | Symmetric tunnel + VmRegistrar +            | done       |
|      |   registered-mode d-modem                   |            |
| 5c.2 | CallSession B2BUA wiring + config           | done       |
|      |   integration                               |            |
| 6    | Handshake test (hardware)                   | next       |
| 7    | Sustained data mode (hardware)              | pending    |

---

## Repository layout

Backend B has files scattered across several top-level directories.
The organizing principle: everything tagged with `pjsip`, `tunnel`,
or `d-modem` belongs to backend B; everything else is shared or
belongs to backend A.

```
synthmodem/
├── PJSIP.md                          Design doc (why + what).
├── PJSIP-PROGRESS.md                 Progress tracker (which steps are done).
├── slmodemd-pjsip.md                 This file — implementation reference.
│
├── vm/
│   ├── prebuilt/
│   │   ├── slmodemd                  Shared with backend A.
│   │   ├── d-modem                   PJSIP-linked modem helper.        [step 1]
│   │   ├── modemd-tunnel-i386        VM-side UDP↔TCP bridge.           [step 2]
│   │   └── pjsip-test-peer-i386      Standalone PJSIP UAS for          [step 3]
│   │                                   integration testing only.
│   │
│   ├── d-modem/                      d-modem.c + its Makefile.         [step 0]
│   │   ├── d-modem.c                 Verbatim from upstream D-Modem.
│   │   ├── Makefile                  Links d-modem.c against PJSIP.
│   │   └── UPSTREAM.txt              Pinned upstream commit.
│   │
│   ├── pjsip/                        PJSIP build customization.        [step 0]
│   │   ├── config_site.h             (Empty — matches D-Modem.)
│   │   └── UPSTREAM.txt
│   │
│   ├── pjsip-test-peer/              Test-only PJSIP UAS.              [step 3]
│   │   ├── pjsip-test-peer.c         Auto-answer, no sound, no reg.
│   │   └── Makefile
│   │
│   ├── tunnel/                       Tunnel helper source.             [step 2]
│   │   ├── PROTOCOL.md               Wire-protocol canonical spec.
│   │   ├── modemd-tunnel.c           VM-side implementation.
│   │   └── Makefile
│   │
│   ├── ctrl/                         Control-channel helper source.    [step 5a]
│   │   ├── modemd-ctrl.c             VM-side PTY↔wire bridge; derived
│   │   │                               from modemd-shim with all audio
│   │   │                               stripped. Shares wire.h with
│   │   │                               shim via -I../shim.
│   │   └── Makefile
│   │
│   ├── sources/
│   │   └── pjproject-2.15.1.tar.gz   Vendored PJSIP source (GPLv2).
│   │
│   ├── overlay-pjsip/                Backend-B rootfs overlay.
│   │   └── etc/init.d/S99modem-pjsip Real init: lo up, load virtio,    [step 5b]
│   │                                   start modemd-tunnel &
│   │                                   modemd-ctrl (as uid 100), then
│   │                                   exec slmodemd -e d-modem.
│   │
│   └── images/
│       └── rootfs-slmodemd-pjsip.cpio.gz  Backend-B bootable image.
│
├── src/
│   ├── backends/
│   │   ├── ModemBackendPool.js       Pool state machine, now with      [step 4b]
│   │   │                               backendFactory extension point;
│   │   │                               default factory produces
│   │   │                               SlmodemBackend, backend B
│   │   │                               callers pass a PjsipBackend
│   │   │                               factory.
│   │   └── PjsipBackend.js           Backend-B orchestrator:           [step 4b,5a,5c]
│   │                                   QEMU + UdpTcpTunnel +
│   │                                   SipUacInternal + RtpBridge +
│   │                                   VmRegistrar + control-channel
│   │                                   wire parser. `mode === 'b2bua'`
│   │                                   marker so CallSession (step 5c)
│   │                                   knows the media plane is
│   │                                   internal. Options:
│   │                                   `enableControl: true` wires a
│   │                                   second chardev and exposes
│   │                                   `controlSocket` (step 5a);
│   │                                   `useRegistrar: true` gates
│   │                                   READY on d-modem's REGISTER and
│   │                                   updates targetUri to the
│   │                                   learned Contact (step 5c).
│   │                                   Emits `hello`, `connected`,
│   │                                   `data`, `silenceHangup`,
│   │                                   `media-ready`, `at-response`,
│   │                                   `error`. Methods: `sendAt`,
│   │                                   `write`, `start`, `startAsync`,
│   │                                   `activate`, `stop`.
│   ├── rtp/
│   │   └── RtpBridge.js              Stateless UDP packet forwarder    [step 4b]
│   │                                   for B2BUA media bridging.
│   │                                   No decode / re-encode.
│   ├── sip/
│   │   ├── SipUacInternal.js         Node-side SIP UAC that drives    [step 4a]
│   │   │                               in-VM PJSIP. Pairs with
│   │   │                               UdpTcpTunnel in production;
│   │   │                               unit-tested against a stub
│   │   │                               peer on loopback.
│   │   └── VmRegistrar.js            Node-side SIP registrar for the  [step 5c]
│   │                                   VM-internal leg. Parses
│   │                                   REGISTER from d-modem off the
│   │                                   tunnel's SIP channel, extracts
│   │                                   Contact (d-modem's ephemeral
│   │                                   port), and 200-OKs. Exposes
│   │                                   the learned binding to
│   │                                   PjsipBackend which uses it as
│   │                                   the INVITE target URI.
│   ├── session/
│   │   └── CallSession.js            Single owner of one active call;  [step 5c]
│   │                                   B2BUA branching for
│   │                                   `slmodemd-pjsip` backend. In
│   │                                   b2bua mode: raw dgram on RTP
│   │                                   port, hands to PjsipBackend,
│   │                                   skips receiveAudio/audioOut.
│   │                                   PCM mode unchanged.
│   └── tunnel/
│       └── UdpTcpTunnel.js           Node-side tunnel counterpart.     [step 2]
│
├── scripts/
│   └── build-pjsip-in-vm.sh          Builds d-modem + modemd-tunnel +  [step 1,2,3,5a]
│                                       modemd-ctrl + pjsip-test-peer
│                                       inside a bookworm build VM.
│
└── test/
    ├── slmodem-pjsip/
    │   ├── vm-smoke.test.js          Rootfs boots; standalone init     [step 1,5b]
    │   │                               correctly detects missing
    │   │                               chardevs (fail-closed).
    │   └── at.test.js                Full backend-B stack via          [step 5b,5c]
    │                                   PjsipBackend(enableControl,
    │                                   useRegistrar): d-modem
    │                                   REGISTERs with VmRegistrar,
    │                                   targetUri updated to learned
    │                                   Contact, AT commands round-
    │                                   trip (ATE0→OK, ATI→ident+OK)
    │                                   through modemd-ctrl↔slmodemd.
    ├── ctrl/
    │   └── standalone.test.js        modemd-ctrl wire protocol unit    [step 5a]
    │                                   test via Unix-socket stand-ins
    │                                   for control chardev and PTY.
    ├── sip/
    │   └── uac-unit.test.js          SipUacInternal unit tests         [step 4a]
    │                                   against a stub peer (no VM).
    ├── rtp/
    │   └── bridge.test.js            RtpBridge unit tests: ext↔int     [step 4b]
    │                                   forwarding, peer learning,
    │                                   stop semantics.
    ├── session/
    │   └── b2bua.test.js             CallSession b2bua branch unit     [step 5c]
    │                                   test via stubs (pool, backend,
    │                                   SIP server, dialog). No VM.
    │                                   Covers raw socket bind,
    │                                   backend.activate args, pool
    │                                   recycle on hangup, clean
    │                                   'ended' emit, port release.
    ├── tunnel/
    │   ├── framing.test.js           Frame layout unit tests.          [step 2]
    │   └── echo.test.js              End-to-end VM echo roundtrip.     [step 2]
    └── pjsip/
        ├── signaling.test.js         INVITE/ACK/BYE roundtrip via      [step 3]
        │                               raw SIP through the tunnel.
        ├── uac-invite.test.js        Same roundtrip but via the        [step 4a]
        │                               production SipUacInternal.
        ├── backend.test.js           PjsipBackend boots VM, places     [step 4b]
        │                               INVITE via SipUacInternal,
        │                               starts RtpBridge, ext→int
        │                               packets flow, clean teardown.
        ├── pool.test.js              ModemBackendPool warmup/checkout  [step 4b]
        │                               /stop with PjsipBackend factory.
        ├── ctrl.test.js              Dual-chardev PjsipBackend boots   [step 5a]
        │                               with modemd-ctrl active;
        │                               HELLO arrives; step-4b flow
        │                               still works alongside.
        └── registrar.test.js         VmRegistrar unit tests via stub   [step 5c]
                                        tunnel. REGISTER + 200 OK +
                                        binding; Expires honored;
                                        refresh vs first-register
                                        events; missing Contact → 400;
                                        non-REGISTER ignored.
```

---

## The tunnel

The tunnel is the transport layer for backend B's internal SIP leg:
SIP signaling between Node-side `SipUacInternal` and in-VM PJSIP, plus
the RTP that carries the modem's PCMU frames between them.

**Why a tunnel at all?** We considered three alternatives and rejected
each:

- **Expose PJSIP on the host network.** QEMU can forward a guest UDP
  port to a host port. But this opens an externally reachable SIP/RTP
  surface from a VM whose threat model is "trust nothing in the
  guest." We've already committed to not giving the VM any network.
- **Give the VM a TAP device and let Node route SIP across it.** Adds
  a networking stack to maintain, elevates the guest to network-peer
  status, and requires ip-forwarding + potentially capabilities that
  make the runner harder to package. Pure overkill for a VM that needs
  to talk to exactly one process on exactly one host.
- **Share a memory region.** Too invasive in PJSIP. We'd have to fork
  pjmedia's transport abstractions, and then we'd own another
  substantial chunk of C code. That's what we're trying to avoid.

What we do instead: the host↔VM transport we **already have** (a
virtio-serial chardev backed by a TCP loopback socket) gets a third
port, dedicated to a small framed protocol that multiplexes the SIP
and RTP UDP streams. Both ends expose local UDP sockets so that PJSIP
in the VM and Node-side `SipUacInternal` on the host can `sendto()`
and `recvfrom()` as if they were talking across a regular network.
All the framing lives in two small programs we own (`modemd-tunnel`
and `UdpTcpTunnel`).

### Wire protocol

Canonical spec: [`vm/tunnel/PROTOCOL.md`](vm/tunnel/PROTOCOL.md).
The short version:

```
offset  size  field
──────  ────  ─────
     0  u16   length     // bytes after this field
     2  u8    channel    // 0=SIP 1=RTP 2=RTCP 255=ECHO
     3  u16   src_port   // UDP source port on sender side
     5  u16   dst_port   // UDP destination port on receiver side
     7  var   payload    // UDP datagram body
```

All little-endian (both sides are LE so no conversion is needed in
practice). Maximum payload 8 KB; typical RTP payloads are ~200 bytes
and SIP messages are under 2 KB.

### Channels

Each channel multiplexed over the same TCP stream corresponds to one
UDP socket on each side. Fixed port bindings:

| Channel | VM side (PJSIP binds here) | Host side (Node binds here) |
| :--     | :--                        | :--                         |
| SIP     | 127.0.0.1:5060 UDP         | 127.0.0.1:5062 UDP          |
| RTP     | 127.0.0.1:10000 UDP        | 127.0.0.1:10002 UDP         |
| RTCP    | 127.0.0.1:10001 UDP        | 127.0.0.1:10003 UDP         |
| ECHO    | *handled internally*       | *handled internally*        |

The +2 offsets on the host side are purely hygiene so real local SIP
clients don't compete with the tunnel.

**Why fixed ports?** Because each tunnel handles one PJSIP session.
`ModemBackendPool` allocates one VM per call, so dynamic dialog
multiplexing would be solving a problem we don't have. Fixed ports
let the tunnel code stay as small as it is.

### The echo channel

Channel 255 is a test hook built into both implementations.
When either side receives a frame tagged channel 255, it:

1. Does **not** forward to any UDP socket.
2. Swaps `src_port` and `dst_port`.
3. Writes the frame straight back onto the same TCP stream.

This is how the end-to-end integration test
(`test/tunnel/echo.test.js`) validates the transport without needing
PJSIP or any UDP consumer to be running. Production use should never
generate channel-255 frames.

### Source-address learning

Neither side knows in advance what ephemeral source port PJSIP (or
Node's `SipUacInternal`) will use. The tunnel learns the consumer's
source on the first packet received:

- When `modemd-tunnel` receives the first UDP packet on its SIP port,
  it remembers `(sin_addr, sin_port)` and uses that as the
  `sendto()` destination for all future VM-bound SIP frames arriving
  over the tunnel.
- When `UdpTcpTunnel` receives the first UDP packet on its SIP port
  (from the host-side consumer), it remembers `{ address, port }`
  and uses it as the destination for all future host-bound SIP
  frames.

Before learning, the respective side **drops** inbound frames for
that channel. This is fine in practice because PJSIP's SIP stack
sends first (via its registrar/INVITE) before expecting inbound
traffic, and Node's `SipUacInternal` will do the same (since it's
the UAC).

If the consumer ever changes source port mid-session (they don't in
normal operation), the learned peer updates to the latest source.
This is deliberate — PJSIP's ephemeral port is stable for the life
of a call but we don't want a port change to permanently break the
tunnel.

### Virtio-serial carrier

The tunnel rides on one virtio-serial chardev:

- **VM side** sees it as `/dev/virtio-ports/synthmodem.tunnel`
  (a character device).
- **Host side** is a TCP socket on loopback that Node's TCP listener
  accepts. QEMU, configured with `chardev=socket,server=off`,
  connects outbound to Node as a client.

The QEMU invocation Node uses:

```
-device virtio-serial-pci,id=virtio-serial0
-chardev socket,id=tunnel,host=127.0.0.1,port=<N>,server=off
-device virtserialport,chardev=tunnel,name=synthmodem.tunnel
```

Naming (`synthmodem.tunnel`) mirrors backend A's convention of
`synthmodem.audio` and `synthmodem.control`. Inside the VM, our
init script (`etc/init.d/S99modem-pjsip` once step 5 is real; a
synthesized init in the echo test today) loads virtio modules in
dependency order, waits for `/sys/class/virtio-ports/vport*` to
populate, and creates `/dev/virtio-ports/<name>` symlinks — no
udev/mdev required. This is borrowed verbatim from backend A's
`S99modem` because the problem is the same.

### Error handling

- **Unknown channel ID** → frame dropped silently. Forward-compat
  hedge; we can introduce new channels without breaking old builds.
- **Length field out of range** → close the TCP connection. Framing
  is desynchronized and there's no recovery. Node's
  `ModemBackendPool` should discard the VM and fetch another.
- **EOF mid-frame** → close. Same recovery.
- **UDP sendto() failure** → drop the datagram, log. UDP is lossy
  by definition; SIP retransmits, RTP is fire-and-forget.
- **Inbound frame for an unlearned channel** → drop the frame. The
  peer will retransmit (for SIP) or recover at the next packet
  (for RTP).

### Implementation notes

#### VM side: `vm/tunnel/modemd-tunnel.c`

~400 lines. Single-threaded, `poll()`-based loop over 4 file
descriptors (the tunnel chardev and the three UDP sockets). Partial
reads from the tunnel fd are tolerated via a persistent 16 KB stage
buffer that can hold one max-size frame plus a partial next frame.

Key design points:

- **`parse_dec_int`** instead of `atoi`/`strtol`. Same trap as
  `modemd-shim`: gcc 13 + glibc 2.39 redirect `atoi` to
  `__isoc23_atoi`, which doesn't exist in the runtime VM's glibc
  2.36. We hand-roll the parse.
- **Blocking I/O, not `O_NONBLOCK`.** `poll()` handles readiness;
  once a fd is readable we `read()`/`recvfrom()` and trust the
  kernel won't block. Simpler than the non-blocking alternative
  and no downside at our throughput levels.
- **UDP datagrams are atomic.** A full `sendto()` either writes the
  whole datagram or fails; no partial-write logic needed in that
  direction. The tunnel-to-TCP direction uses a `write_all()` helper
  that handles short writes.
- **SIGTERM/SIGINT are trapped** to set a flag; the main loop
  exits cleanly on the next poll iteration rather than being
  interrupted mid-frame.
- **Compile-clean with `-Wall -Wextra`** (host build AND VM build).

Configuration via environment variables, all optional:

```
SYNTHMODEM_TUNNEL_PATH       # default /dev/virtio-ports/synthmodem.tunnel
SYNTHMODEM_TUNNEL_SIP_PORT   # default 5060
SYNTHMODEM_TUNNEL_RTP_PORT   # default 10000
SYNTHMODEM_TUNNEL_RTCP_PORT  # default 10001
SYNTHMODEM_LOG_LEVEL         # error (default), info, or debug
```

Log output goes to stderr with a format of
`[tunnel <level> <uptime>] <message>`, e.g.:

```
[tunnel I 0.003] tunnel open: /dev/virtio-ports/synthmodem.tunnel (fd=3)
[tunnel I 0.004] SIP: bound 127.0.0.1:5060 (fd=4)
[tunnel I 0.015] tunnel ready
[tunnel I 1.234] SIP: learned peer 127.0.0.1:42891
```

#### Host side: `src/tunnel/UdpTcpTunnel.js`

EventEmitter. Symmetrically mirrors the C side. Key methods:

- `constructor({ tcp: { host, port, mode }, sipPort, rtpPort, rtcpPort, ... })`
- `await start()` — opens/accepts TCP, binds UDP sockets, resolves on ready.
- `await stop()` — cleanup.
- `sendEcho(payload, srcPort, dstPort)` — tests-only hook.

TCP modes:

- `'connect'` (default). Node connects outbound to a TCP server.
  Matches QEMU's `server=off` chardev (where QEMU is the client
  and Node is also the client; they both connect to the same
  TCP socket, which is… actually, this works because Node is the
  *server* accepting QEMU's connection. Rename below.)
- `'listen'`. Node is the TCP server; peer connects in.

In production Node listens on an ephemeral port and QEMU connects
to it as a client. Tests currently use the "socket hand-attached"
path: start a bare `net.createServer`, accept QEMU's connection,
attach that socket to a freshly-constructed `UdpTcpTunnel` without
calling `start()`. This keeps the test hermetic — the tunnel never
binds UDP, just handles the framing layer. (The `start()` path with
real UDP forwarding will be exercised in step 3 when we have a real
UDP consumer to test against.)

Events:

- `'ready'` — tunnel fully up.
- `'error'` — fatal; discard this tunnel.
- `'echo-reply'(payload, srcPort, dstPort)` — echo frame received.
- `'frame-rx'(channel, srcPort, dstPort, payload)` — low-level
  observer for debugging.

The parser uses a staged Buffer (`this.stage`). For each `'data'`
event, it appends to the stage and then in a loop: read length,
check if the full frame is present, extract and emit; repeat until
the stage is exhausted or only a partial frame remains. Handles
one-byte-at-a-time streaming correctly (unit tested).

---

## SIP registration (internal leg)

The tunnel's SIP channel is used by two independent Node-side
components:

- **`SipUacInternal`** — places INVITEs into the VM when a call
  needs to be routed to d-modem. The UAC; terminates a dialog.
- **`VmRegistrar`** — accepts REGISTER from d-modem's PJSIP,
  replies 200 OK, captures the Contact binding. Dialog-less.

Both subscribe to the tunnel's `frame-rx` event and distinguish
their traffic by SIP method (registrar cares only about REGISTER;
UAC about INVITE/ACK/BYE responses). They coexist on the same SIP
channel without coordination.

### Why a registrar at all

d-modem's PJSIP transport is configured with `cfg.port = 0`
([upstream d-modem.c line 807](vm/d-modem/d-modem.c)), which means
the kernel chooses an ephemeral UDP port for d-modem's SIP
listener each time it starts. Node has no way to guess that port
up-front: it changes per-boot. The choices are:

1. **Patch d-modem.c to bind a known port.** Vendoring policy
   says no ([`vm/d-modem/UPSTREAM.txt`](vm/d-modem/UPSTREAM.txt)).
2. **Scan `/proc/net/udp` for d-modem's process.** Works without
   signaling but requires a helper inside the VM and feels like a
   side channel. Sketchy.
3. **Run a SIP registrar and let d-modem's REGISTER tell us its
   Contact port.** This is how SIP was designed to work —
   ephemeral UDP bind + registration is the normal UA topology
   for consumer SIP phones. Makes d-modem act the way upstream
   intended.

We picked (3). Node-side registrar, because:

- Node already has a full SIP stack; we just add a REGISTER parser
  (tiny, ~200 LOC counting extensive doc comments).
- Tunnel traffic naturally routes REGISTER to Node.
- The learned Contact binding IS the answer — no derivation, no
  scanning, no timing race.
- Future changes are easier: a Node class is simpler to evolve
  than a C binary in the VM rootfs.

### d-modem's registered-mode path

At fork-exec time, slmodemd's `modem_main.c:socket_start` passes
any `-S/-U/-P` flags through as `--sip-server/--sip-user/
--sip-password` to d-modem. With credentials present, d-modem's
arg parser sets `direct_call = 0` and **skips** the empty-dialstr
exit at d-modem.c line 724 (which had been killing it at boot in
the pre-5c design). Registration flow:

1. d-modem reaches `pjsua_create()` / `pjsua_init()` / the 11
   media optimizations / `pjsua_set_null_snd_dev()` — everything
   normal for PJSIP bring-up.
2. UDP transport binds ephemeral (`cfg.port = 0`). Logged as
   `SIP UDP socket reachable at 127.0.0.1:<N>`.
3. `pjsua_acc_add` with `register_on_acc_add = true` and
   `reg_uri = "sip:127.0.0.1:5060"`. PJSIP sends REGISTER.
4. REGISTER arrives at modemd-tunnel's bound 5060 UDP socket.
   modemd-tunnel's peer-learning fires — it now knows d-modem's
   ephemeral port.
5. modemd-tunnel wraps the REGISTER as a tunnel frame (channel=0)
   and sends over TCP to Node.
6. Node's UdpTcpTunnel demultiplexes the frame and emits
   `frame-rx(0, srcPort, dstPort, payload)`. `VmRegistrar` is
   listening; parses the REGISTER, extracts Contact.
7. `VmRegistrar` calls `tunnel.injectFrame(0, ...)` with a 200 OK
   that echoes the Contact and Expires.
8. Tunnel frames the response back; modemd-tunnel delivers it to
   its learned peer (d-modem).
9. PJSIP logs `registration success, status=200 (OK), will
   re-register in 300 seconds`.

PJSIP refreshes at ~expires/2. VmRegistrar keeps 200-OKing.

### What PjsipBackend does with the binding

In the `useRegistrar: true` readiness path, PjsipBackend calls
`this._registrar.waitForRegistration(timeoutMs)` during
`startAsync()`. On success:

```js
const binding = await this._registrar.waitForRegistration(timeoutMs);
this.targetUri = binding.contactUri;  // e.g. 'sip:modem@127.0.0.1:58270;ob'
this._transition('READY');
```

The `targetUri` is then used as the INVITE target when
`activate()` constructs `SipUacInternal`. Fresh construction
per-activate means SipUacInternal doesn't need dynamic-URI
support; it takes the current value at call time.

### Security consideration

No digest authentication is implemented. VmRegistrar accepts any
REGISTER without challenge. Safe in this topology because the
tunnel is a loopback-scoped transport — no external network
reaches this registrar. If backend B ever gained a path from
external callers directly into this registrar, auth would need
to be added.

---

## Call flow (B2BUA)

When `config.modem.backend === 'slmodemd-pjsip'`, Node acts as a
SIP back-to-back user agent (B2BUA) bridging the external SIP leg
(the caller) to the internal SIP leg (PJSIP running inside the VM
as d-modem). The audio path bypasses Node entirely — RtpBridge
inside PjsipBackend shuttles RTP between an external `dgram.Socket`
CallSession owns and the internal-leg `dgram.Socket` PjsipBackend
owns, with no decode/encode in between.

### Sequence

```
  External                 Node                        VM
  ────────                 ────                        ──
                      [startup]
                      │
                      │ index.js constructs
                      │ ModemBackendPool with
                      │ PjsipBackend factory
                      │
                      ▼
                      Pool warmup: boots VM,
                      waits for REGISTER from
                      d-modem, READY. Pool
                      now holds a warm backend.

  INVITE ────────────►  SipServer.on('invite'):
  (external caller)      new CallSession(…),
                         await session.setup():
                           allocate RTP port P,
                           bind raw dgram on P
                           (no RtpSession),
                           sipServer.answerCall().
  ◄──────────── 200 OK
  (with P in SDP)

  ACK ───────────────►  SipServer.on('ack'):
                         session.activate():
                           pool.checkout() → PjsipBackend,
                           backend.activate({
                             extRtpSocket: rawDgram,
                             extPeer: {dialog.remoteRtpAddr,
                                       dialog.remoteRtpPort}
                           })
                      │
                      │ PjsipBackend INVITEs
                      │ d-modem via SipUacInternal
                      │ through the tunnel's SIP
                      │ channel.
                      │                           ───► INVITE to
                      │                                 sip:modem@
                      │                                 127.0.0.1:<reg>
                      │
                      │                           ◄─── 200 OK + SDP
                      │                                 (internal PJSIP)
                      │ ACK ───────────────────────────►
                      │
                      │ RtpBridge starts:
                      │   extSocket ↔ intRtpSock
                      │
  RTP from caller ───► rawDgram
                      (msg listener attached
                       by RtpBridge)
                      │
                      │ RtpBridge.send(intSocket,
                      │   127.0.0.1:10002)
                      │ → tunnel forwards to VM
                      │                           ───► UDP to d-modem
                      │                                 (learned peer port)
                      │
                      │ d-modem RX → DSP → PTY
                      │                           ───► modemd-ctrl
                      │                                 reads PTY
                      │                                 sees "CONNECT"
                      │
                      │                           ◄─── AT_RESPONSE
                      │                                 ("CONNECT\r\n")
                      │ controlSocket →
                      │ PjsipBackend wire parser
                      │ → parseResultLine →
                      │ emit('connected')
                      ▼
                      CallSession._onModemConnected():
                      post-train V.42 idle hold,
                      then TelnetProxy attached.

  RTP both ways    ◄─►  RtpBridge (stateless
                        forwarding)              ◄─► internal RTP
                                                      d-modem ↔ slmodemd
                                                      (audio socketpair)

  data bytes       ◄─►  TelnetProxy ↔ TCP
   (e.g. telnet         (terminal session,       ◄─► DATA_RX / DATA_TX
    to BBS)              not RTP)                      over controlSocket

  BYE ───────────────► SipServer.on('bye'):
                        session.onBye():
                          _finalizeTeardown:
                          pool.recycle(backend),
                          close rawDgram,
                          releaseRtpPort(P),
                          emit('ended').
                        Pool starts a fresh VM
                        in the background for
                        the next call.
```

### What CallSession sees

From CallSession's perspective, PjsipBackend looks identical to
SlmodemBackend on every observable axis:

| API / Event      | SlmodemBackend        | PjsipBackend        |
|------------------|-----------------------|---------------------|
| `start()`        | idempotent (pool path)| idempotent          |
| `activate(opts)` | ATA on PTY            | INVITE via UAC      |
| `write(buf)`     | shim `sendData`       | DATA_TX wire frame  |
| `stop()`         | kill VM               | kill VM             |
| `connected`      | CONNECT in shim status| CONNECT on PTY      |
| `data`           | `data-rx`             | DATA_RX wire frame  |
| `silenceHangup`  | silence + NO CARRIER  | NO CARRIER on PTY   |
| `error`          | boot / VM errors      | boot / VM / SIP err |
| `mode`           | `'pcm'`               | `'b2bua'`           |

The `mode` field is the only thing CallSession inspects
explicitly to branch; everything else is duck-typed to the same
shape. In PCM mode CallSession wires `receiveAudio`/`audioOut`;
in B2BUA mode it skips those and hands the raw RTP socket to the
backend.

### Why B2BUA?

The point is to land audio in d-modem's PJSIP **unmodified**.
PJSIP applies D-Modem's 11 media optimizations (software clock
domain, 40-frame fixed jitter buffer, PLC/VAD/EC disabled, PCMU
priority, 20ms frames, single audio thread, `dmodem_put_frame`
socketpair coupling, silence-on-underrun) in its send/receive
paths. If Node decoded RTP to float, ran it through ModemDSP,
and re-encoded back to RTP, we'd bypass that entire stack and
lose the reason backend B exists. RtpBridge is a byte-for-byte
forwarder on purpose.

---

## Building

For step-1 and step-2 binaries, the authoritative build recipe is
[`scripts/build-pjsip-in-vm.sh`](scripts/build-pjsip-in-vm.sh),
which builds inside a bookworm build VM so the resulting i386 PIE
binaries match the runtime VM's glibc 2.36. Do not rely on host
builds — they'll link against whatever glibc your dev host has,
which is almost certainly too new.

### First-time build (fresh checkout)

The maintainer-side workflow is wrapped in two scripts (see
`MAINTAINERS.md` for the full procedure):

```bash
# 1. Vendor sources + toolchain cache. One-time per workstation;
#    network-heavy, ~285 MB sources + ~115 MB toolchain debs.
scripts/vendor-sources.sh

# 2. Rebuild prebuilts from source. Run only when an upstream pin
#    or our in-tree source has changed; the committed
#    vm/prebuilt/* is authoritative between rebuilds.
scripts/rebuild-prebuilts.sh

# 3. Smoke-test the boot.
node test/slmodem-pjsip/vm-smoke.test.js

# 4. Smoke-test the tunnel end-to-end.
node test/tunnel/echo.test.js
```

The wrappers internally call:

- `scripts/vendor-sources.sh` → `scripts/fetch-vm-sources.sh` +
  `scripts/fetch-vm-binaries.sh`
- `scripts/rebuild-prebuilts.sh` → `scripts/build-slmodemd-in-vm.sh`
  + `scripts/build-pjsip-in-vm.sh` + `make -C vm`

End users do not run any of this — the release tarball ships
prebuilt binaries and runtime images.

### Iterating on `modemd-tunnel.c` or `d-modem.c`

With the PJSIP cache in place, a rebuild cycle is about a minute
(plus rootfs reassembly):

```bash
# Edit your source, then rebuild just the PJSIP-linked binaries
# (skip slmodemd, which doesn't change):
scripts/rebuild-prebuilts.sh --pjsip

# Re-run the tunnel echo test:
node test/tunnel/echo.test.js
```

For changes to `vm/ctrl/modemd-ctrl.c` (the PTY ↔ control bridge),
the host-side `make` rule is enough — no in-VM build needed for the
native binary, and the i386 binary is just `gcc -m32` from the same
source:

```bash
cd vm/ctrl && make
cp modemd-ctrl-i386 ../prebuilt/modemd-ctrl-i386
make -C ..  # reassemble the rootfs
node test/ctrl/standalone.test.js  # native unit tests
```

### Sanity-building on the host

For quick "does this compile" checks without booting a VM, host
builds work. They won't run in the VM but they'll catch syntax
errors and simple bugs:

```bash
cd vm/tunnel
make
./modemd-tunnel --help    # (no --help yet; just verify it starts)
```

### Clearing the PJSIP build cache

If you change `vm/pjsip/config_site.h` or bump the PJSIP version,
remove the cache so the next build refreshes it:

```bash
rm -f /tmp/pjsipbuild/output/pjsip.install.tar
scripts/build-pjsip-in-vm.sh   # full 30-minute rebuild
```

---

## Debugging

### Tunnel not connecting at all

Check the TCP listener in Node is up before QEMU starts. QEMU's
`chardev=socket,server=off` will silently give up if there's no
listener at spawn time and you'll see `tunnel open: …: No such
device` in the guest. Order: start Node listener → spawn QEMU.

### Guest can't open `/dev/virtio-ports/synthmodem.tunnel`

Check:

1. **Virtio modules loaded?** `lsmod | grep virtio_console`. If the
   module isn't there, the dependency chain wasn't loaded in the
   right order. See `vm/overlay/etc/init.d/S99modem` for the known-
   good order — reuse it verbatim.
2. **`/sys/class/virtio-ports/vport*` populated?** Takes up to ~100ms
   after insmod. Our init scripts poll for up to 5 seconds.
3. **Symlink made?** `ls -la /dev/virtio-ports/`. Without udev/mdev
   the kernel won't create the nice symlinks; our init scripts do
   it manually by reading `/sys/class/virtio-ports/vport*/name`.
4. **QEMU gave the virtserialport a `name=`?** The device shows up
   at `/dev/virtio-ports/<name>` based on the `name=` parameter
   QEMU sets. Typo and it's a no-show.

### Tunnel connects but echo times out

Set `SYNTHMODEM_LOG_LEVEL=debug` on the VM side. In our synthesized
test init that's already done; for the eventual production
`S99modem-pjsip` you'll pass it via the kernel cmdline (see
backend A's pattern) or hardcode it.

Debug-level logs print per-frame rx/tx with channel, src, dst,
length. If you see frames going out but nothing coming back, the
VM-side tunnel isn't running or isn't reading from the chardev.
If you see frames coming in but nothing going out on echo, the
C-side echo logic has regressed (the code path is small; look at
`process_frame` → `CH_ECHO` branch).

### Framing errors

Both sides close the TCP connection on an oversize `length` field.
This means a byte got inserted or lost somewhere, which shouldn't
be possible on a loopback TCP socket but has happened when one side
was hitting the other with bytes before the TCP connection was
fully established. Always let the server accept the connection
first, then start writing.

### Short-read split logic

The parser handles frames split across reads. If you're testing a
new platform and frames seem to be arriving but not parsing, the
likely culprit is an endian mismatch (both our supported platforms
are LE so you shouldn't hit this), or the staged Buffer accumulator
is resetting incorrectly. Unit tests at `test/tunnel/framing.test.js`
already cover the byte-at-a-time case, so diverging from that test
is a red flag.

### PJSIP inside the VM: common gotchas

A few PJSIP-specific issues surfaced during step 3 that are worth
remembering for step 4+:

- **Loopback interface must be up.** A minimal busybox init doesn't
  bring up `lo` by default. Without it, `127.0.0.1` is unroutable
  and PJSIP's `sendto(127.0.0.1:*)` fails with `ENETUNREACH`.
  Backend A doesn't hit this because slmodemd uses socketpairs.
  Our S99modem-pjsip init (currently in the test's synthesized
  init; later in `vm/overlay-pjsip/etc/init.d/S99modem-pjsip`) does:
  `ip link set lo up` (with `ifconfig lo up` as fallback).

- **`--disable-sound` still allows pjsua_set_null_snd_dev().** PJSIP
  leaves the audiodev framework in place when sound is disabled at
  configure time; it just lacks real backends. Explicitly calling
  `pjsua_set_null_snd_dev()` is still the right move — it tells
  pjsua to use the null device and not probe for audio hardware.

- **Account without reg_uri means no registration.** `pjsua_acc_add`
  with `cfg.id = "sip:test-peer@127.0.0.1"` and `cfg.reg_uri` empty
  sets up the local identity (for `From:` in outbound requests)
  without attempting REGISTER. Perfect for a peer that's just the
  destination of direct-dial INVITEs.

- **SIP `Via` needs `;rport`.** Without it, PJSIP routes responses to
  the literal Via host:port, which inside the VM points at the
  host-side consumer's ephemeral port — which no one's listening on
  inside the VM, so the reply dies silently. With `;rport`, PJSIP
  routes to the observed UDP source (modemd-tunnel's ephemeral
  socket) which the tunnel then routes back to Node. Put `;rport`
  on every outbound SIP request.

- **Tunnel ≠ PJSIP for port binding.** PJSIP owns the well-known
  SIP/RTP/RTCP ports (5060/10000/10001). modemd-tunnel binds
  ephemeral sockets and targets PJSIP's ports via `sendto()`. Don't
  try to bind modemd-tunnel to 5060 — you'll collide with PJSIP and
  one or the other will fail. See PROTOCOL.md §"Port bindings" for
  the full asymmetric design.

---

## Testing

| Test                                        | Category      | Passing |
| :--                                         | :--           | :-:     |
| `test/tunnel/framing.test.js`               | unit          | 7/7     |
| `test/tunnel/echo.test.js`                  | integration   | 3/3     |
| `test/sip/uac-unit.test.js`                 | unit          | 6/6     |
| `test/rtp/bridge.test.js`                   | unit          | 4/4     |
| `test/ctrl/standalone.test.js`              | unit          | 7/7     |
| `test/pjsip/registrar.test.js`              | unit          | 6/6     |
| `test/session/b2bua.test.js`                | unit          | 5/5     |
| `test/pjsip/signaling.test.js`              | integration   | 3/3     |
| `test/pjsip/uac-invite.test.js`             | integration   | 2/2     |
| `test/pjsip/backend.test.js`                | integration   | 4/4     |
| `test/pjsip/pool.test.js`                   | integration   | 3/3     |
| `test/pjsip/ctrl.test.js`                   | integration   | 4/4     |
| `test/slmodem-pjsip/vm-smoke.test.js`       | rootfs smoke  | 3/3     |
| `test/slmodem-pjsip/at.test.js`             | integration   | 6/6     |

### `framing.test.js` — no VM

Unit tests for `UdpTcpTunnel`'s framing only. Handed a stub "socket"
that captures `write()` calls. Validates:

- Byte-exact layout of a SIP frame with payload.
- Zero-length payload still produces a correct 7-byte frame.
- `sendEcho()` API builds correctly.
- Parser handles two frames arriving in one `_onTcpData` call.
- Parser reassembles frames fed byte-at-a-time.
- Echo frames surface via `echo-reply`.
- Unknown channels drop silently (no `error` emitted).

### `echo.test.js` — with VM

Integration test that exercises the transport end-to-end:

1. Assembles a scratch initramfs on the fly (extract backend-A
   rootfs + drop in `modemd-tunnel` + synthesize an init script).
2. Starts a TCP listener on an ephemeral port.
3. Spawns `qemu-system-i386` with a chardev=socket pointing at that
   port, mapped as `/dev/virtio-ports/synthmodem.tunnel`.
4. Once QEMU connects, attaches the accepted socket to a freshly-
   constructed `UdpTcpTunnel` (skipping its `start()` path since
   UDP forwarding isn't being tested here; only channel 255 echo).
5. Sends echo frames and validates replies.

Scenarios:

- Single echo roundtrip (channel 255 swaps src/dst as expected).
- Five sequential echoes (validates no state carries between frames).
- One 4 KB payload (validates the parser under larger frames).

Takes ~20-30 seconds on TCG, dominated by kernel boot.

### `signaling.test.js` — step-3 integration

End-to-end SIP signaling test:

1. Scratch initramfs with `modemd-tunnel` + `pjsip-test-peer`
   (a minimal PJSIP UAS that auto-answers INVITEs). Init brings
   up loopback, loads virtio modules, creates the `/dev/virtio-
   ports/synthmodem.tunnel` symlink, starts modemd-tunnel in
   background, execs pjsip-test-peer in foreground.
2. Host-side: real `UdpTcpTunnel.start()` path with its UDP
   sockets on 5062/10002/10003 (this is the first test to
   exercise the UDP forwarding machinery, not just the TCP
   framing).
3. Node UDP socket on ephemeral port sends raw SIP bytes to
   127.0.0.1:5062. The tunnel frames them and delivers into
   the VM where PJSIP receives and processes them.
4. Readiness probe: OPTIONS messages with `;rport` sent every
   1.5s until pjsua replies with 200 OK. Handles the several
   seconds of pjsua startup without spinning.
5. Three test assertions: INVITE → 200 OK (with parseable SDP),
   ACK gets no error, BYE → 200 OK.

Takes ~15-20s after VM boot.

### `uac-unit.test.js` — step-4a, no VM

Exercises `SipUacInternal` against a loopback StubPeer. Runs in
milliseconds and catches SIP wire-format regressions fast. Six
scenarios:

- INVITE → 200 OK → ACK. Validates request headers (Via with
  `;rport`, From with tag, Content-Type, SDP body), confirms the
  ACK echoes the peer's to-tag, and checks that the returned
  promise resolves with parsed negotiated media info.
- INVITE rejected with 486 Busy Here. Confirms the ACK for non-2xx
  responses goes out, and the `invite()` promise rejects with a
  meaningful error.
- UAC-initiated hangup. INVITE first to get to CONFIRMED, then
  `hangup()` sends BYE with correct dialog tags and awaits 200.
- Peer-initiated BYE. Simulates the peer sending a BYE mid-call;
  UAC responds 200 and emits `ended` with `initiator: 'peer'`.
- INVITE timeout. No response from the stub; UAC retransmits a few
  times then times out cleanly.
- OPTIONS probe. `probe()` method for readiness-checking PJSIP
  during warm-up.

The StubPeer is a small helper in the test file: it receives UDP
messages, lets the test match them by predicate, and responds with
canned replies. Keeps the unit test hermetic — no VM, no tunnel.

### `uac-invite.test.js` — step-4a, with VM

The step-3 signaling test written with production code. Boots the
VM with modemd-tunnel + pjsip-test-peer, brings up a real
`UdpTcpTunnel`, and drives a full dialog through `SipUacInternal`:

- `probe()` loop until pjsua is ready.
- `invite()` — confirms CONFIRMED state and parsed negotiated
  media (remote RTP addr/port, PCMU codec).
- `hangup()` — confirms clean BYE/200 teardown.

This is the "step 3 bytes are now reusable code" proof. If
`uac-unit.test.js` catches a wire-format bug, this catches an
integration bug (different PJSIP version behavior, unexpected
PJSIP headers we don't handle, etc.).

### `bridge.test.js` — step-4b, no VM

Unit tests for `RtpBridge` using four loopback UDP sockets (ext-
peer, int-peer, and the two sockets the bridge owns). Validates:

- Explicit-peer mode: ext→int and int→ext both forward byte-
  identically; stats counters increment correctly.
- Peer learning: bridge created without an `extPeer`, first
  ext-side packet teaches it; int→ext packets before learning
  increment the drop counter and don't forward.
- `stop()` halts forwarding (packets sent after stop aren't
  observed by the opposite peer).
- 1200-byte payload round-trips byte-identically (RTP is typically
  ~160 bytes; this proves there's no size cap).

No VM needed; runs in ~200 ms.

### `backend.test.js` — step-4b, with VM

Full integration test for `PjsipBackend`. Boots the same scratch
initramfs as step 3/4a (modemd-tunnel + pjsip-test-peer), then:

1. `startAsync()` drives the backend through SPAWNING → TCP_WAIT →
   PROBING → READY.
2. `activate({extRtpSocket})` places the INVITE via the backend's
   internal `SipUacInternal`, gets the `connected` event with
   parsed negotiated media info (PCMU, remote RTP addr/port), and
   starts the `RtpBridge`.
3. Three small RTP-shaped packets sent from a fake caller socket
   through the bridge; verified via the bridge's `stats.extToInt.
   packets` counter incrementing by three.
4. `stop()` tears down cleanly: BYE/200, bridge stopped, VM killed.

Doesn't validate bidirectional audible RTP — pjsip-test-peer doesn't
emit RTP back on its own, so the int→ext direction has nothing to
exercise until step 5's real d-modem arrives.

### `pool.test.js` — step-4b, with VM

Proves `ModemBackendPool`'s factory extension point works for
backend B. Constructs a pool with `backendFactory: (o) => new
PjsipBackend(o)`, then:

- `start()` boots one backend (PjsipBackend), reaching pool-state
  `ready`.
- `checkout()` hands out the PjsipBackend instance; caller gets
  `mode === 'b2bua'` and the backend is in its READY state.
- `stop()` after manual `backend.stop()` tears down the pool
  cleanly.

Backend A's `test/slmodem/pool.test.js` remains 11/11 — the
factory abstraction doesn't regress the default SlmodemBackend
path.

### `vm-smoke.test.js` — rootfs-only

Updated for step 5b. Boots the backend-B rootfs standalone (no
PjsipBackend, no chardev wiring) and verifies the *real*
S99modem-pjsip init correctly detects that virtio-serial chardevs
are missing, prints its `virtio-serial devices not found`
diagnostic naming both chardev paths, and reports each as
`missing`. This proves:

  - Rootfs boots → busybox init → rcS → S99modem-pjsip.
  - The init's fail-closed check is actually reached (proof it
    did virtio-module insmod, symlink creation, the whole
    boilerplate).
  - Rootfs is built with the real init, not the old placeholder
    (regression guard).

No test of the full-stack boot here — that's `at.test.js`.

### `standalone.test.js` — step-5a, no VM

modemd-ctrl native binary unit test. Two Unix sockets stand in
for (a) the virtio-serial control chardev and (b) slmodemd's PTY.
modemd-ctrl's `open_host_path` handles both paths identically, so
this tests the full wire protocol without needing a VM. Covers:

  - HELLO emitted at startup with correct build-id format.
  - `AT` wire frame → CR-terminated bytes on PTY.
  - PTY bytes → `AT_RESPONSE` frame with matching payload.
  - `CONNECT …` in PTY tail flips to data mode; subsequent
    bytes surface as `DATA_RX`.
  - `DATA_TX` wire frame → bytes on PTY (only when data mode is
    active).
  - `NO CARRIER` in PTY tail exits data mode; subsequent bytes
    surface as `AT_RESPONSE` again.
  - SIGTERM → clean exit.

Runs in ~2s.

### `ctrl.test.js` — step-5a, with VM

Dual-chardev integration. Builds a scratch initramfs with
modemd-tunnel, modemd-ctrl, and pjsip-test-peer, boots it via
`PjsipBackend(enableControl:true)`. Verifies:

  - Both chardev TCP listeners accept connections from QEMU
    (PjsipBackend's `_tunnelServer` and `_controlServer`).
  - `PjsipBackend.controlSocket` is exposed to callers (public
    field, not destroyed).
  - modemd-ctrl inside the VM sends its HELLO, which arrives on
    `controlSocket` and parses as a `modemd-ctrl v1` announcement.
  - Step-4b flow alongside: `activate({extRtpSocket})` places
    the INVITE via `SipUacInternal`, RtpBridge forwards 3 test
    packets, `stop()` tears down cleanly.

Doesn't drive AT commands (that needs slmodemd in the loop —
covered by `at.test.js`).

### `registrar.test.js` — step-5c, no VM

Unit test for `VmRegistrar` with a stub tunnel. Verifies the
registrar's SIP logic in isolation, without needing QEMU or a real
d-modem. Stub tunnel is an EventEmitter that exposes
`injectFrame()` (collects outgoing responses for inspection) and
`feedInboundSip()` (simulates an inbound REGISTER frame arriving
on the tunnel's SIP channel).

Covers:

  - REGISTER with Contact → 200 OK + binding stored with correct
    host/port/contactUri/expires; `registered` event fires;
    response's Contact header echoes the received URI with the
    negotiated `expires` param; Via/From/To/Call-ID/CSeq copied
    per RFC 3261.
  - REGISTER with explicit `Expires` header takes precedence over
    the registrar's default.
  - Second REGISTER (same call-id would signal a refresh) fires
    `refreshed` event, not `registered`. Both are 200-OKed.
  - REGISTER with an updated Contact port updates the binding
    (covers the "PJSIP rebound its transport" case).
  - REGISTER without Contact → 400 Bad Request, no binding.
  - Non-REGISTER frames (e.g. a synthetic INVITE) are ignored —
    proves VmRegistrar coexists peacefully with SipUacInternal on
    the same tunnel, each processing only its own message types.

Runs in <1s.

### `b2bua.test.js` — step-5c.2, no VM

Unit test for the CallSession B2BUA branch (`this._mode ===
'b2bua'`). Uses stub pool, stub PjsipBackend-like backend, stub
SipServer, and stub SipDialog so the whole test runs in ~1s
without any QEMU boot. Verifies the audio-plane and lifecycle
wiring that CallSession relies on when
`config.modem.backend === 'slmodemd-pjsip'`:

  - **Constructor branch:** `_mode === 'b2bua'`, no `RtpSession`
    allocated (it's null), no AudioCapture wired.
  - **`setup()`:** allocates RTP port, binds a raw `dgram.Socket`
    on it (not an RtpSession), calls `sipServer.answerCall` with
    the port. No codec configuration — B2BUA mode skips it
    because PJSIP in the VM handles PCMU/PCMA end-to-end.
  - **`activate()`:** checks out a backend from the pool, calls
    `backend.activate({extRtpSocket, extPeer})` with the exact
    raw socket and the dialog's remote RTP endpoint as extPeer.
    When the dialog has no remote RTP endpoint yet, extPeer is
    `undefined` (the bridge will learn it from the first ext
    packet).
  - **`hangup()`:** recycles the backend through the pool
    (pool.recycle with the same backend instance), sends BYE via
    the SIP server, closes the raw socket, releases the RTP port,
    clears `_rtpPort`/`_rtpSock` fields, emits `'ended'` with the
    supplied reason. The port is verified re-allocatable
    afterward.

The test also surfaces a subtle design detail of hangup(): when
the teardown chain has no real awaited I/O (stub backends make
this the common case), the `'ended'` event can fire synchronously
within `hangup()` before the call returns. Callers that want to
await `'ended'` must attach the listener BEFORE calling
`hangup()`. This is documented in the `hangup()` doc comment.

Runs in ~1s.

### `at.test.js` — step-5b + 5c, with production rootfs

Headline proof for steps 5b and 5c. Boots the production backend-B
rootfs (real S99modem-pjsip starting slmodemd + d-modem +
modemd-tunnel + modemd-ctrl) via `PjsipBackend(enableControl:true,
useRegistrar:true)`. The `useRegistrar` option (added in 5c) gates
READY on d-modem's REGISTER round-trip, replacing the 5b-era
`skipReadinessProbe` workaround. Covers:

  - `startAsync()` reaches READY only after d-modem has registered.
    The real production stack is alive: slmodemd + d-modem (with
    all 11 PJSIP media optimizations in effect) + modemd-tunnel +
    modemd-ctrl.
  - VmRegistrar recorded a binding with an ephemeral loopback
    port (NOT 5060, NOT 5090). `backend.targetUri` was rewritten
    from the test-peer default to the learned Contact URI.
  - modemd-ctrl emits HELLO on the control channel — proves
    slmodemd created `/tmp/ttySL0` and modemd-ctrl opened it
    (the re-stat-per-retry logic in `open_host_path` handled
    the slmodemd-startup race).
  - `ATE0` wire frame → `OK` in `AT_RESPONSE` frames. Full
    Node → ctrl chardev → modemd-ctrl → PTY → slmodemd → PTY
    → modemd-ctrl → ctrl chardev → Node round trip.
  - `ATI` wire frame → identification string + `OK`. Proves
    multi-command sessions work.
  - `stop()` tears down cleanly.

Duration: ~30-45s under TCG (kernel boot + slmodemd startup +
PJSIP init + REGISTER roundtrip + modemd-ctrl PTY open +
AT round-trips).

### What's not tested yet

- **Full CallSession + PjsipBackend integration against real
  d-modem** (INVITE → ACK → RTP flow → CONNECT → TelnetProxy
  attach). Separately, the pieces work: `b2bua.test.js` proves
  the CallSession branch with stubs, `backend.test.js` proves
  PjsipBackend's INVITE against pjsip-test-peer, and `at.test.js`
  proves d-modem actually boots + registers. What's missing is a
  single test that chains them into a real INVITE to d-modem and
  observes the CONNECT. Partly blocked on needing something to
  drive the modem handshake from the caller side; backend A's
  test harness uses `native` answering `native`, which isn't
  applicable here.
- **Actual modem handshake over a phone line.** Needs hardware;
  that's step 6. None of the software tests in this tree can
  prove handshake reliability.
- **REGISTER refresh over long durations.** VmRegistrar accepts
  refreshes (verified by unit test), and PjsipBackend doesn't
  tear down on refresh (because PjsipBackend treats the original
  `registered` event as the readiness gate, not refreshes). But
  we haven't empirically verified what happens over many refresh
  cycles or if Node is temporarily unresponsive during one.
- **Concurrent dialogs.** We only test one call at a time. The
  tunnel protocol doesn't support multiple simultaneous dialogs
  per tunnel (fixed ports, single learned peer), by design. The
  pool's one-VM-per-call model sidesteps this.
- **Loss / reordering / large-burst behavior of RTP-like traffic.**
  Deferred until we have a concrete regression to care about.

---

## Licensing notes

- `d-modem.c` is **GPL-2.0-or-later**, Copyright (C) 2021 Aon plc.
  See `licenses/D-MODEM-NOTICE`. The `vm/d-modem/UPSTREAM.txt` file
  pins the upstream commit we took it from, and the source is
  byte-identical to that commit.
- **PJSIP 2.15.1** is dual-licensed GPL / commercial; we use it
  under GPLv2. The full source tarball is vendored at
  `vm/sources/pjproject-2.15.1.tar.gz`; its SHA256 is pinned and
  fetched from `https://github.com/pjsip/pjproject/archive/...`.
  See `licenses/PJSIP-NOTICE`.
- `vm/tunnel/modemd-tunnel.c` and `src/tunnel/UdpTcpTunnel.js` are
  new synthmodem code, GPL-2.0-or-later.

The PJSIP build is deliberately stripped to only what d-modem.c
actually uses; see the `--disable-*` list in
`scripts/build-pjsip-in-vm.sh` and the reasoning in
`vm/prebuilt/PROVENANCE.txt`.
