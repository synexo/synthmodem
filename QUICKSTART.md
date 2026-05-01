# synthmodem — QUICKSTART

This walks through getting a working synthmodem instance on a fresh
machine. For the project overview, see `README.md`. For the
maintainer-side workflow (rebuilding from source, vendoring,
release packaging), see `MAINTAINERS.md`.

There are two install paths:

- **Windows zip** (`SynthModem-win-x64.zip` from
  <https://github.com/synexo/synthmodem/tree/main/release>): the simplest
  option. No Node.js or QEMU install, no shell, no build tools.
  Skip to "Install — Windows (zip)" below.
- **Developer checkout** (Linux / macOS / Windows from a `git clone`):
  needs Node.js 16+ on PATH and, for the slmodemd-pjsip and auto
  backends, a working `qemu-system-i386`.

## What you need

For the **Windows zip**: nothing. Both Node.js (`win/nodejs/`) and
QEMU (`win/qemu/`) ship inside the zip. Skip to "Install" below.

For a **developer checkout**:

- Node.js 16 or later on PATH. There are no runtime npm
  dependencies. On **Windows x64**, the repo ships a prebuilt native
  addon (`win-timer-resolution`, ~16 KB) which `npm install` uses
  automatically — no compiler needed. On other Windows
  architectures (x86, arm64), `npm install` will try to build the
  addon from source if Visual Studio Build Tools and Python 3 are
  installed; if they aren't, `npm install` still succeeds and the
  app still runs, just without the Windows-only RTP TX timer fix.
  On Linux and macOS the addon is irrelevant and `npm install`
  skips it entirely. See `MAINTAINERS.md` and
  `native/win-timer-resolution/README.md` for the full story.
- For the `slmodemd-pjsip` backend, and for `auto` (which starts
  every call on slmodemd-pjsip), `qemu-system-i386`:
  - **Linux**: `apt install qemu-system-x86`
  - **macOS**: `brew install qemu`
  - **Windows from a checkout**: either install QEMU from
    <https://www.qemu.org/download/#windows> and point
    `config.js`'s `QEMU_PATH` at it, or run from a clone that
    includes `win/qemu/` (the bundled QEMU subset) — the default
    `QEMU_PATH = '.\\win\\qemu\\qemu-system-i386.exe'` will then
    work as-is.

In all cases:

- A SIP gateway upstream of synthmodem to dial in. A typical setup is a
- Cisco SPA2102 ATA or similar bridging an analog phone cable to SIP. (no dial-up required)

## Install

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

### Developer checkout (Linux / macOS / Windows)

```sh
git clone https://github.com/synexo/synthmodem.git
cd synthmodem
npm install
```

`npm install` finishes in a couple of seconds. There are no runtime
npm dependencies. On Windows x64 it picks up the committed prebuilt
native addon (no compiler needed). On other Windows architectures it
attempts to build the addon from source; if a C++ toolchain isn't
present the build is skipped with a clear warning and the app still
runs (just without the Windows-only RTP TX timer fix). On Linux and
macOS the addon step is skipped entirely.

If `npm install` fails on a fresh box it's almost certainly a
Node.js install issue, not a synthmodem-specific one.

## Verifying the timer fix on Windows

**This is the single most important thing to verify on a Windows
install.** Without it, hardware modems on the wire may receive
garbage characters during long pure-marking idle (the symptom is
spontaneous junk on the caller's terminal that doesn't stop until
the call disconnects). On Linux and macOS the timer fix is
irrelevant and you can skip this section entirely.

This section applies to both the Windows zip install and a Windows
developer checkout — the addon binary lives in the same place in
both cases.

### What it does

Windows' default system timer fires at ~15.6 ms. Node's
`setInterval` and `setTimeout` are gated on that quantum, which
disrupts the native modem backend's RTP TX pacing. The
`win-timer-resolution` addon raises the timer to 1 ms via
`timeBeginPeriod(1)` for the duration of the synthmodem process,
the same trick browsers and audio software have used for years.

The fix is required by **every backend that runs the modem DSP on
Node's event loop**, which today is:

- `native` — runs the DSP on Node throughout every call.
- `auto` — starts on slmodemd-pjsip (DSP in the VM, not affected),
  but if V.8 times out and the call swaps to native, the DSP moves
  onto Node's event loop for the remainder of the call.

The `slmodemd-pjsip` backend alone does not need the fix because
its DSP and pacing live in C inside the VM, on PJSIP's own clock.

### How it ships

- **win32-x64** (64-bit Windows 10/11 — the common case): the repo
  and the Windows zip both ship a committed prebuilt at
  `native/win-timer-resolution/prebuilt/win32-x64/win_timer_resolution.node`.
  `npm install` detects it and skips compilation. **No build tools
  required.** This is the path the vast majority of users will hit.

- **win32-ia32 / win32-arm64** (32-bit Windows / Windows on ARM):
  no prebuilt is shipped. `npm install` automatically tries to
  build the addon from source via `node-gyp`. That requires
  Visual Studio Build Tools 2019 or newer (with the "Desktop
  development with C++" workload) and Python 3. If both are
  present the build succeeds and the addon loads from
  `build/Release/`. If either is missing, the install **does not
  fail** — it logs a clear warning and exits 0, the app installs
  cleanly, and the timer fix is simply not active at runtime.

- **Linux / macOS**: the addon step is skipped entirely.

### What to check at startup

Run `npm start` (or double-click `START.BAT` on Windows) and look
at the first few log lines. On a healthy Windows install you will
see:

```
[INFO] [SynthModem] Windows multimedia timer raised to 1 ms (timeBeginPeriod)
```

This appears for `backend = 'native'` and `backend = 'auto'` — both
claim the 1 ms timer at startup. It does NOT appear for
`backend = 'slmodemd-pjsip'` (and shouldn't — that backend doesn't
need it).

If you see:

```
[WARN] [TimerRes] win-timer-resolution native addon not available …
```

the addon didn't load. Possible causes, in order of likelihood:

1. You're on win32-ia32 or win32-arm64 and the source build was
   skipped because VS Build Tools / Python 3 isn't installed. Fix:
   install both, then run `npm install` again.
2. You're on win32-x64 but the
   `native/win-timer-resolution/prebuilt/win32-x64/` directory is
   missing from your tree. Fix: re-extract the zip (it should
   contain that file) or, on a developer checkout, re-clone or run
   `npm run build:native` if you have the toolchain.
3. The build attempted but failed (missing C++ workload, mismatched
   Python). Re-run `npm install` after fixing and watch the log.

The app will run regardless, but on a real PSTN call you'll see the
garbage-character symptom described above. Don't ignore the warning.

## Configure

Open `config.js`. The top of the file has a **COMMON CONFIG** block
covering the settings most users edit. The settings almost everyone
adjusts:

```js
const HOST          = '0.0.0.0';        // bind on all interfaces (default)
const PUBLIC_HOST   = '';               // empty = auto-resolve per call
const SIP_PORT      = 5060;             // SIP UDP/TCP port (5060 is standard)
```

`HOST = '0.0.0.0'` makes synthmodem accept SIP from any local
interface — the right default for most installs. Set it to a
specific LAN IP only if you have multiple NICs and want to bind to
just one.

`PUBLIC_HOST = ''` enables per-call auto-resolution: synthmodem picks
the best local IP to advertise in SIP/SDP headers based on which
interface the caller's INVITE arrived on (subnet match → first
non-loopback → 127.0.0.1 fallback). Set it to a fixed IP only if
you're behind NAT and need a specific external address advertised.

Then choose a backend by editing the same const block:

```js
const BACKEND       = 'auto';   // 'auto' | 'native' | 'slmodemd-pjsip'
```

The three backends are described in detail in `README.md`. Quick
guidance:

- **Pick `auto` if** you want the broadest coverage with no
  per-call configuration: V.32bis/V.34 via slmodemd-pjsip when the
  caller is V.8-capable, automatic fall-through to the native
  V.21/V.22/V.22bis/Bell 103 probe chain when V.8 times out.
  Recommended default. Requires QEMU (slmodemd-pjsip is its first
  attempt on every call) and, on Windows, the `win-timer-resolution`
  addon (post-swap native phase needs the 1 ms timer).
- **Pick `slmodemd-pjsip` if** you only need V.21–V.34 from
  V.8-capable callers and never need to handle vintage non-V.8
  modems (V.22-only, Bell 103, etc.). Fewer moving parts than
  `auto`. Stable and end-to-end tested over real PSTN.
- **Pick `native` if** you only need V.21, V.22, V.22bis, V.23, or
  Bell 103 and you can't run QEMU on the host (or you specifically
  want to stay in-process). Faster path to running, no VM, but no
  V.32bis/V.34 path.

