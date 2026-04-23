/*
 * modemd-shim.c — glue between slmodemd and the synthmodem Node host
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ROLE IN THE OVERALL ARCHITECTURE
 *
 *   Host (Node)                   This process                   slmodemd
 *   ───────────              ─────────────────────           ───────────
 *   SlmodemVM.js    <──────>  modemd-shim  <──────>          slmodemd
 *      (audio)     wire proto   (this file)   socketpair        (PTY)
 *      (control)   over 2 unix   (impedance    + PTY           (audio)
 *                  sockets or    matching)
 *                  virtio-serial
 *
 *   modemd-shim speaks our stable length-prefixed wire protocol (see
 *   wire.h) on one side, and slmodemd's native interfaces (socketpair
 *   audio frames + PTY AT/data bytes) on the other. All knowledge of
 *   slmodemd's internal framing lives here; the host and the VM boundary
 *   only ever see our clean wire protocol.
 *
 *   slmodemd invokes this program via its `-e <path>` flag. At modem
 *   start, slmodemd creates:
 *     - a socketpair for audio (SOCK_STREAM)
 *     - a socketpair for SIP/info (SOCK_DGRAM) -- unused by us, just
 *       kept open so slmodemd's writes don't EPIPE
 *   then fork()s and execv()s us with:
 *     argv[0] = our path
 *     argv[1] = dial string (or empty)
 *     argv[2] = audio socket fd (ASCII decimal)
 *     argv[3] = SIP info socket fd (ASCII decimal)
 *
 *   slmodemd also maintains a PTY (/dev/ttySL0 by default) for the AT
 *   command interface. The shim opens that PTY directly — it's the same
 *   PTY an end-user would connect a serial terminal to.
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * CONFIGURATION (via environment, so the same binary works in M1 and M2):
 *
 *   SYNTHMODEM_AUDIO_PATH   Host-side path (M1) or /dev/vport0p1 (M2) —
 *                           the Unix socket / virtio-serial device for
 *                           the audio channel. REQUIRED.
 *
 *   SYNTHMODEM_CONTROL_PATH Likewise for the control channel. REQUIRED.
 *
 *   SYNTHMODEM_PTY_PATH     Path to slmodemd's PTY. Defaults to
 *                           /dev/ttySL0. Override for testing.
 *
 *   SYNTHMODEM_BUILD_ID     Short string embedded in the HELLO message.
 *                           Defaults to "unknown".
 *
 *   SYNTHMODEM_LOG_LEVEL    "error" (default), "info", or "debug".
 *                           Logs go to stderr (slmodemd redirects to
 *                           syslog/console in the VM).
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * IMPLEMENTATION NOTES
 *
 *   - Single-threaded, poll()-based. No threads, no async. The workload
 *     is tiny (16 kB/sec each direction), a single poll loop suffices.
 *   - All writes are "best effort, log-and-continue" — we never want the
 *     shim to crash and cause slmodemd to stop receiving audio. If the
 *     host socket dies, we log and keep slmodemd alive so that it will
 *     eventually hit its own audio timeout and return to idle.
 *   - The wire framer is deliberately hand-rolled and tiny. No external
 *     deps beyond libc.
 *   - Written to be ABI-compatible with 32-bit i386 (slmodemd's world)
 *     AND 64-bit x86_64 (M1 dev machines). Use fixed-width types only.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "wire.h"

/* slmodemd's native socket framing. We use struct socket_frame on the
 * slm_audio and slm_sip socketpairs. This header is vendored from
 * the upstream slmodemd source; do not modify. */
#include "modem.h"

/* ──────────────────────────────────────────────────────────────────────
 * Tiny bespoke integer parsers.
 *
 * Why: atoi/strtol/sscanf on modern Ubuntu (gcc 13 + glibc 2.39)
 * silently redirect to __isoc23_* variants via header-level macros,
 * regardless of -std=gnu99 / -U__GLIBC_USE_C23_STRTOL / etc. That
 * adds a GLIBC_2.38 symbol dependency that breaks at load time inside
 * our VM, which ships glibc 2.36.
 *
 * These helpers give us deterministic, standards-free parsers with
 * zero libc-version surface, which is exactly what a cross-distro
 * binary wants.
 *
 * Both return 0 on non-numeric input — the callers already treat
 * zero as "couldn't parse" / default, so no extra error-path work.
 * ────────────────────────────────────────────────────────────────── */

/* Parse a decimal integer from a NUL-terminated string, stopping at
 * the first non-digit. Used where atoi() would otherwise appear. */
static int parse_dec_int(const char *s) {
    if (!s) return 0;
    while (*s == ' ' || *s == '\t') s++;
    int sign = 1;
    if (*s == '-') { sign = -1; s++; }
    else if (*s == '+') { s++; }
    long v = 0;
    while (*s >= '0' && *s <= '9') {
        v = v * 10 + (*s - '0');
        s++;
    }
    return (int)(sign * v);
}

/* Scan from `s` for the first decimal integer and return it. Used
 * where sscanf("... %d", ...) would otherwise appear. */
static int parse_dec_int_scan(const char *s) {
    if (!s) return 0;
    while (*s && !(*s == '-' || (*s >= '0' && *s <= '9'))) s++;
    return parse_dec_int(s);
}

/* ──────────────────────────────────────────────────────────────────────
 * Logging
 * ────────────────────────────────────────────────────────────────────── */

enum log_level { LOG_ERROR = 0, LOG_INFO = 1, LOG_DEBUG = 2 };
static enum log_level g_log_level = LOG_ERROR;

