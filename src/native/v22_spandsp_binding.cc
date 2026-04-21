// v22_spandsp_binding.cc
// ---------------------------------------------------------------------------
// SynthModem — N-API binding for spandsp's V.22 / V.22bis data pump.
//
// This file is the thin layer between JavaScript and spandsp. Everything
// happens synchronously on the JS thread:
//   - new V22bisNative(role, bitRate, statusCb)           → init modem
//   - inst.writeData(Buffer)                              → queue TX bytes
//   - inst.tx(numSamples) → Int16Array                    → pull TX audio
//   - inst.rx(Int16Array)                                 → push RX audio
//   - inst.close()                                        → free
//
// Both v22bis_tx and v22bis_rx are pure synchronous DSP calls. put_bit is
// invoked from inside v22bis_rx (same thread as the JS caller), so we can
// just buffer the received bits in the instance and flush them to a
// JavaScript callback *after* v22bis_rx returns. That removes any need
// for a ThreadSafeFunction.
//
// Modem status events (CARRIER_UP / CARRIER_DOWN / TRAINING_SUCCEEDED /
// TRAINING_FAILED) are also fired from inside v22bis_rx, so we buffer and
// flush the same way.
//
// Data model:
//   spandsp delivers individual bits via put_bit. The JS layer sees only
//   already-framed bytes. Framing is UART-async (1 start + 8 data LSB-first
//   + 1 stop) — per ITU-T V.22bis §5.5 the modem's internal interface is
//   purely synchronous bits; the UART framing is the responsibility of
//   the caller. We do that framing here, in C++, on the TX side (turn
//   bytes → bits) and the RX side (bits → framed bytes), and emit whole
//   bytes over the 'data' callback. Matches the V.21 JS protocol's API.
//
//   We suppress the all-ones idle pattern (0xFF) on RX the same way the
//   old JS V22 did: when the line is idle, the scrambler emits a long
//   run of marks that can frame as a spurious 0xFF byte.
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
#include "spandsp/complex.h"              /* complexf_t used in v22bis.h */
#include "spandsp/vector_float.h"
#include "spandsp/complex_vector_float.h"
#include "spandsp/vector_int.h"
#include "spandsp/complex_vector_int.h"
#include "spandsp/v29rx.h"                /* qam_report_handler_t       */
#include "spandsp/power_meter.h"          /* power_meter_t in private/  */
#include "spandsp/v22bis.h"
#include "spandsp/private/logging.h"
#include "spandsp/private/power_meter.h"
#include "spandsp/private/v22bis.h"       /* v22bis_state_s internals    */
}

// ---------------------------------------------------------------------------
// Error-check helper
// ---------------------------------------------------------------------------
#define NAPI_CALL(env, call)                                                \
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
struct V22Instance {
  napi_env                env              = nullptr;     // set per-call
  napi_ref                wrapper_ref      = nullptr;     // keeps JS object alive
  napi_ref                cb_ref           = nullptr;     // event callback ref
  v22bis_state_t         *modem            = nullptr;
  int                     bit_rate         = 2400;
  bool                    calling_party    = false;

  // TX: byte → bit conversion state (UART framing, LSB-first).
  // Each byte becomes 10 symbols: 0 (start) + b0..b7 + 1 (stop).
  std::deque<uint8_t>     tx_byte_queue;
  int                     tx_frame_pos     = -1;  // -1 = need new byte; 0..9 = bit position within frame
  uint8_t                 tx_frame_byte    = 0xff;

  // RX: bit → byte assembly state (UART framing, LSB-first).
  int                     rx_state         = 0;   // 0 = idle, 1 = data, 2 = stop
  int                     rx_bit_count     = 0;
  uint8_t                 rx_byte          = 0;

