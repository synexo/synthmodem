# Prebuilt native addon binaries

This directory holds prebuilt `.node` binaries committed to the repo
so end users don't need a C++ toolchain.

Layout:

```
prebuilt/<platform>-<arch>/win_timer_resolution.node
```

Currently-shipped prebuilts:

* `win32-x64/win_timer_resolution.node` — Windows 64-bit Intel/AMD.
  This is the only platform/arch where the addon does real work
  (calling timeBeginPeriod via winmm.dll). All other targets compile
  to a no-op stub; we don't ship those because they aren't needed.

To regenerate a prebuilt: run `npm run build:prebuilt` on a machine
of the matching platform. The script builds the addon and copies the
resulting `.node` into the right subdirectory. Then commit the file.

N-API ABI stability means a binary built once works on every later
Node major version without rebuilding.
