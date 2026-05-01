/*
 * modemd-tunnel.c — UDP-over-TCP bridge for backend B (slmodemd-pjsip)
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * ROLE IN THE OVERALL ARCHITECTURE
 *
 *   Host (Node)                 This process              PJSIP (in VM)
 *   ───────────            ────────────────────         ──────────────
 *   UdpTcpTunnel.js  <──>   modemd-tunnel       <──>    pjsua / d-modem
 *      via               framed UDP over           via local loopback
 *    loopback UDP       virtio-serial chardev        UDP datagrams
 *
 *   This program sits in the VM and bridges:
 *
 *     One TCP-ish byte stream  (a virtio-serial chardev that the host
 *                               backs with a TCP socket)
 *       ⇄
 *     Several local UDP sockets (loopback; PJSIP binds to them on the
 *                                VM side as though they were remote
 *                                peers)
 *
 *   The framing and channel demux are specified in
 *   vm/tunnel/PROTOCOL.md. This file is the canonical implementation
 *   on the VM side; src/tunnel/UdpTcpTunnel.js is its counterpart on
 *   the host side. When in doubt, PROTOCOL.md is authoritative.
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * CONFIGURATION (via environment)
 *
 *   SYNTHMODEM_TUNNEL_PATH   Path to the virtio-serial chardev that
 *                            carries the framed stream to the host.
 *                            Defaults to
 *                            /dev/virtio-ports/synthmodem.tunnel.
 *
 *   SYNTHMODEM_TUNNEL_SIP_PORT    Local well-known SIP port on 127.0.0.1
 *                                 that modemd-tunnel binds. PJSIP
 *                                 (d-modem) sends its outbound SIP
 *                                 messages here; we forward them over
 *                                 the tunnel. For VM→host delivery,
 *                                 we sendto PJSIP's ephemeral source
 *                                 address, which we learn from its
 *                                 first outbound packet. Defaults 5060.
 *
 *   SYNTHMODEM_TUNNEL_RTP_PORT    Local well-known RTP port. Same
 *                                 model as SIP. Defaults 10000.
 *
 *   SYNTHMODEM_TUNNEL_RTCP_PORT   Local well-known RTCP port. Same
 *                                 model. Defaults 10001.
 *
 *                                 NOTE ON PORT MODEL: We bind well-
 *                                 known ports here because d-modem's
 *                                 PJSIP binds ephemeral (cfg.port=0
 *                                 in upstream). The pre-5c asymmetric
 *                                 design had modemd-tunnel on
 *                                 ephemeral and PJSIP on 5060, which
 *                                 worked for pjsip-test-peer (which
 *                                 explicitly binds 5060) but not for
 *                                 real d-modem. pjsip-test-peer has
 *                                 been moved to 5090 so this binding
 *                                 doesn't conflict in test either.
 *
 *   SYNTHMODEM_LOG_LEVEL     "error" (default), "info", or "debug".
 *                            Logs go to stderr.
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * IMPLEMENTATION NOTES
 *
 *   - Single-threaded, poll()-based. 4 file descriptors: tunnel TCP
 *     chardev, SIP UDP, RTP UDP, RTCP UDP.
 *   - Partial reads on the tunnel fd are tolerated via a persistent
 *     staging buffer. A full frame may arrive across multiple read()
 *     calls, especially for SIP messages that are multi-KB.
 *   - UDP sends are single-call sendto(); UDP datagrams are atomic on
 *     Linux so partial sends don't happen in this direction.
 *   - The VM side remembers PJSIP's source address for each channel
 *     (learned from the first packet PJSIP sends) so that host→VM
 *     frames delivered to that channel know where to sendto(). Before
 *     PJSIP sends its first packet, host→VM frames on that channel
 *     are dropped (we don't know where to deliver them).
 *   - Echo channel (255) is handled internally without UDP. A frame
 *     with channel=255 is immediately re-framed with src_port and
 *     dst_port swapped and written back to the tunnel.
 *   - No strtol/atoi — uses hand-rolled parse_dec_int to avoid the
 *     glibc 2.38 __isoc23_ symbol trap that would break loading in
 *     the bookworm runtime VM.
 *   - Fixed-width types only for ABI cleanliness on i386.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

/* ─── Wire protocol constants ────────────────────────────────────────
 *
 * Keep in sync with vm/tunnel/PROTOCOL.md and
 * src/tunnel/UdpTcpTunnel.js. Changes here require updates in both
 * places.
 */