static void log_msg(enum log_level lvl, const char *fmt, ...) {
    if (lvl > g_log_level) return;
    char tag;
    switch (lvl) {
        case LOG_ERROR: tag = 'E'; break;
        case LOG_INFO:  tag = 'I'; break;
        case LOG_DEBUG: tag = 'D'; break;
        default:        tag = '?'; break;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    fprintf(stderr, "[shim %c %lu.%03ld] ", tag,
            (unsigned long)ts.tv_sec, ts.tv_nsec / 1000000);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

#define LOGE(...) log_msg(LOG_ERROR, __VA_ARGS__)
#define LOGI(...) log_msg(LOG_INFO,  __VA_ARGS__)
#define LOGD(...) log_msg(LOG_DEBUG, __VA_ARGS__)

/* ──────────────────────────────────────────────────────────────────────
 * Global state
 *
 * Kept in a single struct so it's easy to reason about lifetimes and
 * to pass to helpers. Not a class — this is a single-instance program.
 * ────────────────────────────────────────────────────────────────────── */

struct shim_state {
    /* slmodemd's audio socketpair end (SOCK_STREAM). Full-duplex
     * slmodemd-native 320-byte int16LE frames, cadence ~50 Hz. */
    int slm_audio_fd;

    /* slmodemd's sip_info socketpair end (SOCK_DGRAM). Receives
     * null-terminated info strings from slmodemd (dial state etc).
     * We largely ignore these in M1; future work can forward them as
     * MODEM_STATUS events. Kept open to avoid EPIPE on slmodemd's side. */
    int slm_sip_fd;

    /* slmodemd's PTY — /dev/ttySL0 or similar. Opened O_RDWR O_NONBLOCK.
     * AT commands flow into here from the host; AT responses and (after
     * CONNECT) data come out. */
    int pty_fd;

    /* Host-facing audio socket. Unix stream on M1, virtio-serial char
     * device on M2. Bidirectional framed wire protocol. */
    int host_audio_fd;

    /* Host-facing control socket. Same medium as audio, different
     * logical channel. */
    int host_control_fd;

    /* Modem mode: false = AT command mode, true = data mode.
     * Flipped to true when we see "CONNECT" from the PTY; flipped back
     * on "NO CARRIER" or "OK" (after hangup). Affects how PTY bytes
     * are framed for the host (AT_RESPONSE vs DATA_RX). */
    bool data_mode;

    /* Accumulator for partial wire frames read from host_audio_fd and
     * host_control_fd. Framing is length-prefixed so we need to buffer
     * across read() calls. */
    uint8_t  audio_rx_buf[WIRE_MAX_PAYLOAD + WIRE_HEADER_SIZE];
    size_t   audio_rx_len;

    uint8_t  ctrl_rx_buf[WIRE_MAX_PAYLOAD + WIRE_HEADER_SIZE];
    size_t   ctrl_rx_len;

    /* Tail buffer for PTY output — we parse this for "CONNECT" and
     * "NO CARRIER" to drive data_mode transitions. Only used in
     * command mode. */
    char     pty_tail[128];
    size_t   pty_tail_len;

    /* ─── DSP pump lifecycle ────────────────────────────────────────
     *
     * We forward audio on arrival (see handle_host_audio_readable).
     * This boolean gates that: pre-ATA and post-HANGUP, incoming
     * audio is dropped because slmodemd isn't reading. During a
     * call, writes pass straight through.
     *
     * Rationale for NOT pacing writes: slmodemd's DSP handshake
     * training is highly intolerant of frame drops or silence
     * substitutions. Any in-shim ring buffer with paced drain
     * caused overflow-on-burst + underrun-on-gap cycles that
     * corrupted the incoming modem signal enough to derail
     * DP_ESTAB. Node's RTP jitter buffer already absorbs network
     * jitter; making the shim its own cadence source on top of
     * that only inserts artifacts.
     *
     * Pacing, if needed, is done on the Node side (Clock Pump v2 in
     * SlmodemBackend.js). The shim stays dumb: forward on arrival. */
};

static struct shim_state S;

/* ──────────────────────────────────────────────────────────────────────
 * Wire protocol helpers
 *
 * Frame on the wire:
 *   u16 length (LE)  |  u8 type  |  payload[length - 1]
 *
 * `length` covers type + payload. A type-only message has length == 1.
 * ────────────────────────────────────────────────────────────────────── */

/*
 * Write a complete wire frame to fd. Returns 0 on success, -1 on error.
 * On partial write (e.g. signal interrupt), retries. Does NOT do
 * backpressure — caller is expected to have verified fd is writable or
 * to tolerate a short-term blocking write.
 *
 * Message flow is low bandwidth (< 20 KB/sec per direction) so blocking
 * writes are fine in practice.
 */
static int wire_write(int fd, uint8_t type, const void *payload, size_t len) {
    if (len > WIRE_MAX_PAYLOAD) {
        LOGE("wire_write: payload too large (%zu > %d)", len, WIRE_MAX_PAYLOAD);
        return -1;
    }
    uint8_t header[WIRE_HEADER_SIZE];
    uint16_t wlen = (uint16_t)(len + 1);  /* +1 for type byte */
    header[0] = (uint8_t)(wlen & 0xFF);
    header[1] = (uint8_t)((wlen >> 8) & 0xFF);
    header[2] = type;

    /* Use writev-like pattern but with two separate write()s for
     * simplicity — we accept that the stream is briefly in a
     * half-frame state between the two writes. That's safe because
     * we're the only writer on this fd. */
    size_t written = 0;
    while (written < WIRE_HEADER_SIZE) {
        ssize_t n = write(fd, header + written, WIRE_HEADER_SIZE - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGE("wire_write: header write failed: %s", strerror(errno));
            return -1;
        }
        written += (size_t)n;
    }
    written = 0;
    while (written < len) {
        ssize_t n = write(fd, (const uint8_t*)payload + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGE("wire_write: payload write failed: %s", strerror(errno));
            return -1;
        }
        written += (size_t)n;
    }
    return 0;
}

/*
 * Try to pull one complete frame out of `buf` (accumulated bytes).
 * Returns:
 *    0  = no complete frame yet, keep reading
 *    1  = one frame extracted; *type, payload, *plen set;
 *         buf has been memmove'd to discard the consumed frame
 *   -1  = framing error (length exceeds max); caller should close fd
 *
 * payload points into buf — valid until buf is next modified.
 */
static int wire_try_parse(uint8_t *buf, size_t *buf_len,
                          uint8_t *type, uint8_t **payload, size_t *plen) {
    if (*buf_len < WIRE_HEADER_SIZE) return 0;
    uint16_t wlen = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
    if (wlen < 1) {
        LOGE("wire_try_parse: length %u < 1 (framing error)", wlen);
        return -1;
    }
    if (wlen > WIRE_MAX_PAYLOAD + 1) {
        LOGE("wire_try_parse: length %u exceeds max payload", wlen);
        return -1;
    }
    size_t frame_size = WIRE_HEADER_SIZE + (wlen - 1);  /* wlen includes type */
    if (*buf_len < frame_size) return 0;  /* need more bytes */

    *type    = buf[2];
    *payload = buf + WIRE_HEADER_SIZE;
    *plen    = wlen - 1;

    /* Consume the frame from the buffer. */
    size_t remaining = *buf_len - frame_size;
    if (remaining > 0) memmove(buf, buf + frame_size, remaining);
    *buf_len = remaining;
    return 1;
}

/* ──────────────────────────────────────────────────────────────────────
 * Host-side transport opener
 *
 * In M1 the host paths are Unix domain sockets we connect() to.
 * In M2 they're virtio-serial character devices under
 * /dev/virtio-ports/ that we open() with read-write access.
 *
 * We detect which kind of path we've been given by stat()ing it and
 * checking the file type, so the same shim binary works in both
 * transports unchanged. This means moving from M1 to M2 is a
 * config-only change — no rebuild of the shim required.
 *
 * If the path doesn't exist yet (happens in M1 when the shim races
 * ahead of Node's listener setup), we fall back to treating it as
 * a Unix socket and retry connect() for up to 2 seconds, because
 * virtio-serial devices are always already present at boot.
 * ────────────────────────────────────────────────────────────────── */

static int open_host_path(const char *path) {
    /* Stat once up-front. Two outcomes:
     *   - exists and is a char device: open() it (M2 / virtio case)
     *   - exists and is a socket, OR doesn't exist yet: connect() (M1 case)
     *   - exists but is something else: reject
     */
    struct stat st;
    if (stat(path, &st) == 0) {
        if (S_ISCHR(st.st_mode)) {
            /* Virtio-serial device. Open read-write, non-blocking.
             * Virtio-serial is full-duplex on a single FD. */
            int fd = open(path, O_RDWR | O_NONBLOCK);
            if (fd < 0) {
                LOGE("open(%s): %s", path, strerror(errno));
                return -1;
            }
            LOGI("opened virtio-serial device %s", path);
            return fd;
        }
        if (!S_ISSOCK(st.st_mode)) {
            LOGE("%s exists but is neither a socket nor a char device", path);
            return -1;
        }
        /* Falls through to connect path. */
    } else if (errno != ENOENT) {
        LOGE("stat(%s): %s", path, strerror(errno));
        return -1;
    }

    /* Unix socket path (exists-as-socket or not-yet-created). */
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        LOGE("socket(AF_UNIX): %s", strerror(errno));
        return -1;
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) {
        LOGE("open_host_path: path too long: %s", path);
        close(fd);
        return -1;
    }
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    /* Connect with a few retries — in M1 the Node side may be starting
     * in parallel. In M2 we're in the virtio-serial branch above so
     * this loop doesn't execute in that case. */
    for (int attempt = 0; attempt < 20; attempt++) {
        if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) == 0) {
            LOGI("connected to %s", path);
            return fd;
        }
        if (errno != ENOENT && errno != ECONNREFUSED) {
            LOGE("connect(%s): %s", path, strerror(errno));
            close(fd);
            return -1;
        }
        struct timespec ts = { 0, 100 * 1000 * 1000 };  /* 100 ms */
        nanosleep(&ts, NULL);
    }
    LOGE("connect(%s): timed out waiting for peer", path);
    close(fd);
    return -1;
}

