# win-timer-resolution

Tiny native addon that raises the Windows system timer interrupt rate
to 1 ms (default ~15.6 ms) for the duration of the synthmodem
process. Without this, the native modem backend's RTP TX pacing on
Windows produces stuttering 16/31/16/31 ms inter-packet gaps that
disrupt hardware modems on the wire during long pure-marking idle.

On non-Windows targets the JS wrapper exports no-op functions so the
rest of the code can call begin/end unconditionally. The build is
skipped entirely on those platforms.

## How it ships

The `prebuilt/` directory contains a compiled `.node` binary built
from `win_timer_resolution.cc`. **Because Node-API is ABI-stable, a
single binary built on any modern Node version works on every later
major Node version without recompilation** (see
<https://nodejs.org/api/n-api.html>).

End users on **win32-x64** therefore need NO build tools at all:

```
git clone …
npm install     # does nothing relevant; just runs scripts/install-native.js
npm start       # win-timer-resolution loads from prebuilt/win32-x64/
```

The startup log will show:

```
[INFO] [SynthModem] Windows multimedia timer raised to 1 ms (timeBeginPeriod)
```

## Build (uncovered architectures, or to verify the prebuilt)

If you're on a Windows architecture without a prebuilt (e.g.
win32-arm64), `npm install` will automatically try to build from
source. That requires:

* Visual Studio Build Tools 2019 or 2022 with the "Desktop
  development with C++" workload, OR full Visual Studio with the
  same workload.
* Python 3 (any modern version; node-gyp will find it automatically
  if it's in PATH or in `C:\Python3xx`).
* `node-gyp` ships with npm — no separate install needed.

If the build fails, the install script logs a clear warning and exits
0 — `npm install` succeeds, the application still installs and runs,
and on Windows logs a startup warning. The application works, just
without the timer fix.

### Manual rebuild

```
npm run build:native        # rebuild only, leaves output in build/Release/
npm run build:prebuilt      # rebuild + copy result into prebuilt/<plat>-<arch>/
```

The second one is what maintainers run on a Windows x64 machine to
refresh the committed `prebuilt/win32-x64/win_timer_resolution.node`
file.

### Verify the prebuilt

If you want to verify that the committed binary matches the source,
delete `prebuilt/win32-x64/`, run `npm run build:prebuilt`, and
compare the output to the previously-committed file. The build is
deterministic for our tiny code; the bytes should match modulo
compiler/linker version differences.

### Force-build on non-Windows (CI sanity)

```
SYNTHMODEM_FORCE_BUILD_NATIVE=1 npm install
```

Builds the no-op stub on Linux/macOS so you can confirm it loads and
the graceful-fallback paths work end-to-end. Requires gcc + Python 3.

## Load order

The JS wrapper (`index.js`) tries:

1. `prebuilt/<platform>-<arch>/win_timer_resolution.node` — committed binary
2. `build/Release/win_timer_resolution.node` — locally-built (Release)
3. `build/Debug/win_timer_resolution.node` — locally-built (Debug)

The first one that loads wins. If none load, the wrapper logs a
warning on Windows and falls back to no-op behavior on all platforms.

## API

`begin(periodMs)` — calls `timeBeginPeriod(periodMs)`. Returns 0 on
success.

`end()` — calls `timeEndPeriod()` to release our claim. Returns 0 on
success.

`isActive()` — true if a period is currently raised.

`platform()` — `"win32"` if the real Windows code is in effect, or
`"non-windows-noop"` on Linux/macOS.

`isAvailable()` — true if the addon was loaded successfully.
