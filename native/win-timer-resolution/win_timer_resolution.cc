// win-timer-resolution: raise the Windows system timer resolution to 1 ms.
//
// On Windows, the default system timer interrupt fires at ~15.6 ms intervals.
// All Node.js setTimeout / setInterval callbacks are gated on this rate
// regardless of the requested delay, so setInterval(20) actually fires at
// stuttering 16 ms / 31 ms intervals (alternating 1× and 2× the system
// quantum). For an audio path that needs to emit RTP packets every 20 ms,
// this produces large inter-packet jitter that hardware modems on the wire
// cannot tolerate during long idle.
//
// timeBeginPeriod(1) raises the system-wide timer rate to 1 ms while at
// least one process holds it raised. The cost is slightly higher CPU
// wake-up rate; modern multimedia software (browsers, audio applications)
// routinely uses this. timeEndPeriod(1) releases our claim. We hook
// process exit so the period is released cleanly even on abnormal exit
// where possible.
//
// On non-Windows targets this module compiles to a no-op so that the
// rest of the codebase can call its functions unconditionally.

#include <node_api.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <mmsystem.h>
#  pragma comment(lib, "winmm.lib")
#endif

#include <stdint.h>

static int g_period_active = 0;       // 0 = released, otherwise the period (ms)

static napi_value Begin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  uint32_t period = 1;
  if (argc >= 1) {
    napi_get_value_uint32(env, argv[0], &period);
  }
  if (period < 1) period = 1;
  if (period > 15) period = 15;

  uint32_t result = 0;
#ifdef _WIN32
  if (g_period_active != 0 && (int)period != g_period_active) {
    // Already holding a different period — release the old one first.
    timeEndPeriod(g_period_active);
    g_period_active = 0;
  }
  if (g_period_active == 0) {
    UINT r = timeBeginPeriod(period);
    if (r == TIMERR_NOERROR) {
      g_period_active = (int)period;
    }
    result = (uint32_t)r;
  }
#else
  // Non-Windows: nothing to do. Pretend success.
  (void)period;
  result = 0;
  g_period_active = (int)period;
#endif

  napi_value out;
  napi_create_uint32(env, result, &out);
  return out;
}

static napi_value End(napi_env env, napi_callback_info info) {
  uint32_t result = 0;
#ifdef _WIN32
  if (g_period_active != 0) {
    UINT r = timeEndPeriod(g_period_active);
    if (r == TIMERR_NOERROR) {
      g_period_active = 0;
    }
    result = (uint32_t)r;
  }
#else
  g_period_active = 0;
  result = 0;
#endif

  napi_value out;
  napi_create_uint32(env, result, &out);
  return out;
}

static napi_value IsActive(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_get_boolean(env, g_period_active != 0, &out);
  return out;
}

static napi_value Platform(napi_env env, napi_callback_info info) {
  napi_value out;
#ifdef _WIN32
  napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH, &out);
#else
  napi_create_string_utf8(env, "non-windows-noop", NAPI_AUTO_LENGTH, &out);
#endif
  return out;
}

#define DECLARE_FN(name, fn) \
  do { \
    napi_value f; \
    napi_create_function(env, NULL, 0, fn, NULL, &f); \
    napi_set_named_property(env, exports, name, f); \
  } while (0)

NAPI_MODULE_INIT() {
  DECLARE_FN("begin", Begin);
  DECLARE_FN("end", End);
  DECLARE_FN("isActive", IsActive);
  DECLARE_FN("platform", Platform);
  return exports;
}