/* Back-compat alias — the original name used elsewhere in this file. */
static int unix_connect(const char *path) {
    return open_host_path(path);
}

/* ──────────────────────────────────────────────────────────────────────
 * PTY output scanner — drives command/data mode transitions
 *
 * We maintain a rolling tail of recent PTY bytes and scan for the
 * literal strings "CONNECT " and "NO CARRIER". When we see CONNECT,
 * we flip into data mode; when we see NO CARRIER, we flip back out.
 *
 * Kept deliberately simple. False positives are possible (e.g. if an
 * AT response contains those strings literally) but slmodemd only
 * emits them as actual result codes, and the host speaks a well-
 * defined AT dialect, so false positives are vanishingly unlikely
 * in practice.
 *
 * A MODEM_STATUS event is emitted to the host alongside the
 * transition, giving a structured signal the host can consume
 * without reinventing Hayes parsing.
 * ────────────────────────────────────────────────────────────────── */

static void pty_tail_append(const char *data, size_t n) {
    /* If the incoming chunk alone is bigger than the tail buffer,
     * just keep the last part of it. */
    if (n >= sizeof(S.pty_tail)) {
        memcpy(S.pty_tail, data + (n - sizeof(S.pty_tail) + 1),
               sizeof(S.pty_tail) - 1);
        S.pty_tail[sizeof(S.pty_tail) - 1] = '\0';
        S.pty_tail_len = sizeof(S.pty_tail) - 1;
        return;
    }
    /* Drop from the front if we'd overflow, then append. */
    if (S.pty_tail_len + n >= sizeof(S.pty_tail)) {
        size_t drop = S.pty_tail_len + n - (sizeof(S.pty_tail) - 1);
        memmove(S.pty_tail, S.pty_tail + drop, S.pty_tail_len - drop);
        S.pty_tail_len -= drop;
    }
    memcpy(S.pty_tail + S.pty_tail_len, data, n);
    S.pty_tail_len += n;
    S.pty_tail[S.pty_tail_len] = '\0';
}

