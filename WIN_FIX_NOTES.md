# Windows-fix drop for SynthModem V.22/V.22bis native addon

## What this fixes

```
fatal error C1083: Cannot open include file: 'sys/time.h': No such file or directory
```

MSVC doesn't ship `<sys/time.h>`. spandsp's `alloc.c` and `logging.c` include
it unconditionally. No `#define` can rescue the missing file — it's resolved
by the lexer before any macro substitution.

## Approach

Add a stub `sys/time.h` that only Windows sees. Three files changed:

  1. **NEW:** `src/native/spandsp/win-compat/sys/time.h`
     Minimal stub: pulls in `<winsock2.h>` for `struct timeval`, provides an
     inline `gettimeofday()` shim using `GetSystemTimeAsFileTime`. Not used on
     Linux/macOS — only lives on the Windows include path.

  2. **CHANGED:** `binding.gyp`
     Adds `src/native/spandsp/win-compat` to the `include_dirs` *only* in the
     Windows conditional block. Your `_ALLOW_KEYWORD_MACROS` and
     `__inline__=__inline` additions are preserved.

  3. **CHANGED:** `src/native/spandsp/config.h`
     Removed the duplicate gettimeofday shim that was in there. The new
     `win-compat/sys/time.h` is authoritative.

## How to install

From the repo root:

```bash
tar xzf synthmodem_win_fix.tar.gz
rm -rf build            # force a clean rebuild, not incremental
npm install
```

Or drop the three files individually from `win-fix/` over the existing tree.

## Verified

Linux rebuild (clean) passes. Smoke test passes (CARRIER_UP still fires
when a 1200 Hz carrier is injected on the RX side).

## If the next Windows error differs

Paste the log. Likely candidates if something else trips:
- `typeof` / `span_container_of` in telephony.h — only matters if an
  invocation reaches MSVC. The V.22bis subset shouldn't hit this.
- Missing `lrintf` / `llrintf` — MSVC has them since 2013 and our config.h
  already claims `HAVE_LRINTF=1`, but worth confirming.
- `unistd.h` or `sys/ioctl.h` in some transitive header — same stub
  pattern (add to win-compat/) will fix it.

The `win-compat/` directory is extensible; we drop new stubs in as needed
without modifying vendored spandsp code.
