# slmodemd-pjsip backend — implementation progress

> **HISTORICAL LOG.** This was the working roadmap kept during the
> implementation of the `slmodemd-pjsip` backend, with one entry
> committed at the end of each session. The backend reached
> completion (V.34 over real PSTN, end-to-end BBS interaction) and
> was the only shipping VM-backed backend after cleanup-phase-1
> removed the host-paced alternative. This log is preserved for
> context — it's a useful narrative of what was tried and learned —
> but is **not a current task list**.
>
> For the current implementation manual, see `slmodemd-pjsip.md`.
> For the per-binary status, see `vm/prebuilt/README.md`. For the
> top-level project state, see `README.md` and `Handoff.md`
> Section 0.

---

Working roadmap for backend B. Each milestone is intended to land as a
self-contained, testable piece. Updated at the end of each session.

## Completed

- **Step 0 — Scaffolding and licensing.** Vendored `d-modem.c` (from
  synexo/D-Modem), pinned PJSIP 2.15.1 upstream tarball in
  `vm/sources/`, added license notices, updated `COPYING` and
  `vm/sources/README.md`, added `scripts/fetch-vm-sources.sh` support
  for non-Debian upstream sources. Added `vm/d-modem/`, `vm/pjsip/`,
  `vm/overlay-pjsip/` directory scaffolding with UPSTREAM.txt pins
  and in-tree build customization.

- **Step 1 — Build pipeline feasibility.** `scripts/build-pjsip-in-vm.sh`
  builds PJSIP 2.15.1 + d-modem statically inside the bookworm build
  VM. PJSIP configured with the lean set of `--disable-*` flags that
  skip everything modem use doesn't need (no video, sound, SSL, codecs
  other than G.711, etc.). Output `vm/prebuilt/d-modem` is a 1.7 MB
  PIE ELF32, glibc 2.34 max, no `__isoc23_` symbols. `pjsip.install.tar`
  is cached on the 9p output share so subsequent d-modem-only
  iterations run in ~30 seconds instead of ~30 minutes.

  `vm/Makefile` has a parallel `rootfs-pjsip` target that assembles
  `vm/images/rootfs-slmodemd-pjsip.cpio.gz` from slmodemd + d-modem +
  overlay-pjsip/.

  `test/slmodem-pjsip/vm-smoke.test.js` boots the backend-B rootfs
  and confirms the placeholder `S99modem-pjsip` init script runs and
  lists both binaries. Passes 3/3.