static void pty_scan_for_transitions(void) {
    /* NO CARRIER: slmodemd emits this on carrier loss (peer hung up,
     * handshake failed, etc.) in EITHER command or data mode. It's the
     * reliable "call is no longer active" signal. Stop the DSP clock
     * pump here — slmodemd will cease reading its audio socketpair on
     * its next select iteration (m->started flips false), so continued
     * writes would just pile up in the kernel buffer. */
    {
        const char *nc = strstr(S.pty_tail, "NO CARRIER");
        if (nc) {
            LOGI("NO CARRIER detected");
            if (S.data_mode) S.data_mode = false;
            /* Emit a status event so the host backend knows too,
             * even in data mode where no AT_RESPONSE gets forwarded. */
            const char *json = "{\"event\":\"nocarrier\"}";
            wire_write(S.host_control_fd, WIRE_TYPE_MODEM_STATUS,
                       json, strlen(json));
            S.pty_tail_len = 0;
            S.pty_tail[0] = '\0';
            return;
        }
    }

    /* Look for CONNECT. slmodemd emits "CONNECT <rate>\r\n" on success. */
    if (!S.data_mode) {
        const char *hit = strstr(S.pty_tail, "CONNECT");
        if (hit) {
            int rate = 0;
            /* slmodemd's PTY output format is literally "CONNECT <rate>".
             * Skip past the word and parse the number ourselves (see
             * parse_dec_int_scan for why not sscanf). */
            const char *after = hit + sizeof("CONNECT") - 1;
            rate = parse_dec_int_scan(after);
            char json[96];
            int jl = snprintf(json, sizeof(json),
                "{\"event\":\"connect\",\"rate\":%d}", rate);
            if (jl > 0 && (size_t)jl < sizeof(json)) {
                wire_write(S.host_control_fd, WIRE_TYPE_MODEM_STATUS,
                           json, (size_t)jl);
            }
            LOGI("CONNECT detected (rate=%d) — entering data mode", rate);
            S.data_mode = true;
            S.pty_tail_len = 0;  /* reset scanner */
            S.pty_tail[0] = '\0';
            return;
        }
        /* Other interesting command-mode events — pass through as
         * structured status for the host's convenience. */
        const char *evt = NULL;
        if (strstr(S.pty_tail, "RING"))        evt = "ring";
        else if (strstr(S.pty_tail, "BUSY"))   evt = "busy";
        else if (strstr(S.pty_tail, "NO DIALTONE")) evt = "nodialtone";
        if (evt) {
            char json[64];
            int jl = snprintf(json, sizeof(json), "{\"event\":\"%s\"}", evt);
            if (jl > 0 && (size_t)jl < sizeof(json)) {
                wire_write(S.host_control_fd, WIRE_TYPE_MODEM_STATUS,
                           json, (size_t)jl);
            }
            /* don't reset tail — allow multiple detections */
        }
    } else {
        /* In data mode, we don't scan the tail for anything; we only
         * exit data mode when the host issues HANGUP or when slmodemd
         * itself closes the PTY side (handled elsewhere). */
    }
}

/* ──────────────────────────────────────────────────────────────────────
 * Per-fd handlers
 *
 * Each returns 0 on success (keep running), -1 on unrecoverable error
 * (main loop will exit). Host-side socket errors log and close but
 * don't kill the process — we want slmodemd to stay alive so the
 * next invocation can reuse it.
 * ────────────────────────────────────────────────────────────────── */

/* Handle data readable from slmodemd's audio socket. Each read gives
 * us one or more 320-byte PCM16 frames; we wrap each into a
 * WIRE_TYPE_AUDIO message and forward to host. */
static int handle_slm_audio_readable(void) {
    /*
     * slmodemd writes struct socket_frame units on this socket. Each
     * frame is sizeof(struct socket_frame) bytes (currently 324 on
     * x86_64 / 320+4 on i386; the union is size-dominated by the
     * 320-byte audio buffer plus a 4-byte type tag).
     *
     * On SOCK_STREAM there's no guarantee one read() returns exactly
     * one frame — the kernel may coalesce (we've empirically seen 2
     * frames in a single read during startup) or fragment. We use a
     * persistent staging buffer + whole-struct parser.
     *
     * The struct layout is FIXED for a given ABI because the shim
     * and slmodemd are always built with the same compiler for the
     * same target (both i386 in the VM case, both x86_64 on M1 dev
     * boxes). Mismatch across the VM boundary is what wire.h exists
     * to prevent; here on the slmodemd side it's a non-issue.
     */
    static uint8_t  stage[sizeof(struct socket_frame) * 8];
    static size_t   stage_len = 0;

    if (stage_len >= sizeof(stage)) {
        LOGE("slm_audio stage buffer full (framing desync?)");
        return -1;
    }
    ssize_t n = read(S.slm_audio_fd, stage + stage_len, sizeof(stage) - stage_len);
    if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        LOGE("read(slm_audio): %s", strerror(errno));
        return -1;
    }
    if (n == 0) {
        LOGI("slm_audio closed by slmodemd");
        return -1;
    }
    stage_len += (size_t)n;

    /* Extract whole struct socket_frame units. */
    size_t off = 0;
    while (off + sizeof(struct socket_frame) <= stage_len) {
        const struct socket_frame *sf =
            (const struct socket_frame *)(stage + off);
        off += sizeof(struct socket_frame);

        switch (sf->type) {
        case SOCKET_FRAME_AUDIO: {
            /* Forward the 320-byte PCM payload as a wire-framed AUDIO
             * message to the host. Apply the SILENCE optimization when
             * the entire buffer is zero. */
            const uint8_t *buf = (const uint8_t *)sf->data.audio.buf;
            int silent = 1;
            for (int i = 0; i < WIRE_AUDIO_BYTES; i++) {
                if (buf[i] != 0) { silent = 0; break; }
            }
            if (silent) {
                if (wire_write(S.host_audio_fd, WIRE_TYPE_SILENCE, NULL, 0) < 0) {
                    LOGE("wire_write silence failed");
                    return 0;
                }
            } else {
                if (wire_write(S.host_audio_fd, WIRE_TYPE_AUDIO,
                               buf, WIRE_AUDIO_BYTES) < 0) {
                    LOGE("wire_write audio failed");
                    return 0;
                }
            }
            break;
        }
        case SOCKET_FRAME_VOLUME:
            /* Informational: the modem-side volume setting. Log for
             * debugging; not forwarded to the host in M1. */
            LOGD("slm_audio VOLUME: value=%d", sf->data.volume.value);
            break;
        case SOCKET_FRAME_SIP_INFO:
            /* Unusual on the AUDIO socketpair (those come on sip_fd)
             * but handle gracefully if encountered. */
            LOGD("slm_audio unexpected SIP_INFO: '%.255s'", sf->data.sip.info);
            break;
        default:
            LOGE("slm_audio unknown socket_frame type %d — dropping", (int)sf->type);
            break;
        }
    }

    /* Compact any residual partial frame to the front of the stage. */
    if (off > 0) {
        if (off < stage_len) {
            memmove(stage, stage + off, stage_len - off);
        }
        stage_len -= off;
    }
    return 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * DSP clock pump
 *
 * D-Modem pattern: write to slmodemd at EXACTLY 20ms cadence, driven by
 * our own timerfd rather than by wire-audio arrival timing. When real
 * audio is queued, send it; when queue is empty, send a zero-filled
 * silence frame. The cadence itself is what slmodemd's DSP needs — a
 * single 20ms silence gap is far less damaging than cadence drift or
 * missed ticks.
 *
 * The queue is a small ring buffer (AUDIO_OUT_DEPTH frames). We never
 * re-deliver the same frame (no dup) and never skip a tick (no cadence
 * drift). Incoming wire audio only populates this queue; writes to
 * slmodemd only happen from the tick handler.
 * ────────────────────────────────────────────────────────────────────── */

