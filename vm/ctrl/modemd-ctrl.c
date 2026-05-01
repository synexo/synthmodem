/*
 * modemd-ctrl.c — PTY ↔ control-wire bridge for backend B.
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ROLE IN THE OVERALL ARCHITECTURE
 *
 *   Host (Node)                        This process              slmodemd
 *   ───────────                   ─────────────────────          ────────
 *   PjsipBackend    <────────>    modemd-ctrl    <────────>      slmodemd
 *      (control)   wire proto     (this file)    PTY read/write   (PTY)
 *                  over virtio-serial
 *
 *   The audio plane is handled entirely by d-modem.c (inside the same
 *   VM, via slmodemd's -e flag), which owns slmodemd's audio socketpair
 *   and does its own PJSIP/RTP work. modemd-ctrl stays out of the audio
 *   path completely.
 *
 *   This helper exists because d-modem.c doesn't expose the PTY back to
 *   the Node host — it's purely an audio adapter. For Node to drive AT
 *   commands and exchange data-mode bytes, we need a separate PTY<->wire
 *   bridge. That's modemd-ctrl.
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * CONFIGURATION (via environment):
 *
 *   SYNTHMODEM_CONTROL_PATH   Virtio-serial device (default environment)
 *                             or Unix socket path (tests). REQUIRED.
 *
 *   SYNTHMODEM_PTY_PATH       Path to slmodemd's PTY. Defaults to
 *                             /dev/ttySL0. Override for testing.
 *
 *   SYNTHMODEM_BUILD_ID       Short string embedded in the HELLO message.
 *                             Defaults to "unknown".
 *
 *   SYNTHMODEM_LOG_LEVEL      "error" (default), "info", or "debug".
 *                             Logs go to stderr.
 *
 * ═════════════════════════════════════════════════════════════════════════
 *
 * WIRE PROTOCOL
 *
 *   Uses the wire.h protocol defined alongside this file. Relevant frame
 *   types:
 *
 *     HELLO          sent once at startup, payload is build id
 *     AT             host → ctrl: write AT command to PTY
 *     AT_RESPONSE    ctrl → host: PTY output while in command mode
 *     MODEM_STATUS   ctrl → host: structured JSON event on transitions
 *                    {"event":"connect","rate":N} or
 *                    {"event":"nocarrier"}
 *     DATA_TX        host → ctrl: write data bytes to PTY (data mode)
 *     DATA_RX        ctrl → host: PTY output while in data mode
 *     HANGUP         host → ctrl: send +++/ATH escape to slmodemd
 *
 *   Data-mode transitions are line-aware: when ctrl detects "CONNECT"
 *   or "NO CARRIER" in the PTY byte stream we wait for the trailing
 *   \r\n that completes the line before emitting and flipping
 *   data_mode. This guarantees the entire transition line travels
 *   as a single AT_RESPONSE frame regardless of how slmodemd's
 *   write()s were chunked. Bytes BEFORE the keyword are still
 *   emitted immediately so keystroke latency is unaffected. See
 *   process_command_mode_bytes / process_data_mode_bytes for the
 *   full state machine.
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
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "wire.h"

/* ──────────────────────────────────────────────────────────────────────
 * Logging
 * ────────────────────────────────────────────────────────────────── */

enum log_level { LOG_ERROR = 0, LOG_INFO = 1, LOG_DEBUG = 2 };
static enum log_level g_log_level = LOG_ERROR;

