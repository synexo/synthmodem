{
  "targets": [
    {
      "target_name": "synthmodem_v22",
      "sources": [
        "src/native/v22_spandsp_binding.cc",
        "src/native/v32bis_spandsp_binding.cc",

        # Vendored spandsp V.22bis + V.17/V.32bis subset.
        "src/native/spandsp/src/alloc.c",
        "src/native/spandsp/src/async.c",
        "src/native/spandsp/src/bit_operations.c",
        "src/native/spandsp/src/complex_filters.c",
        "src/native/spandsp/src/complex_vector_float.c",
        "src/native/spandsp/src/complex_vector_int.c",
        "src/native/spandsp/src/dds_float.c",
        "src/native/spandsp/src/dds_int.c",
        "src/native/spandsp/src/godard.c",
        "src/native/spandsp/src/logging.c",
        "src/native/spandsp/src/math_fixed.c",
        "src/native/spandsp/src/modem_echo.c",
        "src/native/spandsp/src/power_meter.c",
        "src/native/spandsp/src/tone_detect.c",
        "src/native/spandsp/src/v17rx.c",
        "src/native/spandsp/src/v17tx.c",
        "src/native/spandsp/src/v22bis_rx.c",
        "src/native/spandsp/src/v22bis_tx.c",
        "src/native/spandsp/src/v32bis.c",
        "src/native/spandsp/src/vector_float.c",
        "src/native/spandsp/src/vector_int.c"
      ],
      "include_dirs": [
        "src/native/spandsp",
        "src/native/spandsp/src"
      ],
      "defines": [
        # Instruct spandsp that it has an autotools-generated config.h
        # (we hand-wrote one, but it's the same contract).
        "HAVE_CONFIG_H=1",

        # When compiling spandsp statically into this addon on Windows,
        # tell telephony.h that this is the library-building side so
        # SPAN_DECLARE expands to dllexport (or, for static linkage,
        # something the MSVC linker will accept). For a single-module
        # static build this is harmless on non-Windows.
        "LIBSPANDSP_EXPORTS=1"
      ],
      "cflags_c": [
        "-std=gnu11",
        "-Wno-unused-function",
        "-Wno-unused-variable",
        "-Wno-unused-but-set-variable",
        "-Wno-sign-compare",
        "-Wno-pointer-sign",
        "-Wno-implicit-fallthrough"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "conditions": [
        [ "OS==\"win\"", {
          # On Windows, prepend the `win-compat/` directory to the
          # include search list so that vendored spandsp C files which
          # unconditionally `#include <sys/time.h>` resolve to our
          # compatibility stub instead of a missing POSIX header.
          "include_dirs": [
            "src/native/spandsp/win-compat"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                # MSVC warning silencers for spandsp:
                #  /wd4244 narrowing conversion
                #  /wd4267 size_t to int
                #  /wd4018 signed/unsigned mismatch
                #  /wd4146 unary minus on unsigned
                #  /wd4005 macro redefinition
                "/wd4244", "/wd4267", "/wd4018",
                "/wd4146", "/wd4005"
              ]
            }
          },
          "defines": [
            "_CRT_SECURE_NO_WARNINGS=1",
            "WIN32_LEAN_AND_MEAN=1",
            "NOMINMAX=1",

            # MSVC doesn't define M_PI in <math.h> unless _USE_MATH_DEFINES
            # is set. godard.c (new in V.17/V.32bis vendoring) uses M_PI
            # directly without its own guard (unlike tone_detect.c which
            # #defines it locally). Set this globally so any vendored
            # spandsp file can rely on M_PI.
            "_USE_MATH_DEFINES=1",

            # spandsp sources use GCC-style __inline__. MSVC supports
            # __inline but treats __inline__ as an unknown keyword; the
            # _ALLOW_KEYWORD_MACROS + __inline__=__inline pair aliases
            # the GCC spelling to MSVC's without modifying spandsp.
            "_ALLOW_KEYWORD_MACROS",
            "__inline__=__inline"
          ]
        } ],
        [ "OS==\"linux\"", {
          "libraries": [ "-lm" ]
        } ],
        [ "OS==\"mac\"", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "10.13"
          }
        } ]
      ]
    }
  ]
}