### Backend-specific configuration

**For `slmodemd-pjsip`:** Set the QEMU path. The default in
`config.js` is `'.\\win\\qemu\\qemu-system-i386.exe'`, which is
correct for the Windows zip and for a developer checkout that
includes `win/qemu/`. On Linux and macOS, set it to `null` and put
`qemu-system-i386` on PATH:

```js
const QEMU_PATH     = '.\\win\\qemu\\qemu-system-i386.exe';   // Windows (zip or checkout)
// const QEMU_PATH  = null;                                   // Linux/macOS — searches PATH and env
// const QEMU_PATH  = 'C:\\Program Files\\qemu\\qemu-system-i386.exe';  // Windows w/ system QEMU
```

If you need to bound the modem to a specific protocol or rate (for
example, talking to a known V.22-only caller), edit the `AT_INIT`
constant in the COMMON CONFIG block:

```js
const AT_INIT       = ['AT&K3', 'AT+MS=22,0,1200,1200'];   // force V.22 1200 bps
```

See the AT command reference in `config.js`'s
`modem['slmodemd-pjsip'].atInit` section for the full list of useful
slmodemd commands.

**For `auto`:** No auto-specific configuration. Auto inherits the
`slmodemd-pjsip` settings for the V.8/high-rate phase and the
`modem.native.*` settings for the post-swap legacy probe phase. The
swap is triggered automatically by the slmodemd-pjsip V.8 timeout
(deterministic ~12 s after the call lands), and the post-swap probe
chain runs V.22bis (5 s) → V.21 (3 s) → Bell 103 (5 s). On Windows
the `win-timer-resolution` addon is required for the post-swap
phase; see "Verifying the timer fix on Windows" above.