static void log_msg(enum log_level lvl, const char *fmt, ...) {
    if (lvl > g_log_level) return;
    va_list ap;
    fprintf(stderr, "[ctrl %c] ",
            lvl == LOG_ERROR ? 'E' : lvl == LOG_INFO ? 'I' : 'D');
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

#define LOGE(...) log_msg(LOG_ERROR, __VA_ARGS__)
#define LOGI(...) log_msg(LOG_INFO,  __VA_ARGS__)
#define LOGD(...) log_msg(LOG_DEBUG, __VA_ARGS__)

/* ──────────────────────────────────────────────────────────────────────
 * State
 * ────────────────────────────────────────────────────────────────── */

struct ctrl_state {
    int pty_fd;             /* slmodemd's PTY (/dev/ttySL0 typically)  */
    int host_control_fd;    /* virtio-serial chardev or unix socket    */

    bool data_mode;         /* false = AT mode, true = data mode       */

    /* Accumulator for partial wire frames read from host_control_fd. */
    uint8_t ctrl_rx_buf[WIRE_MAX_PAYLOAD + WIRE_HEADER_SIZE];
    size_t  ctrl_rx_len;

    /* Pending PTY bytes that LOOK like the start of a transition
     * keyword (CONNECT / NO CARRIER) but haven't yet been confirmed
     * by the trailing \r\n. Held back from the wire so we can emit
     * the entire transition line atomically as AT_RESPONSE before
     * flipping data_mode. The wire_type these bytes WOULD have been
     * emitted as is recorded in pending_type so we know the right
     * type to use if it turns out NOT to be a real transition (e.g.
     * a glitch where slmodemd emitted "CONNECTED FOO" mid-data).
     *
     * Invariant: when pending_len > 0, we are NOT yet committed to
     * a data_mode flip. We commit only when (a) the keyword line
     * completes with \r\n — emit pending+new as AT_RESPONSE, flip;
     * or (b) the buffer fills past the longest transition keyword,
     * proving the prefix-match was a coincidence — emit pending as
     * pending_type, treat the bytes as ordinary. */
    uint8_t pending_buf[256];
    size_t  pending_len;
    uint8_t pending_type;
};

static struct ctrl_state S;

/* ──────────────────────────────────────────────────────────────────────
 * Shutdown signalling
 * ────────────────────────────────────────────────────────────────── */

static volatile sig_atomic_t g_quit = 0;
static void sig_handler(int sig) { (void)sig; g_quit = 1; }

/* ──────────────────────────────────────────────────────────────────────
 * Wire protocol helpers (wire_write / wire_try_parse). Kept local so
 * modemd-ctrl has no linker dependency on any sibling object file.
 * ────────────────────────────────────────────────────────────────── */

static int wire_write(int fd, uint8_t type, const void *payload, size_t len) {
    if (len > WIRE_MAX_PAYLOAD) {
        LOGE("wire_write: payload too large (%zu > %d)", len, WIRE_MAX_PAYLOAD);
        return -1;
    }
    uint8_t header[WIRE_HEADER_SIZE];
    wire_encode_header(header, type, (uint16_t)len);

    /* Two sequential write()s. This briefly leaves the stream in a
     * half-frame state between them, which is safe because we're the
     * only writer on this fd. */
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
        ssize_t n = write(fd, (const uint8_t *)payload + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGE("wire_write: payload write failed: %s", strerror(errno));
            return -1;
        }
        written += (size_t)n;
    }
    return 0;
}

/* Try to pull one complete frame out of `buf`. Returns 0 if more bytes
 * needed, 1 on success, -1 on protocol error. `payload` points inside
 * `buf` and remains valid only until the next call that modifies buf. */
static int wire_try_parse(uint8_t *buf, size_t *buf_len,
                          uint8_t *out_type, uint8_t **out_payload,
                          size_t *out_plen) {
    if (*buf_len < WIRE_HEADER_SIZE) return 0;
    uint8_t type = 0;
    uint16_t plen = wire_decode_header(buf, &type);
    if (plen > WIRE_MAX_PAYLOAD) {
        LOGE("wire_try_parse: oversize payload length %u", plen);
        return -1;
    }
    if (*buf_len < (size_t)WIRE_HEADER_SIZE + plen) return 0;
    *out_type    = type;
    *out_payload = buf + WIRE_HEADER_SIZE;
    *out_plen    = plen;
    size_t consumed = WIRE_HEADER_SIZE + plen;
    memmove(buf, buf + consumed, *buf_len - consumed);
    *buf_len -= consumed;
    return 1;
}

/* ──────────────────────────────────────────────────────────────────────
 * Transport open — opens either a Unix socket (tests) or a virtio-serial chardev (production).
 * Accepts a virtio-serial char device (open O_RDWR) or a Unix socket
 * (connect()).
 * ────────────────────────────────────────────────────────────────── */