/* Pacing of writes to slmodemd (if needed) lives on the Node side
 * in SlmodemBackend's Clock Pump v2. The shim forwards on arrival;
 * Node is the clock master. */


/* Handle data readable from host audio socket. Parse wire frames
 * and forward directly to slmodemd's audio socketpair (one write
 * per arrival). No in-shim pacing — Node's RTP jitter buffer is
 * the cadence source. See the DSP pump lifecycle comment block
 * above for why we don't pace here. */
static int handle_host_audio_readable(void) {
    /* Explicit range check so GCC's FORTIFY can see the read() size is
     * bounded by the buffer capacity. Without this, the unsigned
     * subtraction `sizeof(buf) - len` has no upper bound as far as the
     * static analyzer is concerned. */
    if (S.audio_rx_len >= sizeof(S.audio_rx_buf)) {
        LOGE("host_audio rx buffer full (framing desync?)");
        return -1;
    }
    size_t space = sizeof(S.audio_rx_buf) - S.audio_rx_len;
    ssize_t n = read(S.host_audio_fd, S.audio_rx_buf + S.audio_rx_len, space);
    if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        LOGE("read(host_audio): %s", strerror(errno));
        return -1;
    }
    if (n == 0) {
        LOGI("host_audio closed by host");
        return -1;
    }
    S.audio_rx_len += (size_t)n;

    /*
     * Per-5s telemetry. Numbers to interpret:
     *   - `writes`:    real audio frames forwarded to slmodemd.
     *   - `silences`:  silence frames forwarded (from WIRE_TYPE_SILENCE
     *                  host messages — should be 0 in steady state).
     *   - `dropped`:   arrivals discarded because pump is dormant
     *                  (no active call). Should be 0 during a call.
     *   - `slm_backlog`: kernel socketpair bytes waiting for slmodemd
     *                    (TIOCOUTQ). Should stay near 0 during a
     *                    call — slmodemd reads in cadence with its
     *                    DSP. A growing backlog means slmodemd isn't
     *                    keeping up (problem) or we're writing before
     *                    it's started reading (bug).
     * Expected steady-state during a call: writes≈250/5s (50 fps),
     * silences≈0, dropped=0, backlog≈0.
     */
    static uint32_t fwd_writes    = 0;
    static uint32_t fwd_silences  = 0;
    static time_t   last_stats_sec = 0;
    time_t now_s = time(NULL);
    if (last_stats_sec == 0) last_stats_sec = now_s;
    if (now_s - last_stats_sec >= 5) {
        int backlog = -1;
        ioctl(S.slm_audio_fd, TIOCOUTQ, &backlog);
        LOGI("audio fwd: %us  writes=%u  silences=%u  slm_backlog=%d",
             (unsigned)(now_s - last_stats_sec),
             fwd_writes, fwd_silences, backlog);
        fwd_writes = fwd_silences = 0;
        last_stats_sec = now_s;
    }

    /* Forward each arriving wire audio frame straight to slmodemd
     * while the pump is active. This mirrors D-Modem's dmodem_put_frame
     * pattern: write on every upstream-initiated call, no pacing.
     * Upstream (Node's RTP jitter buffer) is the cadence source; its
     * drain rate drives our write rate, and that's intentional.
     *
     * Why no in-shim pacing: slmodemd's DSP training is highly
     * intolerant of frame drops or silence substitutions during
     * handshake. A tiny ring buffer with tick-paced drain (as
     * previously tried) dropped frames on bursts and filled gaps
     * with silence, both of which corrupted the incoming signal
     * enough to derail DP_ESTAB. Straight forward-on-arrival matches
     * the behavior that achieved 100% handshake success. */
    for (;;) {
        uint8_t  type;
        uint8_t *payload;
        size_t   plen;
        int r = wire_try_parse(S.audio_rx_buf, &S.audio_rx_len,
                               &type, &payload, &plen);
        if (r == 0) break;           /* need more bytes */
        if (r < 0) return -1;        /* framing error */

        /* Wrap in struct socket_frame before forwarding. slmodemd's
         * socketpair read path expects whole struct socket_frame
         * units with a type tag. */
        struct socket_frame sf;
        memset(&sf, 0, sizeof(sf));
        sf.type = SOCKET_FRAME_AUDIO;

        if (type == WIRE_TYPE_AUDIO) {
            if (plen != WIRE_AUDIO_BYTES) {
                LOGE("host AUDIO frame has %zu bytes, expected %d",
                     plen, WIRE_AUDIO_BYTES);
                continue;  /* drop */
            }
            memcpy(sf.data.audio.buf, payload, WIRE_AUDIO_BYTES);
            fwd_writes++;
        } else if (type == WIRE_TYPE_SILENCE) {
            /* data.audio.buf already zero-filled by memset. */
            fwd_silences++;
        } else {
            LOGD("host_audio: ignoring unknown type 0x%02x", type);
            continue;  /* skip write */
        }

        /* Forward to slmodemd. Errors here are logged but not fatal;
         * a lost frame at 50 fps is a blip, and bailing out kills the
         * call. If EAGAIN happens the kernel socketpair buffer is
         * full, which would only happen if slmodemd had stalled
         * hard. */
        ssize_t w = write(S.slm_audio_fd, &sf, sizeof(sf));
        if (w < 0) {
            if (errno != EAGAIN) {
                LOGE("write(slm_audio): %s", strerror(errno));
            }
        } else if ((size_t)w != sizeof(sf)) {
            LOGE("short write to slm_audio: %zd of %zu bytes",
                 w, sizeof(sf));
        }
    }
    return 0;
}