#define CH_SIP         0
#define CH_RTP         1
#define CH_RTCP        2
#define CH_ECHO      255

/* Frame header: u16 length | u8 channel | u16 src_port | u16 dst_port
 * The length field covers everything after itself, i.e. channel (1) +
 * src_port (2) + dst_port (2) + payload = 5 + payload_len.
 */
#define FRAME_HDR_FIXED   5   /* channel + src_port + dst_port */
#define FRAME_LEN_BYTES   2   /* the length field itself */

/* Practical maximum payload. The wire allows up to 65530 but nothing
 * in our use case goes near that. Cap at 8 KB to bound memory and
 * make runaway-length bugs obvious. */
#define MAX_PAYLOAD     8192
#define MAX_FRAME       (FRAME_HDR_FIXED + MAX_PAYLOAD)

/* Staging buffer for the tunnel read side. Slightly larger than one
 * max frame so we can always have at least one frame's worth buffered
 * plus a partial next frame. */
#define STAGE_BUF_SIZE  (MAX_FRAME * 2)

/* ─── Logging ──────────────────────────────────────────────────────── */

enum log_level { LOG_ERROR = 0, LOG_INFO = 1, LOG_DEBUG = 2 };
static int g_log_level = LOG_ERROR;
static struct timespec g_start_time;

static double uptime_sec(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (now.tv_sec - g_start_time.tv_sec) +
           (now.tv_nsec - g_start_time.tv_nsec) / 1e9;
}

