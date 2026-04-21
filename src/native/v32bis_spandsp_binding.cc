// v32bis_spandsp_binding.cc
// ---------------------------------------------------------------------------
// SynthModem — N-API binding for spandsp's V.17 / V.32bis data pump.
//
// Parallels the V.22bis binding (v22_spandsp_binding.cc). spandsp's V.32bis
// layer is a thin wrapper around its V.17 modem — same modulation, same
// training constellations, same trellis-coded QAM at 2400 baud. Rates
// supported: 4800 / 7200 / 9600 / 12000 / 14400 bps.
//
// NOTE: Upstream spandsp's v32bis.c carries a "WORK IN PROGRESS — NOT YET
// FUNCTIONAL!" banner. In practice the *modulation* (V.17 PHY) is solid
// and battle-tested via FreeSWITCH FAX. What's incomplete is the V.32bis
// call-establishment state machine (CC/AA/CA/AC training sequences, rate
// renegotiation, etc.). We drive those from the JS/Handshake layer above
// this binding the same way we drive V.22bis — so "WIP" at the C layer
// doesn't block us.
//
// JS-facing API mirrors V22bisNative exactly so V32bis.js can reuse the
// same wrapper shape:
//   new V32bisNative(role, bitRate, eventCb)
//   inst.writeData(Buffer)
//   inst.tx(numSamples) → Int16Array
//   inst.rx(Int16Array)
//   inst.getStats() → { bitRate, currentBitRate }
//   inst.close()
// ---------------------------------------------------------------------------

#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <vector>
#include <deque>
#include <string>

extern "C" {
#include "spandsp/telephony.h"
#include "spandsp/fast_convert.h"
#include "spandsp/async.h"
#include "spandsp/logging.h"
#include "spandsp/complex.h"
#include "spandsp/vector_float.h"
#include "spandsp/complex_vector_float.h"
#include "spandsp/vector_int.h"
#include "spandsp/complex_vector_int.h"
#include "spandsp/power_meter.h"
#include "spandsp/v29rx.h"                /* qam_report_handler_t       */
#include "spandsp/godard.h"
#include "spandsp/v17rx.h"
#include "spandsp/v17tx.h"
#include "spandsp/v32bis.h"
}

// ---------------------------------------------------------------------------
// NAPI helper (matches the V22 binding's style)
// ---------------------------------------------------------------------------
#define NAPI_CALL_V32(env, call)                                            \
  do {                                                                      \
    napi_status _s = (call);                                                \
    if (_s != napi_ok) {                                                    \
      const napi_extended_error_info *err = nullptr;                        \
      napi_get_last_error_info((env), &err);                                \
      bool is_pending = false;                                              \
      napi_is_exception_pending((env), &is_pending);                        \
      if (!is_pending) {                                                    \
        const char *msg = (err && err->error_message)                       \
          ? err->error_message : "N-API failure";                           \
        napi_throw_error((env), nullptr, msg);                              \
      }                                                                     \
      return nullptr;                                                       \
    }                                                                       \
  } while (0)

// ---------------------------------------------------------------------------
// Instance state
// ---------------------------------------------------------------------------
struct V32Instance {
  napi_env                env              = nullptr;
  napi_ref                cb_ref           = nullptr;
  v32bis_state_t         *modem            = nullptr;
  int                     bit_rate         = 14400;
  bool                    calling_party    = false;

  // TX: byte → bit conversion state (UART framing, LSB-first).
  std::deque<uint8_t>     tx_byte_queue;
  int                     tx_frame_pos     = -1;
  uint8_t                 tx_frame_byte    = 0xff;

  // RX: bit → byte assembly state (UART framing, LSB-first).
  int                     rx_state         = 0;
  int                     rx_bit_count     = 0;
  uint8_t                 rx_byte          = 0;

  // Deferred JS event buffers.
  std::vector<uint8_t>    rx_byte_buffer;
  std::vector<int>        status_buffer;