/* Handle data readable from the PTY (i.e. slmodemd output to the
 * modem's AT user). In command mode, forward as AT_RESPONSE and scan
 * for state transitions. In data mode, forward as DATA_RX. */
static int handle_pty_readable(void) {
    uint8_t buf[512];
    ssize_t n = read(S.pty_fd, buf, sizeof(buf));
    if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        if (errno == EIO) {
            /* Classic PTY "other end closed" on Linux — slmodemd
             * recreated the PTY or hasn't opened its end yet.
             * Sleep briefly and return to the poll loop; next iteration
             * will try again. */
            struct timespec ts = { 0, 50 * 1000 * 1000 };
            nanosleep(&ts, NULL);
            return 0;
        }
        LOGE("read(pty): %s", strerror(errno));
        return -1;
    }
    if (n == 0) return 0;

    uint8_t wire_type = S.data_mode ? WIRE_TYPE_DATA_RX : WIRE_TYPE_AT_RESPONSE;
    wire_write(S.host_control_fd, wire_type, buf, (size_t)n);

    if (!S.data_mode) {
        pty_tail_append((const char*)buf, (size_t)n);
        pty_scan_for_transitions();
    }
    return 0;
}

/*
 * Emit the contents of an slmodemd audio dump file as a series of
 * WIRE_TYPE_DUMP_DATA frames on the host control socket.
 *
 * Payload of each DUMP_DATA frame:
 *    u8  name_len
 *    u8  name[name_len]      basename (not full path)
 *    u8  chunk[paylen - 1 - name_len]   up to ~4 KiB per frame
 *
 * Returns 0 on success, -1 on any I/O error (will be logged). An empty
 * or missing file is treated as success (zero DUMP_DATA frames emitted
 * for that name). This is intentional: diagnostic code shouldn't abort
 * cleanup on a missing dump file.
 */
static int emit_dump_file(const char *path, const char *name) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        LOGI("dump: %s not present (%s) — skipping", path, strerror(errno));
        return 0;
    }

    size_t name_len = strlen(name);
    if (name_len > 255 || name_len == 0) {
        LOGE("dump: bad name length for '%s'", name);
        close(fd);
        return -1;
    }

    /* Chunk size: leave room for name_len byte + name bytes under the
     * wire max payload, and round down to an even number so we never
     * split a PCM16 sample across frames (makes offline concat simpler). */
    size_t chunk_max = WIRE_MAX_PAYLOAD - 1 - name_len;
    if (chunk_max > 4000) chunk_max = 4000;
    chunk_max &= ~(size_t)1;   /* even */

    uint8_t frame_buf[WIRE_MAX_PAYLOAD];
    size_t total = 0;
    for (;;) {
        /* Layout payload in-place: [name_len][name][data...] */
        frame_buf[0] = (uint8_t)name_len;
        memcpy(frame_buf + 1, name, name_len);
        uint8_t *data = frame_buf + 1 + name_len;

        ssize_t n = read(fd, data, chunk_max);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGE("dump: read(%s): %s", path, strerror(errno));
            close(fd);
            return -1;
        }
        if (n == 0) break;   /* EOF */

        size_t plen = 1 + name_len + (size_t)n;
        if (wire_write(S.host_control_fd, WIRE_TYPE_DUMP_DATA,
                       frame_buf, plen) < 0) {
            close(fd);
            return -1;
        }
        total += (size_t)n;
    }

    close(fd);
    LOGI("dump: %s emitted (%zu bytes)", path, total);
    return 0;
}

/*
 * Handle WIRE_TYPE_DUMP_REQUEST from the host. Emit each dump file,
 * then a single DUMP_DONE to signal completion.
 *
 * Called from the control-channel switch below. slmodemd must have
 * stopped writing the dumps by the time this runs; the host gates the
 * request on hangup completion.
 */
static int handle_dump_request(void) {
    LOGI("dump: request received — emitting /tmp/modem_*.raw");

    if (emit_dump_file("/tmp/modem_rx_8k.raw", "modem_rx_8k.raw") < 0) goto done;
    if (emit_dump_file("/tmp/modem_rx.raw",    "modem_rx.raw")    < 0) goto done;
    if (emit_dump_file("/tmp/modem_tx.raw",    "modem_tx.raw")    < 0) goto done;

done:
    if (wire_write(S.host_control_fd, WIRE_TYPE_DUMP_DONE, NULL, 0) < 0) {
        LOGE("dump: failed to emit DUMP_DONE");
        return -1;
    }
    LOGI("dump: complete");
    return 0;
}