static int open_host_path(const char *path) {
    /* Retry loop. On each attempt, stat the path and decide based
     * on what we see:
     *   - char device exists: open() it. Done.
     *   - socket exists: connect() to it. Done.
     *   - symlink to nonexistent target (ENOENT on stat follow):
     *     the target may appear in a moment — sleep and retry.
     *   - path doesn't exist at all (ENOENT): same — sleep and retry.
     *   - other stat error: propagate.
     *
     * The existing PTY use case for modemd-ctrl hits case 3: slmodemd
     * creates /tmp/ttySL0 as a symlink to /dev/pts/0, but slmodemd
     * hasn't forked yet when modemd-ctrl starts, so on the first
     * attempt the symlink either doesn't exist or points at nothing.
     * Once slmodemd is up, subsequent stats follow the symlink to
     * /dev/pts/0 (char device) and we take the open() branch.
     *
     * For unix-socket stand-ins (tests): the path starts out absent
     * and appears as a socket when the listener bind()s.
     *
     * Retry budget: 20 × 100 ms = 2 s. That's long enough to cover
     * slmodemd's startup jitter; empirically 100-300 ms.
     */
    for (int attempt = 0; attempt < 20; attempt++) {
        struct stat st;
        if (stat(path, &st) == 0) {
            if (S_ISCHR(st.st_mode)) {
                int fd = open(path, O_RDWR | O_NONBLOCK);
                if (fd < 0) {
                    LOGE("open(%s): %s", path, strerror(errno));
                    return -1;
                }
                LOGI("opened %s as char device (fd=%d)", path, fd);
                return fd;
            }
            if (S_ISSOCK(st.st_mode)) {
                int fd = socket(AF_UNIX, SOCK_STREAM, 0);
                if (fd < 0) {
                    LOGE("socket: %s", strerror(errno));
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
                if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
                    LOGI("connected to %s (fd=%d)", path, fd);
                    return fd;
                }
                if (errno != ENOENT && errno != ECONNREFUSED) {
                    LOGE("connect(%s): %s", path, strerror(errno));
                    close(fd);
                    return -1;
                }
                /* Socket exists but listener not ready — retry. */
                close(fd);
            } else {
                LOGE("%s exists but is neither a socket nor a char device",
                     path);
                return -1;
            }
        } else if (errno != ENOENT) {
            LOGE("stat(%s): %s", path, strerror(errno));
            return -1;
        }
        /* Path not there yet (or socket not accepting, or dangling
         * symlink). Sleep and try again. */
        struct timespec ts = { 0, 100 * 1000 * 1000 };
        nanosleep(&ts, NULL);
    }
    LOGE("open_host_path(%s): timed out after 20 attempts", path);
    return -1;
}

/* ──────────────────────────────────────────────────────────────────────
 * PTY transition detection — line-aware emit
 *
 * SLMODEMD'S PTY OUTPUT PATTERN
 *
 *   In command mode slmodemd emits responses like "RING\r\n",
 *   "CONNECT 21600\r\n", "NO CARRIER\r\n". Each response is several
 *   write() calls — typically the result-code text first, then the
 *   trailing "\r\n" in a separate write. Between those two write()s
 *   our read(pty) can complete with just the result-code text and
 *   no terminator, then a second read picks up the "\r\n".
 *
 *   For RING this is harmless — Node's RING detector matches by
 *   substring on the AT_RESPONSE event, not by line.
 *
 *   For CONNECT and NO CARRIER it MATTERS, because both also trigger
 *   data_mode transitions. The historical bug:
 *
 *     1. read(pty) returns "CONNECT" (no terminator)
 *     2. wire_type = data_mode ? DATA_RX : AT_RESPONSE = AT_RESPONSE
 *     3. emit "CONNECT" as AT_RESPONSE — Node's _ptyLineBuf has
 *        "CONNECT" but no \r\n so its line regex never fires
 *     4. scan_for_transitions sees "CONNECT" in tail, flips data_mode
 *     5. next read(pty) returns "\r\n", wire_type now = DATA_RX
 *     6. "\r\n" goes out as DATA_RX — Node's _ptyLineBuf still has
 *        "CONNECT" with no terminator
 *
 *   Net effect: Node is stuck waiting for a \r\n that will never
 *   arrive on AT_RESPONSE because it travelled as DATA_RX. The same
 *   shape applies symmetrically to NO CARRIER (the binary data
 *   inside data_mode includes the keyword bytes followed by binary,
 *   then "\r\n", and the keyword line never reaches Node intact).
 *
 *   Pre-VM-fix workaround on the Node side is the
 *   _maybeScheduleUnterminatedFlush 150ms debounce in PjsipBackend —
 *   when this code lands the workaround can be removed.
 *
 * THE FIX
 *
 *   When we detect a transition keyword in the new bytes, we want
 *   the entire transition LINE (keyword through \r\n) to travel as
 *   a single AT_RESPONSE frame, regardless of how slmodemd's writes
 *   were chunked. This requires deferring emit when we see a partial
 *   keyword: instead of emitting bytes immediately, we hold them in
 *   pending_buf until the line completes.
 *
 *   Three cases per chunk in command mode (data_mode == false):
 *
 *     A. No keyword anywhere in (pending + new) — emit everything as
 *        AT_RESPONSE. Common AT case (e.g. "OK\r\n").
 *
 *     B. Keyword + \r\n present — split: bytes before keyword =
 *        AT_RESPONSE (e.g. "\r\n"), bytes from keyword through \r\n
 *        = AT_RESPONSE (this IS the transition line), MODEM_STATUS
 *        is emitted, data_mode flips, bytes AFTER \r\n (rare, would
 *        be the start of data-mode V.42 LAPM frames) = DATA_RX.
 *
 *     C. Keyword present, no terminator yet — emit any prefix bytes
 *        BEFORE the keyword as AT_RESPONSE, hold the keyword tail
 *        and any subsequent bytes in pending_buf as AT_RESPONSE-
 *        pending. Next read appends to pending and re-evaluates.
 *
 *   In data_mode (== true), the only transition is NO CARRIER. We
 *   apply the same A/B/C logic but with DATA_RX as the prefix wire
 *   type:
 *
 *     A. No "NO CARRIER" — emit everything as DATA_RX.
 *
 *     B. "NO CARRIER" + \r\n present — emit pre-keyword bytes as
 *        DATA_RX (these are real keystrokes/V.42 frames), keyword
 *        through \r\n as AT_RESPONSE, MODEM_STATUS nocarrier,
 *        data_mode flips off, post-\r\n bytes as AT_RESPONSE.
 *
 *     C. Partial "NO CARRIER" — emit pre-keyword as DATA_RX, hold
 *        keyword tail as AT_RESPONSE-pending.
 *
 * BUFFER FILL DEFENSE
 *
 *   If pending_buf accumulates more than the longest plausible
 *   transition line ("CONNECT 33600\r\n" = 16 bytes; "NO CARRIER\r\n"
 *   = 12 bytes; pad to ~64 for any field-code variants), assume the
 *   prefix-match was a false alarm and emit pending as its declared
 *   type. The 256-byte pending_buf comfortably exceeds that.
 *
 * ────────────────────────────────────────────────────────────────── */

