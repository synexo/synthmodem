/*
 * config.h for SynthModem's vendored spandsp V.22bis subset.
 *
 * spandsp normally generates this file via autotools. We ship a hand-written
 * portable config.h that works for both Linux (GCC/Clang) and Windows (MSVC)
 * builds via node-gyp, so that no autoconf run is required as part of
 * `npm install`.
 *
 * We only vendor the V.22bis subset of spandsp; macros that only affect
 * code paths we do not compile are omitted.
 */

#ifndef _SYNTHMODEM_SPANDSP_CONFIG_H_
#define _SYNTHMODEM_SPANDSP_CONFIG_H_

/* Host capability flags ---------------------------------------------------- */
/* stdbool.h exists on every C99+ compiler we target.                       */
#define HAVE_STDBOOL_H          1

/* math.h is universally available.                                         */
#define HAVE_MATH_H             1

/* tgmath.h is C99 but MSVC does not ship it. On MSVC we shim below.        */
#if !defined(_MSC_VER)
#define HAVE_TGMATH_H           1
#endif

/* long double support: GCC/Clang yes, MSVC treats it as double but the     */
/* header code only uses it in declarations, so safe either way.            */
#define HAVE_LONG_DOUBLE        1

/* malloc.h exists on Linux/MSVC but not BSD. spandsp already guards this. */
#define HAVE_MALLOC_H           1

/* lrint / lrintf are C99 functions, available on GCC/Clang and MSVC 2013+ */
#define HAVE_LRINT              1
#define HAVE_LRINTF             1

/* float variants of the math functions (sinf/cosf/tanf/asinf/acosf/atanf/   */
/* atan2f/ceilf/floorf/powf/expf/logf/log10f) are all provided by every     */
/* modern libm (C99 / MSVC 2013+). Declaring HAVE_*F here suppresses the    */
/* float-from-double shims in floating_fudge.h that otherwise collide       */
/* with the real libm declarations on modern glibc.                         */
#define HAVE_SINF               1
#define HAVE_COSF               1
#define HAVE_TANF               1
#define HAVE_ASINF              1
#define HAVE_ACOSF              1
#define HAVE_ATANF              1
#define HAVE_ATAN2F             1
#define HAVE_CEILF              1
#define HAVE_FLOORF             1
#define HAVE_POWF               1
#define HAVE_EXPF               1
#define HAVE_LOGF               1
#define HAVE_LOG10F             1

/* Aligned allocation --                                                    */
/*   - aligned_alloc: C11, available on Linux glibc ≥2.16, MSVC has its   */
/*     own spelling (_aligned_malloc). spandsp's alloc.c has a fallback    */
/*     path using fake_aligned_alloc when nothing is defined, so we can   */
/*     just leave these all undefined and take the safe fallback.         */
/* (Intentionally not defining HAVE_ALIGNED_ALLOC / HAVE_MEMALIGN /        */
/*  HAVE_POSIX_MEMALIGN — the fallback path is always correct.)           */

/* open_memstream is Linux-only; we don't use any spandsp code path that   */
/* calls it (it's only referenced from modules we don't vendor).           */

/* We use the floating-point DSP core, not fixed-point. The float path is  */
/* what is used by the v22bis demodulator by default.                      */
/* (SPANDSP_USE_FIXED_POINT intentionally NOT defined.)                    */

/* ------------------------------------------------------------------------ */
/* Windows / MSVC compatibility shims                                       */
/* ------------------------------------------------------------------------ */

#if defined(_MSC_VER) || defined(_WIN32)

/* <sys/time.h> is supplied for Windows via the stub header at
 * src/native/spandsp/win-compat/sys/time.h. That path is added to the
 * include search list only in Windows builds (see binding.gyp).        */

/* MSVC lacks <tgmath.h>. spandsp's V.22bis subset only uses floor/cos/sin/ */
/* sqrt/fabs/log/exp of float and double; plain <math.h> overloads work    */
/* for C++ callers, and for C we map tgmath-like names to the float/double */
/* forms. We intentionally keep HAVE_TGMATH_H undefined on MSVC so that    */
/* spandsp takes the <math.h> path.                                        */

/* Silence harmless MSVC warnings that add noise without value. */
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS 1
#endif

#endif /* _MSC_VER || _WIN32 */

/* ------------------------------------------------------------------------ */
/* SPAN_DECLARE                                                             */
/* ------------------------------------------------------------------------ */
/* Statically linked inside the Node addon — no DLL export decoration.     */
/* spandsp's telephony.h defines SPAN_DECLARE as a no-op unless overridden.*/

#endif /* _SYNTHMODEM_SPANDSP_CONFIG_H_ */
