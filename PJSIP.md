# SynthModem — In-VM PJSIP Integration (Option B, B2BUA)

This document sketches a path to replace our hand-rolled shim↔slmodemd
audio interface with the D-Modem reference implementation, running
inside our existing VM. The goal is to inherit D-Modem's proven
reliability (days-long modem stability, per their README) without
exposing the VM to external SIP traffic.

## The idea in one paragraph

Node continues to terminate external SIP calls exactly as it does
today. For the slmodemd backend only, Node additionally acts as a
B2BUA (back-to-back user agent) that establishes a second, internal
SIP call leg to a PJSIP instance running inside the VM. PJSIP inside
the VM then drives slmodemd via D-Modem's unchanged `d-modem.c`.
All traffic between Node and the VM (both SIP signaling and RTP media)
travels over a UDP-over-TCP tunnel on our existing QEMU TCP transport
— no new host networking, no external exposure of the VM. Node's
existing SIP stack, SipDialog machinery, and CallSession design stay
intact. The only thing that changes for a call routed to this backend
is that instead of decoding RTP and feeding PCM to a shim, Node bridges
its external leg to an internal SIP leg whose remote end is PJSIP in
the VM.

## Why this is worth the effort

- **Inherits D-Modem's audio path wholesale.** PJSIP's software clock,
  jitter buffer, and `dmodem_put_frame` pacing — all proven, all
  unchanged. No more attempting to reinvent PJSIP's cadence behavior
  in a C shim and regressing handshake while doing it.
- **No changes to slmodemd.** Already byte-identical to D-Modem's.
- **No changes to Node's external SIP stack.** External callers still
  talk to `192.168.1.148:5060` exactly as today.
- **VM stays isolated.** No external network exposure. All internal
  SIP is on the host↔VM TCP tunnel. Addresses the concerns we
  documented for the previous SIP-in-VM idea.
- **Parallel to existing backend.** The current shim-based slmodemd
  backend can stay in the tree until the PJSIP-based one is proven.
  No big-bang migration.
- **Scales to V.34 and V.90.** The V.32bis instability we're fighting
  at 4800 bps will almost certainly be present (worse) at 33600 bps.
  Fixing the audio path properly is a prerequisite for the high
  speeds that are the real prize.

## Architecture at a glance

```
External caller                       Node (host)                         VM
───────────────                       ───────────                         ──

 SIP UDP 5060 ─────► SipServer ─► CallSession ─► SipUacInternal ─┐
                        │                           │            │
                        │                           ├──► SIP      │
                        │                           │   tunnel    │
                        │                           │   TCP ─────┐│
                        │                           │            ││
                        ├──► RtpSession ────────────┤            ▼▼
                        │                           │           UDP tunnel
                        │                           ├──► RTP      shim (in VM)
                        │                           │   tunnel    │
                        │                           │   TCP ─────►│
                        │                                          │
                        │                                          ▼
                        │                                         PJSIP
                        │                                          │
                        │                                          ▼
                        │                                      d-modem.c
                        │                                          │
                        │                                          ▼
                        │                                      socketpair
                        │                                          │
                        │                                          ▼
                        │                                       slmodemd
                        │                                          │
                        │                                          ▼
                        └◄──── DATA bytes ◄──── PTY ◄──────────────┘
                                                             (existing shim
                                                              handles PTY +
                                                              DATA channel as
                                                              it does today)
```

Two new things:
1. **SipUacInternal** on the Node side — a lightweight SIP client
   that places and tears down the internal leg against the VM.
2. **UDP-over-TCP tunnels** between host and VM — one logical channel
   for SIP signaling, one for RTP media. Framed bytes over the
   existing QEMU TCP transport. The shim in the VM unframes them
   into local UDP datagrams that PJSIP consumes as if they arrived
   over a normal UDP socket.

The PTY side and DATA channel between slmodemd and Node are
unchanged. Everything post-CONNECT (DATA_RX → TelnetProxy) works
exactly as today, because the DSP is finally getting clean audio
input.

## What each layer does

### Node side

- **SipServer** — no changes. Still terminates external SIP exactly
  as today.
- **CallSession** — modified slightly. When the chosen backend is
  `slmodemd-pjsip` (new), instead of decoding RTP and feeding samples
  to a shim, it:
  - Spins up a SipUacInternal to place a call into the VM
  - Bridges the external RTP leg to the internal RTP tunnel
  - Waits for the internal leg to reach media-active state
  - Hands off to TelnetProxy once the DATA channel signals CONNECT