/* atoi-like helper that stops at the first non-digit. Used to parse
 * the rate from "CONNECT <rate>". */
static int parse_dec_int(const char *s, size_t max_len) {
    if (!s || !max_len) return 0;
    size_t i = 0;
    while (i < max_len && (s[i] == ' ' || s[i] == '\t')) i++;
    int sign = 1;
    if (i < max_len && s[i] == '-') { sign = -1; i++; }
    else if (i < max_len && s[i] == '+') { i++; }
    long v = 0;
    while (i < max_len && s[i] >= '0' && s[i] <= '9') {
        v = v * 10 + (s[i] - '0');
        i++;
    }
    return sign * (int)v;
}

/* Emit a MODEM_STATUS JSON event. Best-effort; failure is logged
 * but not fatal (the host will fall back to PTY-text parsing). */
static void emit_status_connect(int rate) {
    char json[96];
    int jl = snprintf(json, sizeof(json),
        "{\"event\":\"connect\",\"rate\":%d}", rate);
    if (jl > 0 && (size_t)jl < sizeof(json)) {
        wire_write(S.host_control_fd, WIRE_TYPE_MODEM_STATUS,
                   (const uint8_t *)json, (size_t)jl);
    }
}
static void emit_status_nocarrier(void) {
    static const char json[] = "{\"event\":\"nocarrier\"}";
    wire_write(S.host_control_fd, WIRE_TYPE_MODEM_STATUS,
               (const uint8_t *)json, sizeof(json) - 1);
}

/* Append `data[n]` to pending_buf. If full, emit pending as
 * pending_type and start fresh. */
static void pending_append(const uint8_t *data, size_t n, uint8_t type) {
    /* If we're appending bytes of a different type than what's
     * already pending, that's a logic bug — flush first to keep
     * type-correctness. */
    if (S.pending_len > 0 && S.pending_type != type) {
        wire_write(S.host_control_fd, S.pending_type,
                   S.pending_buf, S.pending_len);
        S.pending_len = 0;
    }
    S.pending_type = type;
    if (S.pending_len + n > sizeof(S.pending_buf)) {
        /* Defensive overflow: the prefix-match must have been a
         * coincidence (e.g. slmodemd emitted "CONNECTED" or some
         * non-Hayes string). Flush pending as its declared type and
         * accept the new bytes as the same type. */
        LOGD("pending_append: overflow (pending=%zu + new=%zu > %zu); flushing",
             S.pending_len, n, sizeof(S.pending_buf));
        wire_write(S.host_control_fd, S.pending_type,
                   S.pending_buf, S.pending_len);
        S.pending_len = 0;
    }
    if (n > sizeof(S.pending_buf)) {
        /* Single chunk bigger than the buffer; split. The first
         * (sizeof - 1) goes immediate, the rest into pending. */
        wire_write(S.host_control_fd, type, data, n - 1);
        S.pending_buf[0] = data[n - 1];
        S.pending_len    = 1;
        S.pending_type   = type;
        return;
    }
    memcpy(S.pending_buf + S.pending_len, data, n);
    S.pending_len += n;
}
static void pending_flush(void) {
    if (S.pending_len > 0) {
        wire_write(S.host_control_fd, S.pending_type,
                   S.pending_buf, S.pending_len);
        S.pending_len = 0;
    }
}