/* Handle data readable from host control socket: AT commands, DATA_TX,
 * HANGUP. */
static int handle_host_control_readable(void) {
    if (S.ctrl_rx_len >= sizeof(S.ctrl_rx_buf)) {
        LOGE("host_control rx buffer full");
        return -1;
    }
    size_t space = sizeof(S.ctrl_rx_buf) - S.ctrl_rx_len;
    ssize_t n = read(S.host_control_fd, S.ctrl_rx_buf + S.ctrl_rx_len, space);
    if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        LOGE("read(host_control): %s", strerror(errno));
        return -1;
    }
    if (n == 0) {
        LOGI("host_control closed by host");
        return -1;
    }
    S.ctrl_rx_len += (size_t)n;

    for (;;) {
        uint8_t  type;
        uint8_t *payload;
        size_t   plen;
        int r = wire_try_parse(S.ctrl_rx_buf, &S.ctrl_rx_len,
                               &type, &payload, &plen);
        if (r == 0) break;
        if (r < 0) return -1;

        switch (type) {
        case WIRE_TYPE_AT:
            /* Append \r and write to PTY. slmodemd expects \r-terminated
             * AT commands. We explicitly DON'T send \n too; that would
             * produce a spurious blank line that slmodemd interprets
             * as a second (empty) command. */
            LOGD("AT cmd: %.*s", (int)plen, (const char*)payload);

            /* Is this ATA? If so, it's the signal for slmodemd to go
             * into answer-state and begin consuming audio. This is our
             * analog of D-Modem's on_call_media_state → "Kicking off
             * audio!". Arm the DSP clock pump BEFORE writing the
             * command so slmodemd's first select() after m->started=1
             * sees our kick-off silence and begins its 50 fps clock
             * in phase with our ticks.
             *
             * Match "ATA" case-insensitively as a prefix, allowing the
             * trailing characters to be \r, \n, EOL, or end-of-payload.
             * Reject "ATAX...", "ATAT...", etc. — must be the ATA
             * command specifically. Also allow leading whitespace
             * that some clients insert. */
            {
                const char *p = (const char *)payload;
                size_t      n = plen;
                while (n > 0 && (*p == ' ' || *p == '\t')) { p++; n--; }
                if (n >= 3 &&
                    (p[0] == 'A' || p[0] == 'a') &&
                    (p[1] == 'T' || p[1] == 't') &&
                    (p[2] == 'A' || p[2] == 'a') &&
                    (n == 3 || p[3] == '\r' || p[3] == '\n' ||
                     p[3] == ' '  || p[3] == '\t')) {
                    LOGI("ATA detected");
                }
            }

            if (write(S.pty_fd, payload, plen) < 0 && errno != EIO) {
                LOGE("write(pty) AT: %s", strerror(errno));
            }
            {
                static const char cr = '\r';
                if (write(S.pty_fd, &cr, 1) < 0 && errno != EIO) {
                    LOGE("write(pty) CR: %s", strerror(errno));
                }
            }
            break;
        case WIRE_TYPE_DATA_TX:
            if (!S.data_mode) {
                LOGD("DATA_TX in command mode — dropping %zu bytes", plen);
                break;
            }
            if (write(S.pty_fd, payload, plen) < 0 && errno != EIO) {
                LOGE("write(pty) DATA_TX: %s", strerror(errno));
            }
            break;
        case WIRE_TYPE_HANGUP:
            /* +++ needs a guard time around it per Hayes spec, but for
             * our purposes the PTY is local and slmodemd handles the
             * escape sequence itself. Write +++ then ATH\r.
             * Errors here are not actionable — we've already committed
             * to hanging up and log-and-continue is the only sensible
             * response. */
            LOGI("HANGUP requested");
            {
                struct timespec guard = { 1, 100 * 1000 * 1000 };  /* 1.1 s */
                nanosleep(&guard, NULL);
                if (write(S.pty_fd, "+++", 3) < 0) {
                    LOGE("write(pty) +++: %s", strerror(errno));
                }
                nanosleep(&guard, NULL);
                if (write(S.pty_fd, "ATH\r", 4) < 0) {
                    LOGE("write(pty) ATH: %s", strerror(errno));
                }
            }
            /* data_mode will get flipped off when we see OK / NO CARRIER. */
            break;
        case WIRE_TYPE_DUMP_REQUEST:
            /* Diagnostic: the host is asking us to stream slmodemd's
             * internal audio dumps back. Best-effort; log and continue
             * on any error so a failed dump doesn't break the call
             * tear-down path. */
            if (handle_dump_request() < 0) {
                LOGE("dump: handler failed — aborting remaining cleanup");
            }
            break;
        default:
            LOGD("host_control: ignoring unknown type 0x%02x", type);
            break;
        }
    }
    return 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Signal handling
 *
 * slmodemd sends SIGTERM to its child on hangup. We exit cleanly so
 * slmodemd's wait() succeeds and it can re-fork us on the next call.
 * ────────────────────────────────────────────────────────────────── */

static volatile sig_atomic_t g_quit = 0;
static void sig_handler(int sig) {
    (void)sig;
    g_quit = 1;
}

/* ──────────────────────────────────────────────────────────────────────
 * Main
 * ────────────────────────────────────────────────────────────────── */

static void usage(const char *p) {
    fprintf(stderr,
        "Usage: %s <dialstr> <audio_fd> <sip_fd>\n"
        "\n"
        "Invoked by slmodemd via its -e flag. Not intended for\n"
        "direct invocation except during testing.\n"
        "\n"
        "Environment:\n"
        "  SYNTHMODEM_AUDIO_PATH    (required) host audio socket path\n"
        "  SYNTHMODEM_CONTROL_PATH  (required) host control socket path\n"
        "  SYNTHMODEM_PTY_PATH      slmodemd PTY (default /dev/ttySL0)\n"
        "  SYNTHMODEM_BUILD_ID      build id string for HELLO (default 'unknown')\n"
        "  SYNTHMODEM_LOG_LEVEL     error | info | debug (default error)\n",
        p);
}