  // Event queues (drained at the end of each rx/tx call).
  // We deliberately don't invoke JS callbacks from inside spandsp's
  // get_bit / put_bit / modem_status callbacks. Those are called while
  // spandsp owns internal state; re-entering spandsp from JS would
  // corrupt it. Instead we buffer and drain post-call.
  std::vector<uint8_t>    rx_byte_buffer;
  std::vector<int>        status_buffer;

  bool                    closed           = false;
};

// ---------------------------------------------------------------------------
// spandsp callbacks — called from inside v22bis_tx / v22bis_rx
// ---------------------------------------------------------------------------

// get_bit: spandsp is pulling the next TX bit. Return 0 or 1. Return 1
// (mark idle) when we have no data queued — this is what V.22bis expects
// for inter-frame idle.
static int synth_get_bit(void *user_data) {
  V22Instance *inst = static_cast<V22Instance *>(user_data);

  // Need a new UART frame?
  if (inst->tx_frame_pos < 0) {
    if (inst->tx_byte_queue.empty()) {
      // Mark idle — no framing at all, continuous 1s.
      return 1;
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

// put_bit: spandsp delivers one received data bit (values 0/1), OR a
// SIG_STATUS_* code (always negative). The status codes use the same
// callback channel — we demux here and buffer accordingly.
static void synth_put_bit(void *user_data, int bit) {
  V22Instance *inst = static_cast<V22Instance *>(user_data);

  if (bit < 0) {
    // Status code. Buffer it; flushed post-call.
    inst->status_buffer.push_back(bit);
    return;
  }

  // Data bit — run through the UART framer.
  switch (inst->rx_state) {
    case 0:  // idle, looking for start bit (0)
      if (bit == 0) {
        inst->rx_state     = 1;
        inst->rx_bit_count = 0;
        inst->rx_byte      = 0;
      }
      break;

    case 1:  // collecting 8 data bits, LSB first
      inst->rx_byte |= (uint8_t)(bit & 1) << inst->rx_bit_count;
      if (++inst->rx_bit_count == 8) {
        inst->rx_state = 2;
      }
      break;

    case 2:  // stop bit must be 1; else framing error, silently drop
      if (bit == 1) {
        // Suppress 0xFF idle pattern (scrambled mark stream). Real data
        // bytes will be anything; 0xFF is the signature of "framing
        // tripped on idle". This matches the old JS V.22 behaviour.
        if (inst->rx_byte != 0xff) {
          inst->rx_byte_buffer.push_back(inst->rx_byte);
        }
      }
      inst->rx_state = 0;
      break;
  }
}

// modem_status callback — we also route status via put_bit (negative
// values), but spandsp ALSO has a dedicated status handler. Use only put_bit
// here for uniformity: v22bis_rx invokes put_bit(s->put_bit_user_data, -N)
// for state changes.
//
// However, v22bis_set_modem_status_handler is how you register a separate
// channel. We ALSO register one so carrier-up etc. fire even while the RX
// data stream has not yet produced a put_bit call. Both channels feed the
// same buffer.
static void synth_modem_status(void *user_data, int status) {
  V22Instance *inst = static_cast<V22Instance *>(user_data);
  inst->status_buffer.push_back(status);
}

// ---------------------------------------------------------------------------
// JS event emission — invoked once per rx()/tx() call, after DSP is done
// ---------------------------------------------------------------------------

// Emit the buffered events to the single JS callback that was passed at
// construction time. Callback signature: (event) where event is an object.
//
//   { type: 'data',                bytes: Buffer }
//   { type: 'status',              code:  number, name: string }
//
// 'code' is the raw SIG_STATUS_* enum value (negative). 'name' is the
// human-readable string. The JS side does its own coarse-grained
// translation to 'listening' / 'remote-detected' / 'ready' events that
// Handshake.js consumes.
static const char *status_name(int code) {
  switch (code) {
    case SIG_STATUS_CARRIER_DOWN:          return "CARRIER_DOWN";
    case SIG_STATUS_CARRIER_UP:            return "CARRIER_UP";
    case SIG_STATUS_TRAINING_IN_PROGRESS:  return "TRAINING_IN_PROGRESS";
    case SIG_STATUS_TRAINING_SUCCEEDED:    return "TRAINING_SUCCEEDED";
    case SIG_STATUS_TRAINING_FAILED:       return "TRAINING_FAILED";
    case SIG_STATUS_FRAMING_OK:            return "FRAMING_OK";
    case SIG_STATUS_END_OF_DATA:           return "END_OF_DATA";
    case SIG_STATUS_SHUTDOWN_COMPLETE:     return "SHUTDOWN_COMPLETE";
    case SIG_STATUS_MODEM_RETRAIN_OCCURRED:return "MODEM_RETRAIN_OCCURRED";
    default:                               return "UNKNOWN";
  }
}

static napi_status flush_events(napi_env env, V22Instance *inst) {
  if (inst->rx_byte_buffer.empty() && inst->status_buffer.empty()) {
    return napi_ok;
  }
  if (inst->cb_ref == nullptr) {
    inst->rx_byte_buffer.clear();
    inst->status_buffer.clear();
    return napi_ok;
  }

  napi_status s;
  napi_value cb, recv;
  s = napi_get_reference_value(env, inst->cb_ref, &cb); if (s != napi_ok) return s;
  s = napi_get_undefined(env, &recv);                    if (s != napi_ok) return s;

  // Emit one "data" event with the accumulated bytes (if any).
  if (!inst->rx_byte_buffer.empty()) {
    napi_value evt, typeStr, bytes;
    void *data_ptr = nullptr;
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

  // Emit one "status" event per status code. De-dupe run-length so we
  // don't flood on rapid-fire duplicate status lines.
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
      s = napi_create_string_utf8(env, status_name(code),
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

// V22bisNative(role:string, bitRate:number, eventCb:function)
static napi_value Constructor(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, &jsThis, nullptr));

  if (argc < 3) {
    napi_throw_type_error(env, nullptr,
      "V22bisNative(role, bitRate, eventCb) — 3 args required");
    return nullptr;
  }

  // role: "answer" | "originate"
  char role_buf[16] = {0};
  size_t role_len   = 0;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[0], role_buf,
                                            sizeof(role_buf), &role_len));
  bool calling = (strcmp(role_buf, "originate") == 0 ||
                  strcmp(role_buf, "calling")   == 0);

  // bit_rate: 1200 | 2400
  int32_t bit_rate = 2400;
  NAPI_CALL(env, napi_get_value_int32(env, args[1], &bit_rate));
  if (bit_rate != 1200 && bit_rate != 2400) {
    napi_throw_range_error(env, nullptr, "bitRate must be 1200 or 2400");
    return nullptr;
  }

  // eventCb: function
  napi_valuetype cb_type;
  NAPI_CALL(env, napi_typeof(env, args[2], &cb_type));
  if (cb_type != napi_function) {
    napi_throw_type_error(env, nullptr, "eventCb must be a function");
    return nullptr;
  }

  V22Instance *inst = new V22Instance();
  inst->env           = env;
  inst->bit_rate      = bit_rate;
  inst->calling_party = calling;

  // Stash the JS-side callback.
  NAPI_CALL(env, napi_create_reference(env, args[2], 1, &inst->cb_ref));

  // Initialise spandsp V.22bis.
  //
  // Options: no guard tone for now. (Real-world UK modems send 1800 Hz
  // guard tone from the answerer; for local-loop test with a modern
  // modem this is usually not required. Can be exposed later if needed.)
  inst->modem = v22bis_init(
      /* s              */ nullptr,
      /* bit_rate       */ bit_rate,
      /* options        */ V22BIS_GUARD_TONE_NONE,
      /* calling_party  */ calling,
      /* get_bit        */ synth_get_bit,
      /* get_bit_udata  */ inst,
      /* put_bit        */ synth_put_bit,
      /* put_bit_udata  */ inst);

  if (!inst->modem) {
    napi_delete_reference(env, inst->cb_ref);
    delete inst;
    napi_throw_error(env, nullptr, "v22bis_init failed");
    return nullptr;
  }

  // Register modem-status handler as a SECOND channel for carrier/training
  // events. spandsp sends these through put_bit too (as negative values),
  // but wiring the dedicated handler means we don't miss the earliest
  // events that fire before any data bit is produced.
  v22bis_set_modem_status_handler(inst->modem, synth_modem_status, inst);

  // Wrap native pointer in the JS object.
  NAPI_CALL(env, napi_wrap(env, jsThis, inst,
    /* finalize */ [](napi_env e, void *data, void *) {
      V22Instance *i = static_cast<V22Instance *>(data);
      if (i->modem && !i->closed) {
        v22bis_release(i->modem);
        v22bis_free(i->modem);
      }
      if (i->cb_ref)      napi_delete_reference(e, i->cb_ref);
      if (i->wrapper_ref) napi_delete_reference(e, i->wrapper_ref);
      delete i;
    }, nullptr, nullptr));

  return jsThis;
}

// writeData(Buffer) — queue bytes for TX. No return value.
static napi_value WriteData(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) { napi_throw_error(env, nullptr, "closed"); return nullptr; }

  bool is_buf = false;
  NAPI_CALL(env, napi_is_buffer(env, args[0], &is_buf));
  if (!is_buf) {
    napi_throw_type_error(env, nullptr, "writeData(Buffer) expected");
    return nullptr;
  }

  void *data = nullptr;
  size_t len = 0;
  NAPI_CALL(env, napi_get_buffer_info(env, args[0], &data, &len));

  const uint8_t *p = static_cast<const uint8_t *>(data);
  for (size_t i = 0; i < len; i++) {
    inst->tx_byte_queue.push_back(p[i]);
  }

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

// tx(numSamples) → Int16Array. Pull `numSamples` samples of TX audio.
static napi_value Tx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) { napi_throw_error(env, nullptr, "closed"); return nullptr; }

  int32_t n = 0;
  NAPI_CALL(env, napi_get_value_int32(env, args[0], &n));
  if (n <= 0 || n > 100000) {
    napi_throw_range_error(env, nullptr, "tx(n): n out of range");
    return nullptr;
  }

  // Allocate an ArrayBuffer of int16_t * n bytes and a matching Int16Array.
  napi_value ab, ta;
  void *ab_data = nullptr;
  size_t ab_size = (size_t)n * sizeof(int16_t);
  NAPI_CALL(env, napi_create_arraybuffer(env, ab_size, &ab_data, &ab));
  NAPI_CALL(env, napi_create_typedarray(env, napi_int16_array, n, ab, 0, &ta));

  int16_t *buf = static_cast<int16_t *>(ab_data);

  // Pull samples from spandsp. v22bis_tx returns the number of samples
  // generated; it is expected to equal `n` in normal operation, but can
  // be smaller if the modem has finished its shutdown sequence. Any
  // shortfall is zero-filled.
  int produced = v22bis_tx(inst->modem, buf, n);
  if (produced < n) {
    memset(buf + produced, 0, (size_t)(n - produced) * sizeof(int16_t));
  }

  // No RX events here, but events may have fired from shutdown logic.
  napi_status fs = flush_events(env, inst);
  if (fs != napi_ok) return nullptr;

  return ta;
}