- **Step 2 — Tunnel helper (host ↔ VM UDP-over-TCP bridge).**
  Delivered. Wire protocol specified in `vm/tunnel/PROTOCOL.md`.
  VM-side C implementation at `vm/tunnel/modemd-tunnel.c` (~400 LOC,
  poll-based, handles partial reads, atomic UDP sends, PJSIP-friendly
  port model where modemd-tunnel binds an ephemeral socket and
  delivers to PJSIP's well-known port). Node-side at
  `src/tunnel/UdpTcpTunnel.js` with symmetric framing and an echo
  API. `scripts/build-pjsip-in-vm.sh` builds it alongside d-modem
  into `vm/prebuilt/modemd-tunnel-i386` (20 KB PIE ELF32).

  Tests: `test/tunnel/framing.test.js` (7/7 byte-level unit tests)
  and `test/tunnel/echo.test.js` (3/3 integrated roundtrip through
  a real VM, including 4 KB payloads).

- **Step 3 — PJSIP in VM with a trivial test peer.** Delivered. A
  minimal PJSIP UAS `vm/pjsip-test-peer/pjsip-test-peer.c` (~200
  LOC, derived from simple_pjsua.c) auto-answers INVITEs and runs
  until SIGTERM. Binds 127.0.0.1:5060 UDP, no sound device, no
  registrar. Built to `vm/prebuilt/pjsip-test-peer-i386`.

  `test/pjsip/signaling.test.js` assembles a scratch initramfs with
  modemd-tunnel + pjsip-test-peer, boots QEMU, uses
  `UdpTcpTunnel.start()` (real UDP binding path, not the TCP-only
  bypass the step-2 test used), and drives a full
  `INVITE → 100/200 → ACK → BYE → 200` dialog end-to-end through
  the tunnel. 3/3 passing.

  Bugs caught and fixed during step 3:
    - **Tunnel port collision.** The original modemd-tunnel bound
      the same ports PJSIP binds (5060, 10000, ...). They can't
      coexist. Fix: modemd-tunnel now binds ephemeral ports and
      targets PJSIP's fixed ports via `sendto()`. Documented in
      PROTOCOL.md as asymmetric binding.
    - **Loopback interface down.** The minimal busybox init didn't
      bring up `lo`, so `127.0.0.1` was unroutable. The test's
      init script now does `ip link set lo up` (with `ifconfig` as
      fallback).
    - **rport in Via.** Without `rport`, PJSIP sends replies to the
      literal Via host:port (the host-side client's ephemeral port,
      which isn't bound inside the VM). With `;rport`, PJSIP replies
      to the observed source (modemd-tunnel's ephemeral port) and
      the tunnel's UDP-peer-learning path carries the reply back
      to the right Node consumer. Test's INVITE/OPTIONS/BYE now all
      include `;rport`.

- **Step 4a — SipUacInternal (Node-side SIP UAC).** Delivered.
  `src/sip/SipUacInternal.js` (~600 LOC) implements INVITE with SDP
  offer, 1xx/2xx/non-2xx handling, both ACK variants (2xx-ACK is a
  new transaction, non-2xx ACK reuses the INVITE transaction), BYE
  in both directions, OPTIONS probe for readiness, per-request
  retransmits with T1 back-off, overall timeouts, and the UAC state
  machine (INIT → TRYING → EARLY → CONFIRMED → TERMINATED). All
  requests include `;rport`.

  Transport is a plain dgram.Socket (caller-owned) with
  peerAddress/peerPort — decoupled from UdpTcpTunnel, which makes
  unit testing hermetic (StubPeer on loopback).

  Tests:
    - `test/sip/uac-unit.test.js` — 6/6: INVITE/200/ACK wire format,
      486 non-2xx + ACK, UAC BYE, peer BYE → ended event, timeout,
      OPTIONS probe.
    - `test/pjsip/uac-invite.test.js` — 2/2: the full dialog through
      real pjsip-test-peer in VM.

  Bug caught during step 4a: `sip.generateBranch()` already prefixes
  `z9hG4bK-`; my first draft added another, producing
  `z9hG4bKz9hG4bK-XYZ` on the wire. Our matcher stored the un-doubled
  branch and dropped every response as unmatched. Fixed by removing
  the duplicate prefix.

- **Step 4b — RTP bridge + PjsipBackend + pool factory.** Delivered
  (partially — CallSession B2BUA wiring deferred to step 5c, see below).

  1. **`src/rtp/RtpBridge.js` (~170 LOC).** A stateless RTP packet
     pump between two UDP sockets. No decoding, no jitter buffering,
     no SSRC rewriting: packets arrive on one socket and go out the
     other with their headers and timing preserved, which is
     exactly what the PJSIP-in-VM side wants. Unit-tested in
     `test/rtp/bridge.test.js` (4/4 passing).

  2. **`src/backends/PjsipBackend.js` (~400 LOC, grew to ~500 in 5a).**
     Orchestrates the VM + UdpTcpTunnel + SipUacInternal + RtpBridge
     for backend B. Mirrors SlmodemBackend's lifecycle shape
     (`start`, `startAsync`, `activate`, `stop`, events
     `connected`/`silenceHangup`/`error`) but exposes
     `mode === 'b2bua'` so callers know the media plane is handled
     internally and `receiveAudio`/`audioOut` should NOT be wired.
     `activate({extRtpSocket, extPeer})` places an INVITE, bridges
     RTP, fires `connected` with negotiated media info.
     Integration-tested in `test/pjsip/backend.test.js` (4/4): VM
     boot, INVITE+media, RTP packets flowing through the bridge,
     clean teardown.

  3. **`ModemBackendPool` factory abstraction.** Pool now accepts an
     optional `backendFactory(opts) => backend` — defaults to
     `new SlmodemBackend(opts)` with a lazy require, so backend A's
     existing callers are unaffected. Backend B callers pass
     `(opts) => new PjsipBackend(opts)`. Integration-tested in
     `test/pjsip/pool.test.js` (3/3) — proves pool warmup,
     checkout, and stop work for PjsipBackend through the factory.
     Backend A's `test/slmodem/pool.test.js` still passes 11/11.

  **Deferred to step 5c:** CallSession B2BUA wiring. The interface
  is ready (`backend.mode === 'b2bua'`), the pool is ready (factory
  pattern), the backend is ready (`PjsipBackend`), but CallSession
  still only knows the 'pcm' path. Step 5c adds the 'b2bua' branch.

- **Step 5a — modemd-ctrl + dual-chardev PjsipBackend.** Delivered.

  1. **`vm/ctrl/modemd-ctrl.c` (~550 LOC).** PTY ↔ control-wire
     bridge for backend B. Trimmed from modemd-shim — strips audio,
     keeps the control-channel path (HELLO, AT/AT_RESPONSE,
     DATA_TX/DATA_RX, HANGUP), data-mode state machine driven by
     `CONNECT` / `NO CARRIER` in the PTY tail. No argv at all; all
     config via env (`SYNTHMODEM_CONTROL_PATH`, `SYNTHMODEM_PTY_PATH`,
     `SYNTHMODEM_BUILD_ID`, `SYNTHMODEM_LOG_LEVEL`). `open_host_path`
     handles both virtio-serial char devices AND unix sockets — same
     mechanism modemd-shim uses, refactored to re-stat per retry so
     slmodemd's lazy-creation-of-PTY race is handled cleanly.

  2. **`scripts/build-pjsip-in-vm.sh` extended** to build
     modemd-ctrl alongside the other binaries. Produced binary
     `vm/prebuilt/modemd-ctrl-i386` (20336 bytes, ELF i386 PIE,
     glibc 2.34 max, no `__isoc23_`).

  3. **`PjsipBackend` dual-chardev support.** New `enableControl`
     option spawns QEMU with both `synthmodem.tunnel` and
     `synthmodem.control` chardevs, exposes `this.controlSocket`
     for step-5b/5c callers. Refactored listener setup into
     generic `_startChardevListener()`; spawn takes
     `{tunnelPort, controlPort}`. Also added `skipReadinessProbe`
     option for step-5b tests that boot against real d-modem
     (whose PJSIP binds ephemeral — port discovery is step 5c).

  4. **`test/ctrl/standalone.test.js` (7/7)** — native modemd-ctrl
     driven through Unix sockets for both the control chardev and
     the PTY stand-in. Covers HELLO, AT → CR-PTY, PTY → AT_RESPONSE,
     CONNECT → data-mode, DATA_TX/DATA_RX, NO CARRIER → exit
     data-mode, SIGTERM cleanup.

  5. **`test/pjsip/ctrl.test.js` (4/4)** — full VM integration.
     Boots the VM with both chardevs wired, verifies modemd-ctrl
     connects and emits HELLO inside the VM, proves step-4b's
     INVITE+RTP flow still works alongside, clean teardown.

- **Step 5b — Real `S99modem-pjsip` + AT smoke test.** Delivered.

  1. **`vm/overlay-pjsip/etc/init.d/S99modem-pjsip`** — replaced
     the placeholder with a real init. Mounts proc/sys/dev, brings
     up lo, loads virtio modules, populates `/dev/virtio-ports/`,
     starts modemd-tunnel in the background, starts modemd-ctrl in
     the background (as uid 100 to match slmodemd's PTY ownership
     — the devpts slave inherits uid from whoever opens /dev/ptmx,
     so running modemd-ctrl as the same user avoids EACCES on
     stat(/tmp/ttySL0)), then exec-su's into slmodemd with
     `-e /usr/local/bin/d-modem`.

  2. **`vm/Makefile`** — added `PREBUILT_TUNNEL`/`TUNNEL_BIN` and
     `PREBUILT_CTRL`/`CTRL_BIN` variables, added both to the
     `rootfs-pjsip` target's prereqs (so the rootfs rebuilds when
     helpers are rebuilt), installs them into `/usr/local/bin/`
     alongside slmodemd and d-modem. `rootfs-pjsip` errors with
     a clear pointer to `scripts/build-pjsip-in-vm.sh` if any of
     the three prebuilts are missing.

  3. **`test/slmodem-pjsip/vm-smoke.test.js` (3/3)** — updated to
     match the real init (standalone boot without chardev wiring
     correctly detects missing chardevs and refuses to launch
     slmodemd, which is the right behavior; the test asserts
     that diagnostic appears for both chardev paths).

  4. **`test/slmodem-pjsip/at.test.js` (5/5)** — step 5b's
     headline test. Boots the production rootfs via
     `PjsipBackend(enableControl:true, skipReadinessProbe:true)`.
     Waits for modemd-ctrl HELLO (proves slmodemd started, PTY
     created, ctrl opened the PTY). Sends `ATE0`, verifies `OK`
     in the response. Sends `ATI`, verifies identification string
     + `OK`. Clean teardown. Full end-to-end proof that the
     control-channel path is alive with the real modem stack.

  **Discoveries:**
   - d-modem.c hard-codes `cfg.port = 0` for its PJSIP UDP
     transport — binds ephemeral. We can't OPTIONS at a fixed
     URI in the readiness probe. Two options considered: modify
     d-modem.c to accept a port via env (rejected per vendoring
     policy), or have modemd-tunnel discover the port at call
     time via `/proc/net/udp`. Step 5c takes path 2.
   - slmodemd's PTY slave (`/dev/pts/<N>`) is owned by the uid
     that opens `/dev/ptmx`. Running modemd-ctrl as root didn't
     work despite root normally bypassing access checks; some
     devpts mount configurations return EACCES on stat from
     root. Switching modemd-ctrl to run as the slmodemd user
     resolved it. This is logged in both the init script
     comments and the at.test.js rationale.

- **Step 5c (part 1) — Symmetric tunnel + VmRegistrar + registered-mode
  d-modem.** Delivered.

  Backend-B's SIP signaling now works end-to-end against **real
  d-modem** (not just pjsip-test-peer). The path:

  1. **Symmetric tunnel ports.** `vm/tunnel/modemd-tunnel.c` now
     binds the well-known VM-side SIP/RTP/RTCP ports (5060/10000/
     10001) instead of ephemeral. This was blocked before step 5c
     because `pjsip-test-peer` explicitly binds 5060 — we moved the
     test peer to 5090 by default, freeing 5060 for modemd-tunnel.
     `deliver_to_udp` target-selection is now: (1) learned peer if
     available, (2) frame's dst_port if not yet learned and dst !=
     our bind, (3) drop. The dst_port fallback handles the test-
     peer startup case; the learned-peer path handles production
     once d-modem has sent its REGISTER. Protocol doc rewritten.

  2. **`src/sip/VmRegistrar.js` (~250 LOC).** Node-side SIP
     registrar that parses d-modem's REGISTER off the tunnel's SIP
     channel, extracts the Contact header (which carries d-modem's
     ephemeral PJSIP port), and responds 200 OK. Emits `registered`
     on first REGISTER, `refreshed` on subsequent refreshes (PJSIP
     refreshes at roughly expires/2). Doesn't own a UDP socket;
     subscribes to the tunnel's `frame-rx` event and uses a new
     public `tunnel.injectFrame()` method to send replies. No
     digest challenge — safe because the tunnel is a private
     loopback-scoped transport.

  3. **`PjsipBackend` useRegistrar option.** Third readiness-gate
     mode alongside the OPTIONS probe and skip. When
     `useRegistrar: true`, PjsipBackend starts a VmRegistrar on
     the tunnel, waits for d-modem's REGISTER via
     `waitForRegistration()`, and updates `this.targetUri` to the
     learned Contact binding before transitioning READY.
     `SipUacInternal` is constructed on `activate()` using the
     now-updated `targetUri` — no ongoing dynamic-URI handling
     needed.

  4. **Init script credentials.** `vm/overlay-pjsip/etc/init.d/
     S99modem-pjsip` now passes `-S 127.0.0.1:5060 -U modem -P x`
     to slmodemd, which forwards as `--sip-server/--sip-user/
     --sip-password` to d-modem at fork-exec time. With
     credentials present, d-modem sets `direct_call = 0`, skips
     the empty-dialstr exit, reaches `pjsua_create()`, initializes
     PJSIP with all 11 D-Modem media optimizations intact, and
     sends REGISTER to 127.0.0.1:5060 where modemd-tunnel is
     bound. The dial-string exit bug (d-modem.c line 724) is
     sidestepped without modifying d-modem.c — the credentials
     route bypasses that branch entirely.

  5. **`test/pjsip/registrar.test.js` (6/6)** — unit test with a
     stub tunnel. Covers REGISTER → 200 OK + binding; Expires
     header honored; second REGISTER fires `refreshed` not
     `registered`; updated Contact port propagates; missing
     Contact → 400; non-REGISTER frames ignored.

  6. **`test/slmodem-pjsip/at.test.js` extended (6/6)** — now uses
     `useRegistrar: true` (dropped the `skipReadinessProbe` hack).
     New assertion verifies d-modem actually registered and
     `backend.targetUri` was rewritten to the learned Contact.
     AT round-trip still works. Full proof the production stack
     is alive: slmodemd + d-modem (registered, PJSIP running with
     all optimizations) + modemd-tunnel + modemd-ctrl all
     cooperating.

  **Discoveries:**
   - d-modem's PJSIP logs `SIP UDP socket reachable at 127.0.0.1:<N>`
     at transport startup (console_level=4), giving us empirical
     confirmation of the ephemeral bind. PJSIP's 200-OK response
     was also visible in the boot log, proving the round-trip.
   - PJSIP specifies `Expires: 300` in its REGISTER (its default
     for `pjsua_acc_config`), and then refreshes at ~150s.
     VmRegistrar echoes this back; PjsipBackend doesn't care.
   - PJSIP's Contact URI carries `;ob` as an outbound marker
     (RFC 5626 style). We store and use the full URI verbatim —
     treating it as opaque keeps SipUacInternal correct.
   - The tunnel emits a benign "drop: sip inbound before host
     consumer seen" log when d-modem sends its REGISTER — that's
     the UdpTcpTunnel's OTHER delivery path (for host-side UDP
     consumers), which doesn't apply here because VmRegistrar
     bypasses it via the `frame-rx` event. Cosmetic only.

- **Step 5c (part 2) — CallSession B2BUA wiring + config
  integration.** Delivered.

  Node-side work only — no VM rebuild. Backend B is now
  selectable via config and Node routes external calls end-to-end
  through PjsipBackend + d-modem instead of the in-process DSP.

  1. **`PjsipBackend` control-channel parsing + event surface.**
     Added an internal `wire.Parser` on the accepted
     `controlSocket` so PjsipBackend emits the same
     `connected`/`data`/`silenceHangup`/`error` events as
     SlmodemBackend. Shared `parseResultLine` +
     `RATE_TO_PROTOCOL` helpers imported from SlmodemBackend —
     one source of truth for CONNECT/NO-CARRIER/BUSY parsing.
     CONNECT on the PTY → emit `connected` with `{protocol, bps,
     instance}` identical to backend A. New events `hello` (for
     test observation of modemd-ctrl HELLO) and `at-response`
     (raw PTY text stream, test-only). The INVITE-success emit
     was renamed `media-ready` so `connected` means modem
     handshake, matching existing CallSession/ModemDSP semantics.
     Public `sendAt(cmd)` and `write(buf)` methods match
     SlmodemBackend's signature. Result: CallSession can treat
     PjsipBackend and SlmodemBackend interchangeably on the
     event/method axis.

  2. **CallSession b2bua branch.** Constructor sets
     `this._mode = (backend === 'slmodemd-pjsip') ? 'b2bua' :
     'pcm'`. In b2bua mode, setup() opens a raw `dgram.Socket`
     bound to the allocated RTP port (no `RtpSession`, no codec
     configuration), activate() passes that socket + the
     dialog's remote RTP endpoint to
     `backend.activate({extRtpSocket, extPeer})`, and teardown
     closes the raw socket instead of closing an RtpSession.
     Audio event wiring (`_rtp.on('audio')` →
     `_dsp.receiveAudio`, `_dsp.on('audioOut')` → `_rtp.send`)
     is skipped — PjsipBackend's internal RtpBridge handles
     everything. The `connected`/`silenceHangup`/`error` wiring
     is shared between modes, so `_onModemConnected` and
     TelnetProxy wiring work identically.

  3. **Cold-boot guard.** `_buildModemBackendSync` throws a
     clear error if `slmodemd-pjsip` is selected without a pool.
     PjsipBackend's ~9 second startup (PJSIP init +
     REGISTER round-trip via VmRegistrar) is too expensive
     per-call; the pool's pre-warming is mandatory.

  4. **`src/index.js` integration.** New branch for
     `backend === 'slmodemd-pjsip'`: constructs a
     `ModemBackendPool` with a `PjsipBackend` factory configured
     with `enableControl: true, useRegistrar: true`, plus kernel
     / rootfs / qemu paths resolved from the repo. Backend A
     stays the default; backend B is opt-in via config.

  5. **Config documentation.** `config.js` updated with a full
     description of `'slmodemd-pjsip'` alongside `'native'` and
     `'slmodemd'`. Explains the B2BUA architecture and why it's
     useful (all 11 D-Modem media optimizations in effect).

  6. **`test/session/b2bua.test.js` (5/5 passing, ~1s).** Unit
     test with stub pool / backend / SIP server covering:
     constructor mode detection, raw socket binding in setup,
     correct extRtpSocket + extPeer shape passed to
     backend.activate, extPeer=undefined when dialog has no
     remote RTP (bridge will learn from first packet), clean
     teardown with pool.recycle + port release + `ended` emit.

  **Discoveries / design notes:**
   - Node TCP stream `'data'` events don't replay to late
     listeners. PjsipBackend's internal parser attached early
     meant tests using `backend.controlSocket.on('data', ...)`
     AFTER startAsync were racing an empty stream. Fix: tests
     use the new `'hello'` and `'at-response'` events instead.
     `at.test.js` and `ctrl.test.js` both reworked.
   - `'ended'` may emit synchronously within `hangup()` when the
     teardown chain has no real awaited I/O (stub backends,
     b2bua pool recycle). Hangup docstring updated to document
     the listener-attach-before-hangup requirement.
   - PjsipBackend previously emitted `'connected'` when INVITE
     succeeded, which conflicted with the modem-handshake-
     complete semantics in CallSession. Renamed to
     `'media-ready'`; `backend.test.js` and `ctrl.test.js`
     updated accordingly.

## In progress

(none — step 5c complete)

## Remaining

- **Step 6 — End-to-end handshake test.** User phones in from their
  SoftK56 over the real phone line, Node routes the call to backend B,
  confirms handshake reliability. Requires hardware, user-side test.

- **Step 7 — Sustained data mode test.** Once handshake is reliable,
  confirm BBS browsing and sustained data-mode works. Compare against
  backend A's Clock Pump v2 baseline (which gets ~50% handshake and
  degrades over minutes).

## Notes carried forward

- **Build cache:** `/tmp/pjsipbuild/output/pjsip.install.tar` exists in
  the current sandbox session — re-using it makes `build-pjsip-in-vm.sh`
  iterate in under a minute. If the sandbox is reset and the cache is
  gone, the artifact bundle from step 1 restores it (see
  `synthmodem-pjsip-artifacts-v1.tar.gz`).

- **The tunnel keeps PJSIP.md's original framing**, including src/dst
  ports in the frame. Extra 4 bytes per frame is trivial overhead and
  the port info helps when debugging packet flow.

- **Don't regress Clock Pump v2 / backend A** while developing backend
  B. Backend A is our working fallback if backend B hits unknowns.