  bool                    closed           = false;
};

// ---------------------------------------------------------------------------
// spandsp callbacks — identical contract to V.22bis binding
// ---------------------------------------------------------------------------

static int v32_get_bit(void *user_data) {
  V32Instance *inst = static_cast<V32Instance *>(user_data);

  if (inst->tx_frame_pos < 0) {
    if (inst->tx_byte_queue.empty()) {
      return 1;  // mark idle
    }
    inst->tx_frame_byte = inst->tx_byte_queue.front();
    inst->tx_byte_queue.pop_front();
    inst->tx_frame_pos  = 0;
  }

  int out;
  int pos = inst->tx_frame_pos;
  if (pos == 0) {
    out = 0;  // start bit
  } else if (pos >= 1 && pos <= 8) {
    out = (inst->tx_frame_byte >> (pos - 1)) & 1;  // LSB first
  } else {
    out = 1;  // stop bit
  }

  inst->tx_frame_pos++;
  if (inst->tx_frame_pos > 9) inst->tx_frame_pos = -1;
  return out;
}

static void v32_put_bit(void *user_data, int bit) {
  V32Instance *inst = static_cast<V32Instance *>(user_data);

  if (bit < 0) {
    inst->status_buffer.push_back(bit);
    return;
  }

  switch (inst->rx_state) {
    case 0:
      if (bit == 0) {
        inst->rx_state     = 1;
        inst->rx_bit_count = 0;
        inst->rx_byte      = 0;
      }
      break;
    case 1:
      inst->rx_byte |= (uint8_t)(bit & 1) << inst->rx_bit_count;
      if (++inst->rx_bit_count == 8) {
        inst->rx_state = 2;
      }
      break;
    case 2:
      if (bit == 1) {
        // Same idle-suppression as V.22bis: 0xFF from scrambled mark is
        // the signature of "framing tripped on idle"; drop it.
        if (inst->rx_byte != 0xff) {
          inst->rx_byte_buffer.push_back(inst->rx_byte);
        }
      }
      inst->rx_state = 0;
      break;
  }
}