int main(int argc, char *argv[]) {
    /* Configure logging from env BEFORE anything else emits logs. */
    {
        const char *lv = getenv("SYNTHMODEM_LOG_LEVEL");
        if (lv) {
            if (!strcmp(lv, "debug"))      g_log_level = LOG_DEBUG;
            else if (!strcmp(lv, "info"))  g_log_level = LOG_INFO;
            else                           g_log_level = LOG_ERROR;
        }
    }

    LOGI("modemd-shim starting (pid %d)", (int)getpid());

    /* Parse argv as slmodemd gives it to us. */
    if (argc != 4) {
        usage(argv[0]);
        return 2;
    }
    const char *dialstr = argv[1];
    S.slm_audio_fd = parse_dec_int(argv[2]);
    S.slm_sip_fd   = parse_dec_int(argv[3]);
    LOGI("dialstr='%s' audio_fd=%d sip_fd=%d",
         dialstr, S.slm_audio_fd, S.slm_sip_fd);

    /* Read env config. */
    const char *audio_path   = getenv("SYNTHMODEM_AUDIO_PATH");
    const char *control_path = getenv("SYNTHMODEM_CONTROL_PATH");
    const char *pty_path     = getenv("SYNTHMODEM_PTY_PATH");
    const char *build_id     = getenv("SYNTHMODEM_BUILD_ID");
    if (!audio_path || !control_path) {
        LOGE("SYNTHMODEM_AUDIO_PATH and SYNTHMODEM_CONTROL_PATH are required");
        return 2;
    }
    if (!pty_path)  pty_path  = "/dev/ttySL0";
    if (!build_id)  build_id  = "unknown";

    /* Wire up signal handling. */
    {
        struct sigaction sa = {0};
        sa.sa_handler = sig_handler;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGTERM, &sa, NULL);
        sigaction(SIGINT,  &sa, NULL);
        signal(SIGPIPE, SIG_IGN);
    }

    /* Connect to host sockets. */
    S.host_audio_fd   = unix_connect(audio_path);
    S.host_control_fd = unix_connect(control_path);
    if (S.host_audio_fd < 0 || S.host_control_fd < 0) {
        LOGE("failed to connect to host — giving up");
        return 1;
    }

    /* Open the PTY. O_NONBLOCK so EIO doesn't deadlock us if slmodemd
     * hasn't opened its end yet. */
    S.pty_fd = open(pty_path, O_RDWR | O_NONBLOCK);
    if (S.pty_fd < 0) {
        LOGE("open(%s): %s", pty_path, strerror(errno));
        /* Not fatal — carry on without AT; useful in testing. The
         * poll loop will simply never see PTY events. */
    } else {
        LOGI("opened PTY %s as fd %d", pty_path, S.pty_fd);
    }

    /* Set slmodemd audio fd non-blocking too. */
    fcntl(S.slm_audio_fd, F_SETFL,
          fcntl(S.slm_audio_fd, F_GETFL) | O_NONBLOCK);

    /* Send HELLO. */
    {
        char hello[128];
        int hl = snprintf(hello, sizeof(hello),
                          "modemd-shim v%d build=%s", WIRE_VERSION, build_id);
        if (hl > 0) {
            wire_write(S.host_control_fd, WIRE_TYPE_HELLO, hello, (size_t)hl);
            LOGI("sent HELLO: %s", hello);
        }
    }

    /* Main poll loop. */
    S.data_mode = false;
    S.audio_rx_len = 0;
    S.ctrl_rx_len = 0;
    S.pty_tail_len = 0;
    S.pty_tail[0] = '\0';

    while (!g_quit) {
        struct pollfd pfds[5];
        int nfds = 0;

        pfds[nfds].fd      = S.slm_audio_fd;
        pfds[nfds].events  = POLLIN;
        int idx_slm_audio = nfds++;

        pfds[nfds].fd      = S.host_audio_fd;
        pfds[nfds].events  = POLLIN;
        int idx_host_audio = nfds++;

        pfds[nfds].fd      = S.host_control_fd;
        pfds[nfds].events  = POLLIN;
        int idx_host_control = nfds++;

        int idx_pty = -1;
        if (S.pty_fd >= 0) {
            pfds[nfds].fd      = S.pty_fd;
            pfds[nfds].events  = POLLIN;
            idx_pty = nfds++;
        }

        int pr = poll(pfds, nfds, 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            LOGE("poll: %s", strerror(errno));
            break;
        }
        if (pr == 0) continue;

        /* Handle in a deterministic order. Audio path first so we
         * don't starve slmodemd's DSP under heavy control traffic. */
        if (pfds[idx_slm_audio].revents & (POLLIN|POLLHUP)) {
            if (handle_slm_audio_readable() < 0) break;
        }
        if (pfds[idx_host_audio].revents & (POLLIN|POLLHUP)) {
            if (handle_host_audio_readable() < 0) break;
        }
        if (pfds[idx_host_control].revents & (POLLIN|POLLHUP)) {
            if (handle_host_control_readable() < 0) break;
        }
        if (idx_pty >= 0 && (pfds[idx_pty].revents & (POLLIN|POLLHUP))) {
            if (handle_pty_readable() < 0) break;
        }
    }

    LOGI("modemd-shim exiting");
    if (S.pty_fd >= 0)        close(S.pty_fd);
    if (S.slm_audio_fd >= 0)  close(S.slm_audio_fd);
    if (S.slm_sip_fd >= 0)    close(S.slm_sip_fd);
    if (S.host_audio_fd >= 0) close(S.host_audio_fd);
    if (S.host_control_fd >= 0) close(S.host_control_fd);
    return 0;
}