// rx(Int16Array) — feed RX audio into the modem. No return value.
static napi_value Rx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed) { napi_throw_error(env, nullptr, "closed"); return nullptr; }

  bool is_ta = false;
  NAPI_CALL(env, napi_is_typedarray(env, args[0], &is_ta));
  if (!is_ta) {
    napi_throw_type_error(env, nullptr, "rx(Int16Array) expected");
    return nullptr;
  }

  napi_typedarray_type ta_type;
  size_t ta_len = 0;
  void *ta_data = nullptr;
  NAPI_CALL(env, napi_get_typedarray_info(env, args[0], &ta_type, &ta_len,
                                          &ta_data, nullptr, nullptr));
  if (ta_type != napi_int16_array) {
    napi_throw_type_error(env, nullptr, "rx: Int16Array required");
    return nullptr;
  }

  v22bis_rx(inst->modem,
            static_cast<const int16_t *>(ta_data),
            static_cast<int>(ta_len));

  napi_status fs = flush_events(env, inst);
  if (fs != napi_ok) return nullptr;

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

// getStats() → { rxCarrierFreq, rxSignalPower, rxSymbolTimingCorrection,
//                currentBitRate, txQueueDepth }
static napi_value GetStats(napi_env env, napi_callback_info info) {
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, nullptr, nullptr, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));

  napi_value out;
  NAPI_CALL(env, napi_create_object(env, &out));

  if (!inst->closed && inst->modem) {
    napi_value v;
    NAPI_CALL(env, napi_create_double(env, v22bis_rx_carrier_frequency(inst->modem), &v));
    NAPI_CALL(env, napi_set_named_property(env, out, "rxCarrierFreq", v));

    NAPI_CALL(env, napi_create_double(env, v22bis_rx_signal_power(inst->modem), &v));
    NAPI_CALL(env, napi_set_named_property(env, out, "rxSignalPower", v));

    NAPI_CALL(env, napi_create_double(env, v22bis_rx_symbol_timing_correction(inst->modem), &v));
    NAPI_CALL(env, napi_set_named_property(env, out, "rxSymbolTimingCorrection", v));

    NAPI_CALL(env, napi_create_int32(env, v22bis_get_current_bit_rate(inst->modem), &v));
    NAPI_CALL(env, napi_set_named_property(env, out, "currentBitRate", v));
  }

  napi_value q;
  NAPI_CALL(env, napi_create_int32(env, (int32_t) inst->tx_byte_queue.size(), &q));
  NAPI_CALL(env, napi_set_named_property(env, out, "txQueueDepth", q));

  return out;
}