// ---------------------------------------------------------------------------
// Status name lookup (optional but aids debugging). spandsp's SIG_STATUS_*
// values are negative integers; a handful relevant to V.17/V.32bis:
//
//   SIG_STATUS_CARRIER_UP           = -3
//   SIG_STATUS_CARRIER_DOWN         = -4
//   SIG_STATUS_TRAINING_IN_PROGRESS = -5
//   SIG_STATUS_TRAINING_SUCCEEDED   = -6
//   SIG_STATUS_TRAINING_FAILED      = -7
//   SIG_STATUS_END_OF_DATA          = -8
// ---------------------------------------------------------------------------
static const char *v32_status_name(int code) {
  switch (code) {
    case SIG_STATUS_CARRIER_UP:            return "CARRIER_UP";
    case SIG_STATUS_CARRIER_DOWN:          return "CARRIER_DOWN";
    case SIG_STATUS_TRAINING_IN_PROGRESS:  return "TRAINING_IN_PROGRESS";
    case SIG_STATUS_TRAINING_SUCCEEDED:    return "TRAINING_SUCCEEDED";
    case SIG_STATUS_TRAINING_FAILED:       return "TRAINING_FAILED";
    case SIG_STATUS_END_OF_DATA:           return "END_OF_DATA";
    default:                               return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// JS event emission — drain buffered events to the JS callback
// ---------------------------------------------------------------------------
static napi_status v32_emit_events(napi_env env, V32Instance *inst) {
  if (inst->rx_byte_buffer.empty() && inst->status_buffer.empty()) {
    return napi_ok;
  }

  napi_value cb, recv;
  napi_status s;
  s = napi_get_reference_value(env, inst->cb_ref, &cb);
  if (s != napi_ok) return s;
  s = napi_get_global(env, &recv);
  if (s != napi_ok) return s;

  // Emit data buffer
  if (!inst->rx_byte_buffer.empty()) {
    napi_value evt, typeStr, bytes;
    void *data_ptr;
    s = napi_create_object(env, &evt);                             if (s != napi_ok) return s;
    s = napi_create_string_utf8(env, "data", NAPI_AUTO_LENGTH,
                                &typeStr);                         if (s != napi_ok) return s;
    s = napi_set_named_property(env, evt, "type", typeStr);        if (s != napi_ok) return s;
    s = napi_create_buffer_copy(env,
                                inst->rx_byte_buffer.size(),
                                inst->rx_byte_buffer.data(),
                                &data_ptr, &bytes);                if (s != napi_ok) return s;
    s = napi_set_named_property(env, evt, "bytes", bytes);         if (s != napi_ok) return s;
    inst->rx_byte_buffer.clear();

    napi_value result;
    s = napi_call_function(env, recv, cb, 1, &evt, &result);
    if (s != napi_ok) return s;
  }

  // Emit dedup'd status events
  if (!inst->status_buffer.empty()) {
    std::vector<int> deduped;
    deduped.reserve(inst->status_buffer.size());
    int last = 0x7fffffff;
    for (int code : inst->status_buffer) {
      if (code != last) {
        deduped.push_back(code);
        last = code;
      }
    }
    inst->status_buffer.clear();

    for (int code : deduped) {
      napi_value evt, typeStr, codeVal, nameVal;
      s = napi_create_object(env, &evt);                             if (s != napi_ok) return s;
      s = napi_create_string_utf8(env, "status", NAPI_AUTO_LENGTH,
                                  &typeStr);                         if (s != napi_ok) return s;
      s = napi_set_named_property(env, evt, "type", typeStr);        if (s != napi_ok) return s;
      s = napi_create_int32(env, code, &codeVal);                    if (s != napi_ok) return s;
      s = napi_set_named_property(env, evt, "code", codeVal);        if (s != napi_ok) return s;
      s = napi_create_string_utf8(env, v32_status_name(code),
                                  NAPI_AUTO_LENGTH, &nameVal);       if (s != napi_ok) return s;
      s = napi_set_named_property(env, evt, "name", nameVal);        if (s != napi_ok) return s;

      napi_value result;
      s = napi_call_function(env, recv, cb, 1, &evt, &result);
      if (s != napi_ok) return s;
    }
  }

  return napi_ok;
}

// ---------------------------------------------------------------------------
// JS-visible methods
// ---------------------------------------------------------------------------

// V32bisNative(role:string, bitRate:number, eventCb:function)
static napi_value V32_Constructor(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, &argc, args, &jsThis, nullptr));

  if (argc < 3) {
    napi_throw_type_error(env, nullptr,
      "V32bisNative(role, bitRate, eventCb) — 3 args required");
    return nullptr;
  }

  char role_buf[16] = {0};
  size_t role_len   = 0;
  NAPI_CALL_V32(env, napi_get_value_string_utf8(env, args[0], role_buf,
                                                sizeof(role_buf), &role_len));
  bool calling = (strcmp(role_buf, "originate") == 0 ||
                  strcmp(role_buf, "calling")   == 0);

  int32_t bit_rate = 14400;
  NAPI_CALL_V32(env, napi_get_value_int32(env, args[1], &bit_rate));
  // V.17/V.32bis valid rates per ITU-T V.32bis §4.1:
  //   14400, 12000, 9600, 7200 — all from V.17 core
  //   4800 is V.32bis-specific (excluded from V.17 FAX use but spandsp enums include it)
  if (bit_rate != 4800 && bit_rate != 7200 && bit_rate != 9600
      && bit_rate != 12000 && bit_rate != 14400) {
    napi_throw_range_error(env, nullptr,
      "bitRate must be 4800, 7200, 9600, 12000, or 14400");
    return nullptr;
  }

  napi_valuetype cb_type;
  NAPI_CALL_V32(env, napi_typeof(env, args[2], &cb_type));
  if (cb_type != napi_function) {
    napi_throw_type_error(env, nullptr, "eventCb must be a function");
    return nullptr;
  }

  V32Instance *inst = new V32Instance();
  inst->env           = env;
  inst->bit_rate      = bit_rate;
  inst->calling_party = calling;

  NAPI_CALL_V32(env, napi_create_reference(env, args[2], 1, &inst->cb_ref));

  inst->modem = v32bis_init(
      /* s              */ nullptr,
      /* bit_rate       */ bit_rate,
      /* calling_party  */ calling,
      /* get_bit        */ v32_get_bit,
      /* get_bit_udata  */ inst,
      /* put_bit        */ v32_put_bit,
      /* put_bit_udata  */ inst);

  if (!inst->modem) {
    napi_delete_reference(env, inst->cb_ref);
    delete inst;
    napi_throw_error(env, nullptr, "v32bis_init failed");
    return nullptr;
  }

  auto finalize = [](napi_env env, void *data, void * /*hint*/) {
    V32Instance *inst = static_cast<V32Instance *>(data);
    if (!inst->closed && inst->modem) {
      v32bis_release(inst->modem);
      v32bis_free(inst->modem);
    }
    if (inst->cb_ref) napi_delete_reference(env, inst->cb_ref);
    delete inst;
  };
  NAPI_CALL_V32(env, napi_wrap(env, jsThis, inst, finalize, nullptr, nullptr));

  return jsThis;
}