/* Find the smallest index `i` in [0..len] such that the bytes
 * `buf[i..len]` could be the start of `keyword`. That is, return
 * the position where, if we had MORE bytes appended, we MIGHT see a
 * complete keyword match. Used to decide what part of an incoming
 * chunk to defer (the partial-keyword tail) vs emit immediately
 * (everything before).
 *
 * Algorithm: try every prefix length p from min(klen-1, len) down
 * to 1; if buf ends with keyword[0..p], i = len - p. If no prefix
 * matches, return len (nothing to defer). */
static size_t partial_keyword_tail(const uint8_t *buf, size_t len,
                                   const char *keyword) {
    size_t klen = strlen(keyword);
    size_t maxp = klen - 1;
    if (maxp > len) maxp = len;
    for (size_t p = maxp; p > 0; p--) {
        if (memcmp(buf + len - p, keyword, p) == 0) {
            return len - p;
        }
    }
    return len;
}

/* Find the start index of `keyword` in `buf[0..len]` if present
 * fully. Returns SIZE_MAX if not found. */
static size_t find_keyword(const uint8_t *buf, size_t len,
                           const char *keyword) {
    size_t klen = strlen(keyword);
    if (klen == 0 || klen > len) return (size_t)-1;
    for (size_t i = 0; i + klen <= len; i++) {
        if (memcmp(buf + i, keyword, klen) == 0) return i;
    }
    return (size_t)-1;
}

/* Find the index of the first '\n' at or after `from`, with the
 * '\n' that terminates a "\r\n" pair preferred. Returns SIZE_MAX if
 * not found. The returned index is the '\n' itself, so the line
 * length including the terminator is (idx + 1 - line_start). */
static size_t find_lf_after(const uint8_t *buf, size_t len, size_t from) {
    for (size_t i = from; i < len; i++) {
        if (buf[i] == '\n') return i;
    }
    return (size_t)-1;
}

/* Process command-mode bytes: pending_buf + new chunk together
 * form a flat byte stream that may contain transitions. Emit as
 * appropriate, possibly leaving partial-keyword bytes pending.
 *
 * Strategy — process the combined buffer left to right:
 *   1. Look for "CONNECT" or "NO CARRIER" anywhere in [0..tot_len].
 *      (NO CARRIER takes precedence — slmodemd emits it on failed
 *      handshake even in command mode.)
 *   2. If keyword + \r\n found: split. Bytes before keyword go out
 *      as AT_RESPONSE prefix; keyword line goes out as AT_RESPONSE;
 *      MODEM_STATUS emitted; data_mode flips; remaining bytes go to
 *      DATA_RX (for CONNECT) or AT_RESPONSE (for NO CARRIER, which
 *      is followed by "OK" or another command-mode response).
 *   3. If keyword found but no terminator yet: emit bytes BEFORE
 *      keyword as AT_RESPONSE, save keyword + tail in pending_buf
 *      as AT_RESPONSE-pending.
 *   4. If no keyword and no partial-keyword at end: emit all as
 *      AT_RESPONSE.
 *   5. If no keyword found but new chunk's tail could be the start
 *      of one: emit prefix as AT_RESPONSE, save tail as pending.
 */