- **SipUacInternal** — new, small. A minimal UAC that issues
  INVITE/ACK/BYE against the in-VM PJSIP. Probably 200-400 lines.
  Doesn't need to be a full SIP stack — just enough to drive one
  internal call.
- **Tunnel** — new, small. Two TCP streams (or one multiplexed),
  framed with `u16 length | payload` encoding UDP datagrams.
  Bidirectional. Probably 150 lines of Node and 150 lines of C.

### VM side

- **Tunnel shim** — new. Unframes TCP bytes back to UDP datagrams
  and sends them to PJSIP via a local UDP socket (localhost). Sends
  PJSIP's outbound UDP back over the TCP tunnel. Effectively a
  UDP↔TCP bridge per channel. Could be absorbed into the existing
  shim, or a new small helper.
- **PJSIP** — the D-Modem fork, built into the VM image. Uses
  D-Modem's exact configuration (software clock, 40-packet fixed
  jitter buffer, etc.). Configured to bind to the loopback UDP
  endpoints that the tunnel shim exposes.
- **d-modem.c** — unchanged from D-Modem upstream. It's the PJSIP
  media port that bridges to slmodemd's socketpair.
- **slmodemd** — unchanged. Same binary we ship today.

### What goes away

- The current shim's **audio-forwarding path** (`handle_host_audio_readable`
  writing PCM to the socketpair). PJSIP now drives the socketpair
  directly via d-modem.c.
- The current shim's **pump_start/pump_stop/pump_active** lifecycle
  (failed anyway).
- The current shim's **ATA / NO CARRIER / HANGUP triggers**.
- Node's **RTP decode-for-DSP path** for the slmodemd backend.
  Decode still happens for TX audio capture (if enabled) but PJSIP
  handles the modem-facing side.

### What stays

- The shim's **PTY channel handling** — AT command forwarding,
  DATA_RX framing, dump request handling. All of this is unrelated
  to audio cadence and works.
- The shim's **HELLO+telemetry** control path.
- The entire native backend (unchanged).
- CallSession, TelnetProxy, pool, warm-VM checkout model.
- `vm/slmodemd/` (byte-identical to D-Modem).

## Topology choice: B2BUA, not proxy

Two ways to route the external call into the VM:

1. **Proxy**: Node forwards the external INVITE verbatim to PJSIP,
   passes 200 OK back verbatim. Fewer SIP messages total.
2. **B2BUA**: Node terminates the external call, creates a separate
   internal call to PJSIP. Two distinct SIP dialogs.

**We pick B2BUA.** Reasons:

- External caller's SDP (IP, port, codec list) is THEIR network
  configuration. Forwarding it verbatim means PJSIP in the VM tries
  to send RTP to that external address, which it can't reach from
  inside the VM. Proxy would require SDP rewriting — and once we're
  rewriting, we're already doing most of B2BUA's work.
- B2BUA keeps CallSession's existing design intact: one CallSession
  per external call, owns the external SipDialog, owns an optional
  internal SipDialog. Symmetric.
- B2BUA means Node gets to choose the codec for the internal leg
  independently. We want PCMU at 8kHz matching slmodemd's expectation;
  external leg might be whatever the caller offered.
- Tunneled RTP endpoints are predictable and Node-controlled, not
  dependent on external SDP.
- Cleaner teardown — either leg can BYE independently and we handle
  it in CallSession.

## The tunnel

One TCP stream between Node and VM for all tunneled UDP traffic.
Framing:

```
u16 length (LE)   covers everything after this field
u8  channel       0 = SIP, 1 = RTP, 2 = RTCP (future)
u16 src_port      UDP source port on sender side (informational)
u16 dst_port      UDP dest port on receiver side
u8  payload[]
```

Not unlike our existing wire protocol, just purpose-built for
datagram transport. A separate TCP connection from the audio+control
streams we already have — keeps audio latency path isolated and
makes fault isolation easier.

On the VM side, the tunnel shim:
- Binds local UDP sockets for PJSIP to talk to (e.g. `127.0.0.1:5060`
  for SIP, `127.0.0.1:10000` for RTP)
- Reads frames off the TCP tunnel, delivers payload to the local
  UDP socket as a sendto() to PJSIP