// forceS1Accept() — SynthModem extension for "blind S1" V.22bis 2400 negotiation.
//
// Background: the answerer-side V.22bis S1 detection in spandsp (v22bis_rx.c
// around line 695) relies on spandsp's QAM demodulator successfully decoding
// the caller's S1 signal as alternating raw_bits values 0 and 3. In practice,
// with S1-first callers (ones that transmit S1 before any SB1 preamble), the
// Gardner symbol-timing recovery does not always lock correctly on the clean
// alternating-phase signal, and spandsp reports pattern_repeats ≤ 4 against a
// threshold of 15. S1 detection fails, spandsp commits to 1200 bps, and any
// caller that insists on 2400 then drops the call.
//
// The JS layer runs its own Goertzel-based S1 detector at 900+1500 Hz (the
// two sidebands the unscrambled 00/11 dibit pattern produces from the
// 1200 Hz carrier). When it sees S1, it calls this method to reproduce the
// exact state transition spandsp would have performed itself had its own
// S1 detector succeeded:
//
//   s->tx.training      = V22BIS_TX_TRAINING_STAGE_U0011;
//   s->tx.training_count = 0;
//   s->negotiated_bit_rate = 2400;
//
// Guards:
//   - Only valid when we are the answerer (!calling_party). A calling modem
//     starts S1 itself and doesn't need to "accept" anything.
//   - Only valid when bit_rate == 2400 (we advertised 2400 capability).
//   - Only valid when negotiated_bit_rate is still 1200 (we haven't already
//     committed either way). This makes the call idempotent.
//   - Only valid while we're still in a training stage that can transition to
//     U0011 (SCRAMBLED_ONES_AT_1200 or earlier RX stage, TX in U11). If the
//     timers have already fired we're past the point of no return.
//
// Returns true if the transition was performed, false if guards rejected.
static napi_value ForceS1Accept(napi_env env, napi_callback_info info) {
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, nullptr, nullptr, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));
  if (inst->closed || inst->modem == nullptr) {
    napi_throw_error(env, nullptr, "closed");
    return nullptr;
  }

  v22bis_state_t *s = inst->modem;
  bool accepted = false;

  // Guards — skip silently (return false) rather than throwing, so the caller
  // can call this opportunistically every block without worrying about errors.
  if (!s->calling_party
      && s->bit_rate == 2400
      && s->negotiated_bit_rate == 1200)
  {
    // The only safe moment to inject S1 acceptance is:
    //   TX in U11 (we've been transmitting continuous unscrambled ones, which
    //   is the answerer's "I see your carrier, proceed" signal — the caller
    //   has had time to receive it).
    //   RX in SCRAMBLED_ONES_AT_1200 (we've seen caller carrier and completed
    //   SYMBOL_ACQUISITION, so spandsp is ready to handle the SB1 that will
    //   follow the S1 burst).
    //
    // Rejecting before U11 means we wait for TX to have been carrying USB1
    // for at least one block, which prevents racing the initial 75ms silence.
    // Rejecting after SCRAMBLED_ONES_AT_1200 means we don't clobber a state
    // machine that's already past the decision point.
    if (s->tx.training == V22BIS_TX_TRAINING_STAGE_U11 &&
        s->rx.training == V22BIS_RX_TRAINING_STAGE_SCRAMBLED_ONES_AT_1200)
    {
      s->tx.training        = V22BIS_TX_TRAINING_STAGE_U0011;
      s->tx.training_count  = 0;
      s->negotiated_bit_rate = 2400;
      accepted = true;
    }
  }

  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, accepted, &result));
  return result;
}