// inst.writeData(Buffer) — queue raw bytes for TX (UART-framed via get_bit)
static napi_value V32_WriteData(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, &argc, &arg, &jsThis, nullptr));

  V32Instance *inst;
  NAPI_CALL_V32(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) {
    napi_throw_error(env, nullptr, "closed");
    return nullptr;
  }

  bool is_buf = false;
  NAPI_CALL_V32(env, napi_is_buffer(env, arg, &is_buf));
  if (!is_buf) {
    napi_throw_type_error(env, nullptr, "writeData expects Buffer");
    return nullptr;
  }

  void *data;
  size_t len;
  NAPI_CALL_V32(env, napi_get_buffer_info(env, arg, &data, &len));
  const uint8_t *p = static_cast<const uint8_t *>(data);
  for (size_t i = 0; i < len; i++) {
    inst->tx_byte_queue.push_back(p[i]);
  }

  napi_value undef;
  NAPI_CALL_V32(env, napi_get_undefined(env, &undef));
  return undef;
}

// inst.tx(numSamples:number) → Int16Array
static napi_value V32_Tx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, &argc, &arg, &jsThis, nullptr));

  V32Instance *inst;
  NAPI_CALL_V32(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) {
    napi_throw_error(env, nullptr, "closed");
    return nullptr;
  }

  int32_t num_samples = 0;
  NAPI_CALL_V32(env, napi_get_value_int32(env, arg, &num_samples));
  if (num_samples < 0 || num_samples > 8000) {
    napi_throw_range_error(env, nullptr, "tx: numSamples out of range");
    return nullptr;
  }

  // Allocate typed array + underlying ArrayBuffer
  napi_value arr_buf, ta;
  void *ab_data;
  NAPI_CALL_V32(env, napi_create_arraybuffer(env, num_samples * sizeof(int16_t),
                                             &ab_data, &arr_buf));
  NAPI_CALL_V32(env, napi_create_typedarray(env, napi_int16_array, num_samples,
                                            arr_buf, 0, &ta));

  int16_t *buf = static_cast<int16_t *>(ab_data);
  int produced = v32bis_tx(inst->modem, buf, num_samples);
  // If spandsp produces fewer than requested (end_of_data transient), zero
  // the rest so the JS side never observes uninit'd memory.
  if (produced < num_samples) {
    memset(buf + produced, 0, (num_samples - produced) * sizeof(int16_t));
  }

  // TX may push status codes too (rare in v32bis, but handle uniformly).
  if (v32_emit_events(env, inst) != napi_ok) return nullptr;

  return ta;
}