static void logmsg(int level, char tag, const char *fmt, ...) {
    if (level > g_log_level) return;
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[tunnel %c %.3f] ", tag, uptime_sec());
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

#define LOG_ERR(...)  logmsg(LOG_ERROR, 'E', __VA_ARGS__)
#define LOG_INFO(...) logmsg(LOG_INFO,  'I', __VA_ARGS__)
#define LOG_DBG(...)  logmsg(LOG_DEBUG, 'D', __VA_ARGS__)

/* ─── Hand-rolled integer parsing ─────────────────────────────────── */

/* parse_dec_int — manual decimal parser to avoid gcc 13 +
 * glibc 2.39+ redirecting atoi/strtol to __isoc23_* symbols that would
 * fail to load in the runtime VM's glibc 2.36. Returns -1 on no-digits. */
static int parse_dec_int(const char *s) {
    if (!s || !*s) return -1;
    int v = 0;
    int saw = 0;
    while (*s >= '0' && *s <= '9') {
        v = v * 10 + (*s - '0');
        saw = 1;
        s++;
    }
    return saw ? v : -1;
}

/* ─── State ──────────────────────────────────────────────────────── */

struct chan {
    int        udp_fd;           /* UDP socket bound to our well-known
                                    local port (5060/10000/10001). */
    uint16_t   local_port;       /* the well-known port we bound;
                                    reported in frames' src_port on
                                    VM→host traffic. */
    bool       peer_learned;     /* have we seen a packet from the
                                    local consumer (PJSIP) yet? Until
                                    we have, outbound sendto has no
                                    valid target. */
    struct sockaddr_in peer;     /* learned source address of the
                                    local consumer. Populated on first
                                    recvfrom; refreshed on subsequent
                                    packets if source changes. */
};

struct state {
    int         tunnel_fd;       /* virtio-serial chardev, blocking r/w */
    struct chan sip;
    struct chan rtp;
    struct chan rtcp;

    uint8_t     stage[STAGE_BUF_SIZE];
    size_t      stage_len;       /* bytes currently buffered in stage */
};

static struct state S;

/* ─── Helpers ────────────────────────────────────────────────────── */

static struct chan *channel_for(uint8_t id) {
    switch (id) {
        case CH_SIP:  return &S.sip;
        case CH_RTP:  return &S.rtp;
        case CH_RTCP: return &S.rtcp;
        default:      return NULL;
    }
}

static const char *channel_name(uint8_t id) {
    switch (id) {
        case CH_SIP:  return "SIP";
        case CH_RTP:  return "RTP";
        case CH_RTCP: return "RTCP";
        case CH_ECHO: return "ECHO";
        default:      return "unknown";
    }
}

/* Write exactly `len` bytes to fd, handling short writes. Returns 0
 * on success, -1 on error. */
static int write_all(int fd, const uint8_t *buf, size_t len) {
    while (len > 0) {
        ssize_t n = write(fd, buf, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOG_ERR("write_all: %s", strerror(errno));
            return -1;
        }
        if (n == 0) {
            LOG_ERR("write_all: zero-byte write (peer closed?)");
            return -1;
        }
        buf += n;
        len -= (size_t)n;
    }
    return 0;
}

/* Build and write one frame onto the tunnel TCP stream. Returns 0 on
 * success, -1 on write failure. */
static int send_frame(uint8_t channel, uint16_t src_port, uint16_t dst_port,
                      const uint8_t *payload, size_t payload_len) {
    if (payload_len > MAX_PAYLOAD) {
        LOG_ERR("send_frame: payload %zu > max %d, dropping",
                payload_len, MAX_PAYLOAD);
        return 0;  /* not a fatal error, just drop */
    }
    uint16_t length = (uint16_t)(FRAME_HDR_FIXED + payload_len);
    uint8_t  hdr[FRAME_LEN_BYTES + FRAME_HDR_FIXED];
    hdr[0] = length & 0xff;
    hdr[1] = (length >> 8) & 0xff;
    hdr[2] = channel;
    hdr[3] = src_port & 0xff;
    hdr[4] = (src_port >> 8) & 0xff;
    hdr[5] = dst_port & 0xff;
    hdr[6] = (dst_port >> 8) & 0xff;
    if (write_all(S.tunnel_fd, hdr, sizeof hdr) < 0) return -1;
    if (payload_len > 0) {
        if (write_all(S.tunnel_fd, payload, payload_len) < 0) return -1;
    }
    LOG_DBG("tx frame ch=%s src=%u dst=%u len=%zu",
            channel_name(channel), src_port, dst_port, payload_len);
    return 0;
}

/* Deliver a payload from the tunnel to the local UDP consumer on the
 * given channel. Target selection:
 *
 *   1. If we've learned the consumer's peer address (it sent us
 *      something first), sendto that address. This is the steady-
 *      state path once REGISTER has happened (SIP) or the INVITE
 *      negotiation has completed (RTP).
 *
 *   2. Otherwise, if the frame header carries a dst_port that
 *      isn't our own local bind port, sendto 127.0.0.1:dst_port.
 *      This handles the pre-learning case where tests drive an
 *      explicit target (e.g. pjsip-test-peer on 5090) before any
 *      reply has been observed. The dst_port != local_port guard
 *      prevents accidental loopback if a caller frames dst_port
 *      equal to our own bind port before learning.
 *
 *   3. Otherwise drop with a log. No valid target.
 */
static int deliver_to_udp(uint8_t channel, uint16_t dst_port,
                          const uint8_t *payload, size_t payload_len) {
    struct chan *c = channel_for(channel);
    if (!c) {
        LOG_DBG("deliver: unknown channel %u, dropped", channel);
        return 0;
    }
    struct sockaddr_in target;
    if (c->peer_learned) {
        target = c->peer;
    } else if (dst_port != 0 && dst_port != c->local_port) {
        memset(&target, 0, sizeof target);
        target.sin_family = AF_INET;
        target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        target.sin_port = htons(dst_port);
        LOG_DBG("deliver %s: peer not learned, using dst_port=%u from frame",
                channel_name(channel), dst_port);
    } else {
        LOG_INFO("deliver %s: no peer learned and no usable dst_port, "
                 "dropping %zu bytes",
                 channel_name(channel), payload_len);
        return 0;
    }
    ssize_t n = sendto(c->udp_fd, payload, payload_len, 0,
                       (struct sockaddr *)&target, sizeof target);
    if (n < 0) {
        LOG_DBG("deliver %s: sendto %u.%u.%u.%u:%u: %s",
                channel_name(channel),
                (ntohl(target.sin_addr.s_addr) >> 24) & 0xff,
                (ntohl(target.sin_addr.s_addr) >> 16) & 0xff,
                (ntohl(target.sin_addr.s_addr) >>  8) & 0xff,
                ntohl(target.sin_addr.s_addr) & 0xff,
                ntohs(target.sin_port),
                strerror(errno));
        return 0;
    }
    if ((size_t)n != payload_len) {
        LOG_ERR("deliver %s: short sendto %zd/%zu",
                channel_name(channel), n, payload_len);
    }
    return 0;
}

/* Process one complete frame whose header and payload sit in the stage
 * buffer starting at offset 0. Consumes `2 + length` bytes. */
static int process_frame(uint16_t length) {
    if (length < FRAME_HDR_FIXED) {
        LOG_ERR("malformed frame: length %u < %u", length, FRAME_HDR_FIXED);
        return -1;
    }
    uint8_t  channel  = S.stage[FRAME_LEN_BYTES + 0];
    uint16_t src_port = (uint16_t)S.stage[FRAME_LEN_BYTES + 1] |
                        ((uint16_t)S.stage[FRAME_LEN_BYTES + 2] << 8);
    uint16_t dst_port = (uint16_t)S.stage[FRAME_LEN_BYTES + 3] |
                        ((uint16_t)S.stage[FRAME_LEN_BYTES + 4] << 8);
    size_t   payload_len = length - FRAME_HDR_FIXED;
    const uint8_t *payload = &S.stage[FRAME_LEN_BYTES + FRAME_HDR_FIXED];

    LOG_DBG("rx frame ch=%s src=%u dst=%u len=%zu",
            channel_name(channel), src_port, dst_port, payload_len);

    if (channel == CH_ECHO) {
        /* Replay payload with src/dst swapped. */
        return send_frame(CH_ECHO, dst_port, src_port, payload, payload_len);
    }
    if (channel == CH_SIP || channel == CH_RTP || channel == CH_RTCP) {
        return deliver_to_udp(channel, dst_port, payload, payload_len);
    }
    /* Unknown channel: drop per PROTOCOL.md forward-compat rule. */
    LOG_DBG("unknown channel %u, dropping", channel);
    return 0;
}

/* Drain the stage buffer: while we have at least one complete frame,
 * process and discard it. Returns 0 on success, -1 on framing error
 * or fatal socket error. */
static int drain_stage(void) {
    for (;;) {
        if (S.stage_len < FRAME_LEN_BYTES) return 0;  /* not enough for header */
        uint16_t length = (uint16_t)S.stage[0] | ((uint16_t)S.stage[1] << 8);
        if (length > MAX_PAYLOAD + FRAME_HDR_FIXED) {
            LOG_ERR("framing error: length %u exceeds max %d, aborting",
                    length, MAX_PAYLOAD + FRAME_HDR_FIXED);
            return -1;
        }
        size_t total = (size_t)FRAME_LEN_BYTES + length;
        if (S.stage_len < total) return 0;  /* wait for more bytes */
        if (process_frame(length) < 0) return -1;
        /* Consume the frame we just handled. */
        size_t remain = S.stage_len - total;
        if (remain > 0) memmove(S.stage, S.stage + total, remain);
        S.stage_len = remain;
    }
}

/* Read from tunnel fd into the stage buffer, then try to process
 * frames. Returns 0 on normal progress, -1 on fatal error. */
static int handle_tunnel_readable(void) {
    if (S.stage_len >= STAGE_BUF_SIZE) {
        LOG_ERR("stage buffer full (%zu bytes); framing must be broken",
                S.stage_len);
        return -1;
    }
    ssize_t n = read(S.tunnel_fd, S.stage + S.stage_len,
                     STAGE_BUF_SIZE - S.stage_len);
    if (n < 0) {
        if (errno == EINTR || errno == EAGAIN) return 0;
        LOG_ERR("tunnel read: %s", strerror(errno));
        return -1;
    }
    if (n == 0) {
        LOG_INFO("tunnel EOF");
        return -1;
    }
    S.stage_len += (size_t)n;
    LOG_DBG("tunnel rx %zd bytes (buffered %zu)", n, S.stage_len);
    return drain_stage();
}

/* A local UDP socket has data. Recvfrom it, learn the peer address on
 * the first datagram, and forward into the tunnel. */
static int handle_udp_readable(uint8_t channel) {
    struct chan *c = channel_for(channel);
    if (!c) return 0;  /* shouldn't happen — we only poll real channels */

    uint8_t buf[MAX_PAYLOAD];
    struct sockaddr_in from;
    socklen_t fromlen = sizeof from;
    ssize_t n = recvfrom(c->udp_fd, buf, sizeof buf, 0,
                        (struct sockaddr *)&from, &fromlen);
    if (n < 0) {
        if (errno == EINTR || errno == EAGAIN) return 0;
        LOG_ERR("recvfrom %s: %s", channel_name(channel), strerror(errno));
        return 0;  /* non-fatal */
    }

    /* Learn the consumer's source address on first packet. Subsequent
     * packets from a different source are still accepted; the learned
     * peer tracks the most recent source. (PJSIP typically sends from
     * a stable ephemeral port, so this learns once and stays put.) */
    if (!c->peer_learned ||
        c->peer.sin_addr.s_addr != from.sin_addr.s_addr ||
        c->peer.sin_port != from.sin_port) {
        c->peer = from;
        if (!c->peer_learned) {
            LOG_INFO("%s: learned peer %u.%u.%u.%u:%u",
                     channel_name(channel),
                     (ntohl(from.sin_addr.s_addr) >> 24) & 0xff,
                     (ntohl(from.sin_addr.s_addr) >> 16) & 0xff,
                     (ntohl(from.sin_addr.s_addr) >>  8) & 0xff,
                     ntohl(from.sin_addr.s_addr) & 0xff,
                     ntohs(from.sin_port));
        }
        c->peer_learned = true;
    }

    uint16_t src_port = ntohs(from.sin_port);
    uint16_t dst_port = c->local_port;  /* where we received it */
    return send_frame(channel, src_port, dst_port, buf, (size_t)n);
}

/* ─── Setup ──────────────────────────────────────────────────────── */

static int open_tunnel(const char *path) {
    int fd = open(path, O_RDWR);
    if (fd < 0) {
        LOG_ERR("open tunnel %s: %s", path, strerror(errno));
        return -1;
    }
    /* Blocking I/O is fine for our workload; poll() handles readiness. */
    LOG_INFO("tunnel open: %s (fd=%d)", path, fd);
    return fd;
}

/**
 * Bind an ephemeral UDP socket for `channel`, remembering that PJSIP
 * (or whatever local consumer this channel carries) is listening on
 * `peer_port`. The ephemeral port is chosen by the kernel; we record
 * it in `c->local_port` for inclusion in outgoing frames.
 *
 * We cannot bind peer_port ourselves because PJSIP already owns that
 * port — it's the whole point of the tunnel to let PJSIP use its
 * preferred well-known port (5060 for SIP, 10000 for RTP) without
 * conflicting with us.
 */
static int bind_udp(struct chan *c, uint16_t local_port, const char *name) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        LOG_ERR("%s: socket: %s", name, strerror(errno));
        return -1;
    }
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one) < 0) {
        LOG_ERR("%s: SO_REUSEADDR: %s", name, strerror(errno));
    }
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    /* Bind an explicit well-known port. With real d-modem, PJSIP binds
     * ephemeral and we learn its port from the first outbound packet
     * it sends (REGISTER for SIP, first RTP after INVITE for media).
     * The symmetric-port model replaces the pre-5a asymmetric design
     * where modemd-tunnel bound ephemeral to avoid colliding with
     * pjsip-test-peer's explicit 5060. See vm/tunnel/PROTOCOL.md. */
    addr.sin_port = htons(local_port);
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        LOG_ERR("%s: bind 127.0.0.1:%u: %s", name, local_port, strerror(errno));
        close(fd);
        return -1;
    }
    c->udp_fd       = fd;
    c->local_port   = local_port;
    c->peer_learned = false;
    memset(&c->peer, 0, sizeof c->peer);
    LOG_INFO("%s: bound 127.0.0.1:%u (fd=%d), waiting to learn peer",
             name, c->local_port, fd);
    return 0;
}