// close() — explicitly release the spandsp modem. Not strictly required
// (finalize does it too), but useful for deterministic cleanup.
static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value jsThis;
  NAPI_CALL(env, napi_get_cb_info(env, info, nullptr, nullptr, &jsThis, nullptr));

  V22Instance *inst;
  NAPI_CALL(env, napi_unwrap(env, jsThis, (void **) &inst));

  if (!inst->closed && inst->modem) {
    v22bis_release(inst->modem);
    v22bis_free(inst->modem);
    inst->modem  = nullptr;
    inst->closed = true;
  }

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

// ---------------------------------------------------------------------------
// V.17/V.32bis class registration — implemented in v32bis_spandsp_binding.cc
// ---------------------------------------------------------------------------
extern "C" napi_status register_v32bis_class(napi_env env, napi_value exports);

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "writeData", nullptr, WriteData, nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "tx",        nullptr, Tx,        nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "rx",        nullptr, Rx,        nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "getStats", nullptr, GetStats, nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "forceS1Accept", nullptr, ForceS1Accept, nullptr, nullptr, nullptr,
      napi_default, nullptr },
    { "close",     nullptr, Close,     nullptr, nullptr, nullptr,
      napi_default, nullptr },
  };

  napi_value ctor;
  NAPI_CALL(env, napi_define_class(env, "V22bisNative", NAPI_AUTO_LENGTH,
                                   Constructor, nullptr,
                                   sizeof(props)/sizeof(props[0]),
                                   props, &ctor));
  NAPI_CALL(env, napi_set_named_property(env, exports, "V22bisNative", ctor));

  // Register V32bisNative alongside.
  napi_status s = register_v32bis_class(env, exports);
  if (s != napi_ok) {
    const napi_extended_error_info *err = nullptr;
    napi_get_last_error_info(env, &err);
    const char *msg = (err && err->error_message)
      ? err->error_message : "register_v32bis_class failed";
    napi_throw_error(env, nullptr, msg);
    return nullptr;
  }

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
