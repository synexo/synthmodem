/*
 * wire.h — synthmodem control-channel wire protocol
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This header defines the on-the-wire framing used between:
 *
 *   - modemd-ctrl (running inside the guest VM), which speaks this
 *     protocol over a virtio-serial control chardev and bridges
 *     slmodemd's PTY to the Node host, AND
 *
 *   - the Node host-side driver (PjsipBackend.js in src/backends/),
 *     which speaks this same protocol over the corresponding
 *     host-side TCP loopback socket attached to QEMU.
 *
 * (Historical: this protocol was originally also spoken by
 * modemd-shim, the host-paced backend's audio+control bridge.
 * That backend has been removed; the framing survives because
 * modemd-ctrl reuses it for the control channel.)
 *
 * Channel layout under the slmodemd-pjsip backend:
 *
 *   AUDIO     — PJSIP RTP, host-side. Does NOT use this wire protocol.
 *               Audio reaches slmodemd via d-modem inside the VM.
 *
 *   CONTROL   — virtio-serial chardev between QEMU and Node, framed
 *               with this protocol. Carries AT commands (host→guest),
 *               AT responses and parsed MODEM_STATUS events
 *               (guest→host), post-CONNECT modem data in both
 *               directions, and a single startup HELLO from guest
 *               that signals "modemd-ctrl is up and ready".
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Frame format (single control channel):
 *
 *     +-------------+---------+--------------------------+
 *     |  length     |  type   |  payload                 |
 *     |  (u16 LE)   |  (u8)   |  (length - 1 bytes)      |
 *     +-------------+---------+--------------------------+
 *
 *   - `length` is the size of `type + payload` in bytes. A type-only
 *     message with no payload has length == 1. The `length` field
 *     itself is NOT included in the count.
 *   - `type` identifies the message kind. Valid values are listed
 *     below; unknown types must be silently ignored by both sides
 *     (so newer ctrl/host can roll in new message types without
 *     breaking older peers).
 *   - `payload` is type-specific, documented below.
 *
 * Why this specific format rather than mirroring slmodemd's native
 * `struct socket_frame`:
 *
 *   struct socket_frame is a C tagged union whose exact size and
 *   padding depend on the compiler and target ABI. Across a
 *   VM/host boundary (different compiler for guest vs. host,
 *   potentially different word size even with identical "architecture"),
 *   that's a portability hazard. Our length-prefixed, little-endian
 *   framing is ABI-agnostic and future-proof.
 *
 * modemd-ctrl performs all impedance matching between this protocol
 * and slmodemd's native PTY (AT commands + data-mode bytes).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * When adding a new message type:
 *   1. Add the WIRE_TYPE_* constant below (pick the next free value in
 *      the appropriate range; see block comments).
 *   2. Document the payload format in the comment above its constant.
 *   3. Add encode/decode support in BOTH modemd-ctrl.c AND
 *      vm/qemu-runner/wire.js (Node host).
 *   4. Bump WIRE_VERSION (documented in HELLO).
 *   5. Add a unit test exercising the new type's round-trip.
 *
 * NOTE: the WIRE_TYPE_AUDIO / WIRE_TYPE_SILENCE / WIRE_TYPE_DUMP_*
 * constants are vestigial. They were used by the deprecated
 * modemd-shim audio+dump path. modemd-ctrl is control-only and
 * does not emit or consume them. Kept defined for now so wire.js
 * can match historical captures; can be retired in a future
 * cleanup pass once nothing references them.
 */

#ifndef SYNTHMODEM_WIRE_H
#define SYNTHMODEM_WIRE_H

#include <stdint.h>

/*
 * Wire protocol version. The guest announces this in its HELLO payload;
 * the host can refuse to proceed if it doesn't understand the version.
 *
 * Increment on any incompatible change. Adding new message types is
 * compatible (unknown-type silent-ignore rule), so a version bump is
 * only needed when an EXISTING message changes shape.
 */
#define WIRE_VERSION 1

/*
 * Frame header is 3 bytes: u16 length + u8 type.
 * Maximum payload size: we cap at 4 KiB minus header to avoid huge
 * allocations. Audio frames are 320 bytes, control messages are small,
 * so 4 KiB is ample headroom.
 */
#define WIRE_HEADER_SIZE    3
#define WIRE_MAX_PAYLOAD    (4096 - WIRE_HEADER_SIZE)

/*
 * Audio frame sizing. Must match slmodemd's SIP_FRAMESIZE exactly so
 * that one WIRE_TYPE_AUDIO message carries exactly one slmodemd-native
 * audio frame with no repacketization. See slmodemd/modem.h:
 *     SIP_RATE       = 8000
 *     SIP_FRAMESIZE  = SIP_RATE / (1000/20) = 160  (samples per 20 ms)
 *     audio.buf size = SIP_FRAMESIZE * 2 = 320 bytes (int16 LE)
 */