static int getenv_port(const char *name, int def) {
    const char *s = getenv(name);
    if (!s || !*s) return def;
    int v = parse_dec_int(s);
    if (v < 1 || v > 65535) {
        LOG_ERR("%s=%s invalid, using default %d", name, s, def);
        return def;
    }
    return v;
}

static void set_log_level(const char *level_str) {
    if (!level_str) return;
    if (!strcmp(level_str, "debug")) g_log_level = LOG_DEBUG;
    else if (!strcmp(level_str, "info")) g_log_level = LOG_INFO;
    else if (!strcmp(level_str, "error")) g_log_level = LOG_ERROR;
}

/* ─── Main loop ──────────────────────────────────────────────────── */

static volatile sig_atomic_t g_should_exit = 0;
static void sigterm_handler(int sig) { (void)sig; g_should_exit = 1; }

int main(int argc, char *argv[]) {
    (void)argc; (void)argv;

    clock_gettime(CLOCK_MONOTONIC, &g_start_time);
    set_log_level(getenv("SYNTHMODEM_LOG_LEVEL"));

    signal(SIGTERM, sigterm_handler);
    signal(SIGINT,  sigterm_handler);
    signal(SIGPIPE, SIG_IGN);

    const char *tunnel_path = getenv("SYNTHMODEM_TUNNEL_PATH");
    if (!tunnel_path) tunnel_path = "/dev/virtio-ports/synthmodem.tunnel";

    int sip_port  = getenv_port("SYNTHMODEM_TUNNEL_SIP_PORT",  5060);
    int rtp_port  = getenv_port("SYNTHMODEM_TUNNEL_RTP_PORT",  10000);
    int rtcp_port = getenv_port("SYNTHMODEM_TUNNEL_RTCP_PORT", 10001);

    LOG_INFO("starting: tunnel=%s sip=%d rtp=%d rtcp=%d",
             tunnel_path, sip_port, rtp_port, rtcp_port);

    S.tunnel_fd = open_tunnel(tunnel_path);
    if (S.tunnel_fd < 0) return 1;

    if (bind_udp(&S.sip,  (uint16_t)sip_port,  "SIP")  < 0) return 1;
    if (bind_udp(&S.rtp,  (uint16_t)rtp_port,  "RTP")  < 0) return 1;
    if (bind_udp(&S.rtcp, (uint16_t)rtcp_port, "RTCP") < 0) return 1;

    LOG_INFO("tunnel ready");

    struct pollfd pfds[4];
    while (!g_should_exit) {
        pfds[0].fd = S.tunnel_fd; pfds[0].events = POLLIN;
        pfds[1].fd = S.sip.udp_fd;  pfds[1].events = POLLIN;
        pfds[2].fd = S.rtp.udp_fd;  pfds[2].events = POLLIN;
        pfds[3].fd = S.rtcp.udp_fd; pfds[3].events = POLLIN;

        int rc = poll(pfds, 4, -1);
        if (rc < 0) {
            if (errno == EINTR) continue;
            LOG_ERR("poll: %s", strerror(errno));
            break;
        }

        if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            if (handle_tunnel_readable() < 0) break;
        }
        if (pfds[1].revents & POLLIN) {
            handle_udp_readable(CH_SIP);
        }
        if (pfds[2].revents & POLLIN) {
            handle_udp_readable(CH_RTP);
        }
        if (pfds[3].revents & POLLIN) {
            handle_udp_readable(CH_RTCP);
        }
    }

    LOG_INFO("exiting");
    close(S.tunnel_fd);
    close(S.sip.udp_fd);
    close(S.rtp.udp_fd);
    close(S.rtcp.udp_fd);
    return 0;
}