static void process_command_mode_bytes(const uint8_t *new_bytes, size_t n) {
    /* Combine pending + new into a working buffer. We can re-use
     * pending_buf by appending in place; total length is bounded
     * by pending_buf size since we flush on overflow. */
    if (S.pending_len > 0 && S.pending_type != WIRE_TYPE_AT_RESPONSE) {
        /* Pending bytes are of a different type — that's a logic
         * error in command mode (we should only ever defer
         * AT_RESPONSE bytes here). Flush them as their declared
         * type to be safe. */
        pending_flush();
    }
    /* Build combined working area on the stack to keep pending_buf
     * available for re-use during emit. Cap at pending_buf size
     * plus the largest single PTY read (512 bytes here). */
    uint8_t work[256 + 512 + 8];
    size_t  tot = 0;
    if (S.pending_len > 0) {
        memcpy(work, S.pending_buf, S.pending_len);
        tot = S.pending_len;
    }
    if (tot + n > sizeof(work)) {
        /* Should not happen — pending_buf is 256 and read is ≤ 512,
         * total ≤ 768 < sizeof(work). Defensive flush + truncate. */
        LOGE("process_command_mode_bytes: working buffer too small "
             "(pending=%zu + new=%zu); flushing pending and re-trying",
             S.pending_len, n);
        pending_flush();
        tot = 0;
    }
    memcpy(work + tot, new_bytes, n);
    tot += n;
    /* From here on, pending_buf is logically empty even if we don't
     * memset it — we'll repopulate any deferred bytes below. */
    S.pending_len = 0;

    /* Look for NO CARRIER first (takes precedence even in command
     * mode — slmodemd emits it on failed-handshake hangup). */
    size_t nc_idx = find_keyword(work, tot, "NO CARRIER");
    size_t cn_idx = (size_t)-1;
    if (nc_idx == (size_t)-1) {
        cn_idx = find_keyword(work, tot, "CONNECT");
    }

    if (nc_idx != (size_t)-1) {
        /* NO CARRIER is in the buffer. Need to find the line's \n
         * to know how much constitutes the transition. */
        size_t lf = find_lf_after(work, tot, nc_idx);
        if (lf == (size_t)-1) {
            /* Keyword present, no terminator yet. Emit prefix
             * (everything before "NO CARRIER") as AT_RESPONSE and
             * defer the keyword tail. */
            if (nc_idx > 0) {
                wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                           work, nc_idx);
            }
            pending_append(work + nc_idx, tot - nc_idx, WIRE_TYPE_AT_RESPONSE);
            return;
        }
        /* Have full "NO CARRIER ... \n" line. Emit one AT_RESPONSE
         * frame containing pre-keyword + the line itself, fire
         * status, flip data_mode (no-op if already command mode),
         * emit any trailing bytes as AT_RESPONSE (we're now firmly
         * in command mode). */
        wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                   work, lf + 1);
        emit_status_nocarrier();
        if (S.data_mode) {
            LOGI("transition: data_mode → command_mode (NO CARRIER)");
            S.data_mode = false;
        }
        if (lf + 1 < tot) {
            wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                       work + lf + 1, tot - (lf + 1));
        }
        return;
    }

    if (cn_idx != (size_t)-1) {
        /* CONNECT keyword. Find the line terminator. */
        size_t lf = find_lf_after(work, tot, cn_idx);
        if (lf == (size_t)-1) {
            /* Partial CONNECT: emit pre-keyword as AT_RESPONSE,
             * defer the rest. */
            if (cn_idx > 0) {
                wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                           work, cn_idx);
            }
            pending_append(work + cn_idx, tot - cn_idx, WIRE_TYPE_AT_RESPONSE);
            return;
        }
        /* Full "CONNECT[ <rate>]\n" line available. Parse rate,
         * emit AT_RESPONSE through the LF, fire MODEM_STATUS, flip
         * data_mode, emit remainder as DATA_RX. */
        size_t after_word = cn_idx + sizeof("CONNECT") - 1;
        int rate = 0;
        if (after_word < lf) {
            rate = parse_dec_int((const char *)(work + after_word),
                                 lf - after_word);
        }
        wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                   work, lf + 1);
        emit_status_connect(rate);
        LOGI("transition: command_mode → data_mode (CONNECT %d)", rate);
        S.data_mode = true;
        if (lf + 1 < tot) {
            /* Bytes after CONNECT line are V.42 LAPM data — DATA_RX. */
            wire_write(S.host_control_fd, WIRE_TYPE_DATA_RX,
                       work + lf + 1, tot - (lf + 1));
        }
        return;
    }

    /* No transition keyword anywhere in working buffer. Check for
     * partial keyword at the end so we don't emit bytes that might
     * be the start of one. The longest keyword is "NO CARRIER" =
     * 10 bytes; we defer up to 9 trailing bytes if they could match
     * the prefix of either keyword. */
    size_t defer_from = tot;
    size_t pk_nc = partial_keyword_tail(work, tot, "NO CARRIER");
    size_t pk_cn = partial_keyword_tail(work, tot, "CONNECT");
    if (pk_nc < defer_from) defer_from = pk_nc;
    if (pk_cn < defer_from) defer_from = pk_cn;

    if (defer_from > 0) {
        wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                   work, defer_from);
    }
    if (defer_from < tot) {
        pending_append(work + defer_from, tot - defer_from,
                       WIRE_TYPE_AT_RESPONSE);
    }
}

/* Process data-mode bytes: similar logic, but only NO CARRIER
 * triggers a transition. Pre-keyword bytes are DATA_RX (real V.42
 * frames / keystrokes); the keyword line itself is AT_RESPONSE
 * (command-mode terminology); post-line is AT_RESPONSE.
 *
 * This is the asymmetric direction: in data mode we want zero
 * latency on real bytes (keystrokes). The deferral only happens
 * for the trailing bytes that LOOK like the start of "NO CARRIER".
 * Worst case we delay ≤ 9 bytes by one PTY read cycle, which is a
 * few ms — well under the keystroke perception threshold. */
