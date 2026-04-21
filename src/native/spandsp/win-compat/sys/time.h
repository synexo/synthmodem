/*
 * sys/time.h — Windows compatibility stub for the vendored spandsp subset.
 *
 * spandsp's alloc.c and logging.c include <sys/time.h> unconditionally to
 * get `struct timeval` and `gettimeofday()`. Windows CRT has no such
 * header; MSVC fails to compile those files without this stub.
 *
 * This file is placed in `src/native/spandsp/win-compat/` and that path
 * is added to the include search list ONLY on Windows builds (see the
 * conditions block in binding.gyp). On Linux and macOS the system's
 * `<sys/time.h>` is used directly — this file is not in the search path
 * there.
 *
 * Provides:
 *   - `struct timeval` (via <winsock2.h>)
 *   - `gettimeofday()` — a thin wrapper around GetSystemTimeAsFileTime
 *     producing the same microsecond-resolution output as POSIX.
 *
 * This is only exercised if spandsp is built with SHOW_DATE logging
 * enabled, which SynthModem does not do, but the code must still
 * compile and link.
 */

#ifndef _SYNTHMODEM_WIN_COMPAT_SYS_TIME_H_
#define _SYNTHMODEM_WIN_COMPAT_SYS_TIME_H_

#if defined(_WIN32) || defined(_MSC_VER)

#include <winsock2.h>  /* provides `struct timeval` */
#include <windows.h>
#include <time.h>

/* Win32 has no gettimeofday. Provide a static-inline shim. It's fine
   to have this defined in every translation unit that includes the
   header because static linkage keeps definitions local.             */
static __inline int gettimeofday(struct timeval *tv, void *tz)
{
    (void) tz;
    if (tv) {
        FILETIME ft;
        unsigned __int64 t;
        GetSystemTimeAsFileTime(&ft);
        t  = ((unsigned __int64) ft.dwHighDateTime << 32) | ft.dwLowDateTime;
        /* 100-ns ticks since 1601-01-01 -> us since 1970-01-01. */
        t -= 116444736000000000ULL;
        tv->tv_sec  = (long) (t / 10000000ULL);
        tv->tv_usec = (long) ((t % 10000000ULL) / 10ULL);
    }
    return 0;
}

#else
/* Non-Windows — should not be reachable (this file isn't on the
   include path for POSIX builds), but keep a safe fallback. */
#include_next <sys/time.h>
#endif

#endif /* _SYNTHMODEM_WIN_COMPAT_SYS_TIME_H_ */