- Reads UDP from PJSIP, wraps into frames, writes to TCP tunnel

PJSIP thinks it's talking to a perfectly normal SIP peer on
localhost.

On the Node side, the tunnel symmetric:
- Exposes SIP and RTP endpoints that CallSession writes UDP packets
  to
- Reads those, frames them, writes to TCP tunnel
- Reads TCP tunnel, delivers payload back to CallSession as UDP

Or, more concretely, CallSession's internal-leg SIP and RTP just
use normal `dgram.createSocket('udp4')` sockets bound to a host-side
localhost port that the tunnel listens on. Same for RTCP. Full
duplex.

## Lifecycle of one call

```
Time    External leg             Internal leg / VM
────    ────────────             ─────────────────
t=0     INVITE → SipServer
t=0     CallSession.setup()
t=0     200 OK → external
t=1ms   ACK from external
        ─────────────────────►   Checkout VM from pool
                                 (already warm with PJSIP + slmodemd)
t=5ms   SipUacInternal.invite()
                                 ─► tunnel UDP:5060
                                 ─► PJSIP receives INVITE
                                 ─► PJSIP emits 200 OK
t=10ms  Receives 200 OK from VM ◄
t=10ms  ACKs VM
                                 ─► PJSIP fires on_call_media_state
                                 ─► PJSIP ports bridged to d-modem.c
                                 ─► "Kicking off audio!" silence frame
                                 ─► PJSIP starts 20ms put_frame cadence
t=15ms  Bridge external RTP ◄───► tunnel RTP ◄───► PJSIP RTP
                                 (real audio now flows end-to-end
                                  at proper cadence)
t=20ms  Internal PJSIP wants slmodemd to answer — how?
```

Here's where the existing AT interface matters. slmodemd's modem
still needs ATA sent to its PTY. In D-Modem, this happens because
someone on the serial-console end typed ATA (or configured auto-
answer via ATS0). We can:

- **Configure slmodemd for auto-answer** inside the VM. `ATS0=1` in
  its init config. The PTY is still present, handled by our existing
  shim logic. slmodemd auto-answers on ring, no need for Node to
  forward an ATA. Simple and matches D-Modem's typical daemon
  deployment.
- Alternatively, Node's SlmodemBackend still sends `ATA` via the
  existing control channel. PJSIP and the AT command are
  independent; AT travels the control TCP stream (PTY) as today.

The first option is likely cleaner. D-Modem documentation suggests
slmodemd in daemon mode.

After CONNECT, the DATA side continues exactly as today:
- slmodemd emits data bytes on PTY
- Shim reads PTY, wraps as `WIRE_TYPE_DATA_RX`, forwards on control
  TCP
- Node's SlmodemBackend receives DATA_RX, emits 'data' event
- CallSession's TelnetProxy handles the data

The DATA path is untouched by this redesign.

## Build impact

### New binaries to produce and ship