static void process_data_mode_bytes(const uint8_t *new_bytes, size_t n) {
    /* If pending_buf has bytes from a previous data-mode partial
     * keyword detection, they were declared AT_RESPONSE (the type
     * they'd become if the keyword completes). Re-use the same
     * combined-buffer approach. */
    uint8_t work[256 + 512 + 8];
    size_t  tot = 0;
    if (S.pending_len > 0) {
        memcpy(work, S.pending_buf, S.pending_len);
        tot = S.pending_len;
    }
    if (tot + n > sizeof(work)) {
        LOGE("process_data_mode_bytes: working buffer too small; flushing");
        pending_flush();
        tot = 0;
    }
    memcpy(work + tot, new_bytes, n);
    tot += n;
    S.pending_len = 0;

    size_t nc_idx = find_keyword(work, tot, "NO CARRIER");
    if (nc_idx != (size_t)-1) {
        size_t lf = find_lf_after(work, tot, nc_idx);
        if (lf == (size_t)-1) {
            /* Partial NO CARRIER. Emit pre-keyword bytes as DATA_RX
             * (they're real data) and defer keyword + tail as
             * AT_RESPONSE-pending. */
            if (nc_idx > 0) {
                wire_write(S.host_control_fd, WIRE_TYPE_DATA_RX,
                           work, nc_idx);
            }
            pending_append(work + nc_idx, tot - nc_idx,
                           WIRE_TYPE_AT_RESPONSE);
            return;
        }
        /* Have "NO CARRIER ... \n". Pre-keyword as DATA_RX,
         * keyword line as AT_RESPONSE, status, flip, post-line as
         * AT_RESPONSE. */
        if (nc_idx > 0) {
            wire_write(S.host_control_fd, WIRE_TYPE_DATA_RX,
                       work, nc_idx);
        }
        wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                   work + nc_idx, (lf + 1) - nc_idx);
        emit_status_nocarrier();
        LOGI("transition: data_mode → command_mode (NO CARRIER)");
        S.data_mode = false;
        if (lf + 1 < tot) {
            wire_write(S.host_control_fd, WIRE_TYPE_AT_RESPONSE,
                       work + lf + 1, tot - (lf + 1));
        }
        return;
    }

    /* No full keyword. Emit everything except a possible partial-
     * keyword tail. Defer up to (klen - 1) trailing bytes. */
    size_t defer_from = partial_keyword_tail(work, tot, "NO CARRIER");
    if (defer_from > 0) {
        wire_write(S.host_control_fd, WIRE_TYPE_DATA_RX,
                   work, defer_from);
    }
    if (defer_from < tot) {
        pending_append(work + defer_from, tot - defer_from,
                       WIRE_TYPE_AT_RESPONSE);
    }
}

/* ──────────────────────────────────────────────────────────────────────
 * Poll loop handlers
 * ────────────────────────────────────────────────────────────────── */

static int handle_pty_readable(void) {
    uint8_t buf[512];
    ssize_t n = read(S.pty_fd, buf, sizeof(buf));
    if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        if (errno == EIO) {
            /* "Other end closed" — slmodemd may have recreated the
             * PTY. Brief sleep and retry next poll iteration. */
            struct timespec ts = { 0, 50 * 1000 * 1000 };
            nanosleep(&ts, NULL);
            return 0;
        }
        LOGE("read(pty): %s", strerror(errno));
        return -1;
    }
    if (n == 0) return 0;

    /* Dispatch into the line-aware path. The processors handle
     * splitting transition lines from preceding/following bytes,
     * emit MODEM_STATUS, and flip data_mode. They never call back
     * into the poll loop. */
    if (S.data_mode) {
        process_data_mode_bytes(buf, (size_t)n);
    } else {
        process_command_mode_bytes(buf, (size_t)n);
    }
    return 0;
}

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
        uint8_t  type    = 0;
        uint8_t *payload = NULL;
        size_t   plen    = 0;
        int r = wire_try_parse(S.ctrl_rx_buf, &S.ctrl_rx_len,
                               &type, &payload, &plen);
        if (r == 0) break;
        if (r < 0) return -1;

        switch (type) {
        case WIRE_TYPE_AT:
            LOGD("AT cmd: %.*s", (int)plen, (const char *)payload);
            if (write(S.pty_fd, payload, plen) < 0 && errno != EIO) {
                LOGE("write(pty) AT: %s", strerror(errno));
            }
            {
                /* Append CR — slmodemd wants \r-terminated AT lines. */
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
            /* Per Hayes spec, +++ needs guard time around it. slmodemd
             * handles the escape sequence itself on its end of the PTY,
             * so we just emit +++ with a pre-and-post guard then ATH\r. */
            LOGI("HANGUP requested");
            {
                struct timespec guard = { 1, 100 * 1000 * 1000 };  /* 1.1 s */
                nanosleep(&guard, NULL);
                if (write(S.pty_fd, "+++", 3) < 0 && errno != EIO) {
                    LOGE("write(pty) +++: %s", strerror(errno));
                }
                nanosleep(&guard, NULL);
                if (write(S.pty_fd, "ATH\r", 4) < 0 && errno != EIO) {
                    LOGE("write(pty) ATH: %s", strerror(errno));
                }
            }
            /* data_mode flips off when we see NO CARRIER or OK. */
            break;

        default:
            LOGD("host_control: ignoring unknown type 0x%02x", type);
            break;
        }
    }
    return 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Main
 * ────────────────────────────────────────────────────────────────── */