#define WIRE_AUDIO_SAMPLES  160
#define WIRE_AUDIO_BYTES    320

/* ──────────────────────────────────────────────────────────────────────
 * Message types
 *
 * Values 0x01–0x0F: audio-channel types
 * Values 0x10–0x1F: control-channel types
 * Values 0x20+:     reserved for future use
 *
 * Every type is either host-originated, guest-originated, or both —
 * documented inline. Receivers should silently ignore messages arriving
 * in the "wrong" direction (defensive, makes fuzzing safer).
 * ────────────────────────────────────────────────────────────────────── */

/*
 * WIRE_TYPE_AUDIO — 0x01 — both directions, audio channel.
 *
 * Payload: exactly WIRE_AUDIO_BYTES (320) bytes of int16 little-endian
 * PCM, 8 kHz, one 20 ms frame. Any other payload length is a protocol
 * error; receivers should log and drop.
 *
 * Cadence: sender emits one AUDIO message per 20 ms of audio. Both
 * sides must emit AUDIO (even silence) while the modem is active,
 * because slmodemd's DSP clock is driven by the RX audio stream —
 * stop feeding it audio and the DSP freezes.
 */
#define WIRE_TYPE_AUDIO          0x01

/*
 * WIRE_TYPE_SILENCE — 0x02 — both directions, audio channel.
 *
 * Payload: empty (length == 1 — just the type byte).
 * Semantically equivalent to WIRE_TYPE_AUDIO with 320 zero bytes.
 * An optimization to skip transmitting zero buffers; receivers must
 * treat as 160 zero samples and feed them to slmodemd / upstream
 * with the same timing as a real AUDIO frame.
 *
 * Optional: senders MAY always send AUDIO and never SILENCE. Receivers
 * MUST handle both.
 */
#define WIRE_TYPE_SILENCE        0x02

/*
 * WIRE_TYPE_HELLO — 0x10 — guest→host, control channel.
 *
 * Payload: ASCII text, no trailing NUL, format:
 *     "modemd-ctrl v<WIRE_VERSION> build=<build-id>"
 *
 * modemd-ctrl emits exactly one HELLO as its first message on the
 * control channel, immediately after opening the virtio-serial /
 * socket. The host uses HELLO reception as its "VM is ready" signal
 * and should not send any messages before receiving HELLO.
 *
 * Hosts MAY parse the version number out of the payload and refuse to
 * continue if they don't understand it.
 *
 */
#define WIRE_TYPE_HELLO          0x10

/*
 * WIRE_TYPE_AT — 0x11 — host→guest, control channel.
 *
 * Payload: AT command string, ASCII, NO trailing \r or \n. The shim
 * will append a \r when writing to the PTY (which is what slmodemd
 * expects).
 *
 * Example payloads: "AT", "ATI", "AT+MS=?", "ATA"
 *
 * Responses arrive asynchronously as one or more WIRE_TYPE_AT_RESPONSE
 * messages, typically ending with a line like "OK" or "ERROR" or a
 * WIRE_TYPE_MODEM_STATUS event.
 */
#define WIRE_TYPE_AT             0x11

/*
 * WIRE_TYPE_AT_RESPONSE — 0x12 — guest→host, control channel.
 *
 * Payload: raw bytes read from the slmodemd PTY while the modem is
 * in command mode. The shim does NOT parse or line-buffer these —
 * it forwards bytes as they arrive. The host is expected to
 * accumulate and parse lines itself.
 *
 * A batch of AT_RESPONSE messages typically ends with either:
 *   - "\r\nOK\r\n" or "\r\nERROR\r\n"   (generic result codes)
 *   - a line like "CONNECT 33600\r\n"    (immediately followed by
 *     a MODEM_STATUS event and a switch to data-mode framing)
 *
 * The shim tracks PTY state and knows when the modem is in command
 * vs. data mode. Bytes arriving while in data mode are emitted as
 * DATA_RX instead.
 */
#define WIRE_TYPE_AT_RESPONSE    0x12

/*
 * WIRE_TYPE_MODEM_STATUS — 0x13 — guest→host, control channel.
 *
 * Payload: ASCII JSON object. Examples:
 *     {"event":"ring"}
 *     {"event":"connect","rate":33600,"protocol":"V34"}
 *     {"event":"nocarrier"}
 *     {"event":"error","code":"BUSY"}
 *
 * These are shim-side parsed events — the shim watches the PTY
 * output for known result-code patterns and emits structured events
 * for the host, so the host doesn't need to duplicate Hayes parsing.
 *
 * AT_RESPONSE is still sent for the raw bytes; MODEM_STATUS is an
 * additional structured event on top, emitted AFTER the triggering
 * line has been forwarded via AT_RESPONSE.
 */