// inst.rx(Int16Array)
static napi_value V32_Rx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, &argc, &arg, &jsThis, nullptr));

  V32Instance *inst;
  NAPI_CALL_V32(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) {
    napi_throw_error(env, nullptr, "closed");
    return nullptr;
  }

  napi_typedarray_type type;
  size_t length;
  void *data;
  NAPI_CALL_V32(env, napi_get_typedarray_info(env, arg, &type, &length,
                                              &data, nullptr, nullptr));
  if (type != napi_int16_array) {
    napi_throw_type_error(env, nullptr, "rx: expected Int16Array");
    return nullptr;
  }

  v32bis_rx(inst->modem, static_cast<int16_t *>(data), (int) length);

  if (v32_emit_events(env, inst) != napi_ok) return nullptr;

  napi_value undef;
  NAPI_CALL_V32(env, napi_get_undefined(env, &undef));
  return undef;
}

// inst.getStats() → { bitRate, currentBitRate }
static napi_value V32_GetStats(napi_env env, napi_callback_info info) {
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, nullptr, nullptr, &jsThis, nullptr));

  V32Instance *inst;
  NAPI_CALL_V32(env, napi_unwrap(env, jsThis, (void **) &inst));

  int current = 0;
  if (!inst->closed && inst->modem) {
    current = v32bis_current_bit_rate(inst->modem);
  }

  napi_value obj, v1, v2;
  NAPI_CALL_V32(env, napi_create_object(env, &obj));
  NAPI_CALL_V32(env, napi_create_int32(env, inst->bit_rate, &v1));
  NAPI_CALL_V32(env, napi_set_named_property(env, obj, "bitRate", v1));
  NAPI_CALL_V32(env, napi_create_int32(env, current, &v2));
  NAPI_CALL_V32(env, napi_set_named_property(env, obj, "currentBitRate", v2));
  return obj;
}

// inst.close()
static napi_value V32_Close(napi_env env, napi_callback_info info) {
  napi_value jsThis;
  NAPI_CALL_V32(env, napi_get_cb_info(env, info, nullptr, nullptr, &jsThis, nullptr));

  V32Instance *inst;
  NAPI_CALL_V32(env, napi_unwrap(env, jsThis, (void **) &inst));

  if (!inst->closed && inst->modem) {
    v32bis_release(inst->modem);
    v32bis_free(inst->modem);
    inst->modem  = nullptr;
    inst->closed = true;
  }

  napi_value undef;
  NAPI_CALL_V32(env, napi_get_undefined(env, &undef));
  return undef;
}

// ---------------------------------------------------------------------------
// Registration hook — called from the main binding's Init() function.
//
// This keeps both V22bisNative and V32bisNative inside the same .node file
// (same binding.gyp target) while keeping the C++ code cleanly separated.
// ---------------------------------------------------------------------------
extern "C" napi_status register_v32bis_class(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "writeData", nullptr, V32_WriteData, nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "tx",        nullptr, V32_Tx,        nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "rx",        nullptr, V32_Rx,        nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "getStats", nullptr, V32_GetStats, nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "close",     nullptr, V32_Close,     nullptr, nullptr, nullptr,
      napi_default, nullptr },
  };

  napi_value ctor;
  napi_status s;
  s = napi_define_class(env, "V32bisNative", NAPI_AUTO_LENGTH,
                        V32_Constructor, nullptr,
                        sizeof(props)/sizeof(props[0]),
                        props, &ctor);
  if (s != napi_ok) return s;
  s = napi_set_named_property(env, exports, "V32bisNative", ctor);
  return s;
}