**For `native`:** Tune the protocol negotiation list and V.8
behavior under `config.modem.native.*`:

```js
modem: {
  backend: 'native',
  native: {
    // All five low-speed protocols validated end-to-end against
    // real hardware:
    //   'V22bis', 'V22', 'V23', 'V21', 'Bell103'
    protocolPreference: ['V22bis', 'V22', 'V23', 'V21', 'Bell103'],
    forceProtocol:      null,        // 'V22' to bypass V.8 negotiation
    enableV8:           true,        // V.8 CM/JM exchange before training
    ...
  },
}
```

## Run

### Windows (zip)

Double-click `START.BAT`. A console window opens.

### Developer checkout

```sh
node src/index.js
```

(Or `npm start`, which runs the same thing.)

### Expected startup output

You should see startup output like (for `backend: 'auto'`):

```
═══════════════════════════════════════
  SynthModem — Modem/Telnet Gateway
═══════════════════════════════════════
Config: SIP 0.0.0.0:5060, RTP 10000-10100
Modem role: answer, backend: auto
Windows multimedia timer raised to 1 ms (timeBeginPeriod)   [Windows only]
...
SynthModem ready — waiting for calls
```

For `auto` and `slmodemd-pjsip`, "Modem VM warm" means QEMU has
booted, slmodemd is up, and PJSIP has registered with the in-process
VmRegistrar. First call will dispatch immediately; no boot delay at
call time.

For `native`, the startup is shorter — there's no VM to boot.

## Next steps

- See `README.md` for the project overview and architecture
- See `config.js` for the full configuration reference (every
  option is commented in-file)
- See `MAINTAINERS.md` if you need to rebuild VM binaries from
  source or prepare a release
- See `docs/slmodemd-pjsip.md` and `docs/PJSIP.md` for the design
  rationale and implementation manual of the `slmodemd-pjsip` backend