#define WIRE_TYPE_MODEM_STATUS   0x13

/*
 * WIRE_TYPE_DATA_TX — 0x14 — host→guest, control channel.
 *
 * Payload: arbitrary bytes to send on the modem data path. Valid only
 * after CONNECT; shim writes these bytes directly to the PTY, which
 * slmodemd will modulate onto the audio stream. Before CONNECT,
 * DATA_TX is silently dropped (defensive; the host shouldn't send
 * data yet, but if it does we don't want to inject random junk into
 * the AT command stream).
 */
#define WIRE_TYPE_DATA_TX        0x14

/*
 * WIRE_TYPE_DATA_RX — 0x15 — guest→host, control channel.
 *
 * Payload: bytes received on the modem data path. Emitted by the shim
 * whenever PTY bytes arrive while the modem is in data mode (i.e.
 * between "CONNECT ..." and "NO CARRIER").
 */
#define WIRE_TYPE_DATA_RX        0x15

/*
 * WIRE_TYPE_HANGUP — 0x16 — host→guest, control channel.
 *
 * Payload: empty.
 * The shim sends "+++" (pause) "ATH\r" to the PTY to return to
 * command mode and hang up. The host should stop sending DATA_TX and
 * expect a NO CARRIER MODEM_STATUS event shortly thereafter.
 */
#define WIRE_TYPE_HANGUP         0x16

/*
 * WIRE_TYPE_DUMP_REQUEST — 0x17 — host→guest, control channel.
 *
 * Payload: empty.
 *
 * Asks the shim to emit the slmodemd audio-pipeline dump files
 * (written to /tmp/modem_rx_8k.raw, /tmp/modem_rx.raw, /tmp/modem_tx.raw
 * by slmodemd with modem_main.c's rx_dump/tx_dump hooks) back to the
 * host for offline comparison with Node's Capture-side WAV files.
 *
 * Diagnostic-only. Call from the host BEFORE stopping the backend, so
 * the VM is still alive and slmodemd has stopped writing. Emitted in
 * response: zero or more DUMP_DATA frames, then one DUMP_DONE.
 */
#define WIRE_TYPE_DUMP_REQUEST   0x17

/*
 * WIRE_TYPE_DUMP_DATA — 0x18 — guest→host, control channel.
 *
 * Payload layout:
 *   u8  name_len
 *   u8  name[name_len]   (ASCII, no NUL)
 *   u8  data[paylen - 1 - name_len]   (raw bytes as stored in the file)
 *
 * A single dump file may span many DUMP_DATA frames — all frames with
 * the same name concatenate in arrival order. Frame payload size is
 * bounded by WIRE_MAX_PAYLOAD - name_len - 1 (so ~8 KiB of file data
 * per frame in practice).
 */
#define WIRE_TYPE_DUMP_DATA      0x18

/*
 * WIRE_TYPE_DUMP_DONE — 0x19 — guest→host, control channel.
 *
 * Payload: empty. Signals "all dump files have been emitted in full".
 * Host should resolve the pending captureAudioDumps() promise on this.
 */
#define WIRE_TYPE_DUMP_DONE      0x19

/* ──────────────────────────────────────────────────────────────────────
 * Inline encode/decode helpers.
 *
 * These are static-inline so wire.h can be included in multiple
 * translation units without link-time duplicate symbols. Keep them
 * trivial — real parsing logic (stateful, accumulates partial reads)
 * lives in the caller, not here.
 * ────────────────────────────────────────────────────────────────────── */

/*
 * Write a 3-byte frame header into `out`. `paylen` is the payload size
 * (0 for type-only messages). The `length` field written equals
 * paylen+1 (includes the type byte, as documented above).
 *
 * Caller must ensure paylen <= WIRE_MAX_PAYLOAD.
 */
static inline void wire_encode_header(uint8_t *out, uint8_t type, uint16_t paylen) {
    uint16_t len = (uint16_t)(paylen + 1);
    out[0] = (uint8_t)(len & 0xFF);
    out[1] = (uint8_t)((len >> 8) & 0xFF);
    out[2] = type;
}

/*
 * Parse a 3-byte frame header from `in`, writing type and payload size
 * to the out-params. Returns the payload size for convenience.
 * Returns 0 and leaves *type_out untouched on malformed input
 * (length field == 0, which would imply no type byte).
 */
static inline uint16_t wire_decode_header(const uint8_t *in, uint8_t *type_out) {
    uint16_t len = (uint16_t)in[0] | ((uint16_t)in[1] << 8);
    if (len == 0) return 0;
    *type_out = in[2];
    return (uint16_t)(len - 1);
}

#endif /* SYNTHMODEM_WIRE_H */