- **PJSIP (pjsua)** built for the VM's glibc (Debian bookworm 2.36).
  D-Modem bundles `pjproject-2.15.1/` with their fork, so we have a
  known-good source tree. First-time build takes maybe 30-60 minutes
  for a full PJSIP. Configure with minimal features (no video, no
  crypto we don't need) to keep size down.
- **tunnel helper** inside the VM. Small C program, ~200-400 lines.
  Could live in `vm/shim/` alongside modemd-shim or as a separate
  binary. Either way, links against the same minimal libc.

### VM image growth

Currently ~3.3 MB compressed rootfs. PJSIP built minimally adds
maybe 5-8 MB. New rootfs ~10 MB. Still fast to boot, still fits
comfortably in VM RAM.

### Build script changes

`scripts/build-slmodemd-in-vm.sh` becomes `scripts/build-vm-binaries.sh`
and also builds PJSIP + the tunnel helper. Additional .deb
dependencies in the build initramfs: autoconf, libtool, some others
PJSIP's configure wants. Probably another ~50-100 MB of cached .debs.

### Init scripts

`vm/overlay/etc/init.d/S99modem` starts slmodemd as today. A new
`S98pjsip` (or fold into S99) starts PJSIP configured against the
tunnel's local UDP endpoints, with `SIP_LOGIN` pointing at Node's
internal SIP endpoint. Auto-answer for slmodemd (`ATS0=1`) goes
into slmodemd's init AT string.

## Risk register

### First-time build complexity
PJSIP's configure/make has a lot of knobs. Might take some iteration
to get a minimal build that works. Mitigated by: D-Modem's Makefile
already does this, we copy their config.

### Build time
Every rebuild of a VM image will pull in PJSIP compilation if it
changed. Mitigated by: PJSIP rarely changes, we pin a version, and
the in-VM build can cache object files. We check in the built
binaries anyway (same model as current `vm/prebuilt/slmodemd`).

### Tunnel performance
Unknown until measured. Worst-case: loopback TCP adds 1-2 ms
round-trip latency; jitter is negligible; throughput is abundant.
PJSIP's jitter buffer absorbs whatever small timing variation
exists. No reason to expect problems but we'll measure.

### SDP asymmetry
Caller offers a codec list; PJSIP in the VM offers one. B2BUA
translates between them. If caller offers only obscure codecs,
we're stuck. Mitigation: require PCMU/PCMA on the external leg
(we already do).

### Internal-leg stability
New moving part. SIP messages over a TCP tunnel to PJSIP. Edge
cases: tunnel drops mid-call (handle as if remote hung up), PJSIP
crashes and restarts (kill VM, return a new one from pool),
internal INVITE timeout (retry or fail the external call). All
handlable, needs testing.

### Pool recycling
Currently we discard the VM after each call (slmodemd state is
sticky). PJSIP also keeps per-call state. Probably best to continue
the "one VM per call, discard after" pattern. Warm pool pre-boots
the next one.

### D-Modem's PJSIP version vs upstream
They pin 2.15.1. We stay with that. Upstream PJSIP may be further
along but we want the known-good one.

## What this would replace vs what it would add

**Replaces**:
- The audio side of `vm/shim/modemd-shim.c` (`handle_host_audio_readable`,
  `handle_slm_audio_readable`, plus all the pump/gating logic that
  failed)
- Node's `SlmodemBackend` PCM-forwarding path (keep the backend API,
  swap the internals)

**Adds**:
- `src/sip/SipUacInternal.js` — ~300 LOC
- `src/tunnel/UdpTcpTunnel.js` — ~200 LOC
- `vm/tunnel/` — new C helper, ~300 LOC
- PJSIP in the VM (~5-8 MB binary, no source in our repo since we
  ship D-Modem's bundle separately)
- Init script updates
- `vm/prebuilt/pjsip` alongside existing binaries

**Keeps untouched**:
- All external SIP handling (SipServer, SipDialog, SipParser)
- RtpSession's external-side behavior
- CallSession's state-machine shape
- TelnetProxy
- pool model
- ModemBackendPool
- Native backend
- slmodemd source
- Shim's control/DATA handling (PTY side)

## Suggested incremental plan

1. **Verify D-Modem's PJSIP source builds** in our in-VM build
   system. Just produce a binary, don't wire it up yet. Prove
   feasibility.
2. **Build and ship the tunnel helper** end-to-end with nothing
   behind it. Send a UDP echo through it, confirm latency and
   framing.
3. **Run PJSIP in the VM** with a trivial test peer (not slmodemd
   yet). Confirm SIP registration and a test call work over the
   tunnel.
4. **Write SipUacInternal** and bridge one trivial test call
   (Node ←→ tunnel ←→ PJSIP) with audio looped back by PJSIP itself.
   No slmodemd yet.
5. **Wire PJSIP to d-modem.c** in the VM. Confirm a full external
   call reaches slmodemd's PTY and AT commands work.
6. **Test handshake**. Expect 100% reliability matching D-Modem.
7. **Test sustained data mode**. Expect D-Modem-level stability.
8. **Measure against baseline** on V.32bis at 4800, 9600. Then
   enable V.34 and V.90, which is the real win.

Each step is independently testable in the sandbox before committing
to the next. Total estimated effort: 1-2 weeks of focused work,
most of which is the PJSIP build and SIP UAC implementation. The
audio path change itself is the easy part.

## Bottom line

We stop trying to replicate PJSIP's behavior in our shim. We stop
regressing handshake every time we try to fix data-mode. We ship
PJSIP itself, the same one D-Modem uses, and let it do what it was
built to do. Node retains full external SIP control and its
deployment model is unchanged from the operator's perspective.

The audio stability problem disappears because we're no longer in
the audio path at all — we're in the SIP and RTP signaling path,
where Node belongs.