static void usage(const char *p) {
    fprintf(stderr,
        "Usage: %s\n"
        "\n"
        "PTY ↔ host control-channel bridge for backend B.\n"
        "Launched by S99modem-pjsip alongside slmodemd -e d-modem.\n"
        "\n"
        "Environment:\n"
        "  SYNTHMODEM_CONTROL_PATH  (required) host control chardev/socket\n"
        "  SYNTHMODEM_PTY_PATH      slmodemd PTY (default /dev/ttySL0)\n"
        "  SYNTHMODEM_BUILD_ID      build id for HELLO (default 'unknown')\n"
        "  SYNTHMODEM_LOG_LEVEL     error | info | debug (default error)\n",
        p);
}

int main(int argc, char *argv[]) {
    /* Configure logging first. */
    {
        const char *lv = getenv("SYNTHMODEM_LOG_LEVEL");
        if (lv) {
            if      (!strcmp(lv, "debug")) g_log_level = LOG_DEBUG;
            else if (!strcmp(lv, "info"))  g_log_level = LOG_INFO;
            else                           g_log_level = LOG_ERROR;
        }
    }

    LOGI("modemd-ctrl starting (pid %d)", (int)getpid());

    /* Reject argv[1] if someone tries to invoke us with positional args
     * (slmodemd -e style). Catch confusion early with a clear error. */
    if (argc > 1) {
        usage(argv[0]);
        return 2;
    }

    const char *control_path = getenv("SYNTHMODEM_CONTROL_PATH");
    const char *pty_path     = getenv("SYNTHMODEM_PTY_PATH");
    const char *build_id     = getenv("SYNTHMODEM_BUILD_ID");
    if (!control_path) {
        LOGE("SYNTHMODEM_CONTROL_PATH is required");
        return 2;
    }
    if (!pty_path) pty_path = "/dev/ttySL0";
    if (!build_id) build_id = "unknown";

    /* Signals. */
    {
        struct sigaction sa = {0};
        sa.sa_handler = sig_handler;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGTERM, &sa, NULL);
        sigaction(SIGINT,  &sa, NULL);
        signal(SIGPIPE, SIG_IGN);
    }

    /* Open host control channel. */
    S.host_control_fd = open_host_path(control_path);
    if (S.host_control_fd < 0) return 1;

    /* Open PTY. In production this is a character device (slmodemd's
     * /dev/ttySL0 typically); in tests it may be a Unix socket as a
     * stand-in. open_host_path handles both. Non-fatal on failure so
     * modemd-ctrl can be tested without a PTY at all. */
    S.pty_fd = open_host_path(pty_path);
    if (S.pty_fd < 0) {
        LOGI("PTY %s unavailable — continuing without PTY", pty_path);
        S.pty_fd = -1;
    } else {
        LOGI("opened PTY %s as fd %d", pty_path, S.pty_fd);
    }

    /* Send HELLO. */
    {
        char hello[128];
        int hl = snprintf(hello, sizeof(hello),
                          "modemd-ctrl v%d build=%s", WIRE_VERSION, build_id);
        if (hl > 0) {
            wire_write(S.host_control_fd, WIRE_TYPE_HELLO, hello, (size_t)hl);
            LOGI("sent HELLO: %s", hello);
        }
    }

    /* Poll loop. */
    S.data_mode    = false;
    S.ctrl_rx_len  = 0;

    while (!g_quit) {
        struct pollfd pfds[2];
        int nfds = 0;

        pfds[nfds].fd     = S.host_control_fd;
        pfds[nfds].events = POLLIN;
        int idx_ctrl = nfds++;

        int idx_pty = -1;
        if (S.pty_fd >= 0) {
            pfds[nfds].fd     = S.pty_fd;
            pfds[nfds].events = POLLIN;
            idx_pty = nfds++;
        }

        int pr = poll(pfds, nfds, 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            LOGE("poll: %s", strerror(errno));
            break;
        }
        if (pr == 0) continue;

        if (pfds[idx_ctrl].revents & (POLLIN | POLLHUP)) {
            if (handle_host_control_readable() < 0) break;
        }
        if (idx_pty >= 0 &&
            (pfds[idx_pty].revents & (POLLIN | POLLHUP))) {
            if (handle_pty_readable() < 0) break;
        }
    }

    LOGI("modemd-ctrl exiting");
    if (S.pty_fd >= 0)          close(S.pty_fd);
    if (S.host_control_fd >= 0) close(S.host_control_fd);
    return 0;
}
