/*
 * pjsip-test-peer.c — minimal PJSIP UAS for backend B step-3 testing.
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later
 *
 * Derived in structure from pjsip-apps/src/samples/simple_pjsua.c,
 * which is Copyright (C) 2008-2011 Teluu Inc., Copyright (C) 2003-
 * 2008 Benny Prijono. Licensed under GPL-2.0-or-later.
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * ROLE
 *
 *   This is a test-only binary that exercises PJSIP-in-VM end-to-end
 *   for step 3 of PJSIP.md:
 *
 *     Node (host)                         VM
 *     ─────────────                       ────────────
 *     test harness    ── INVITE ────►   pjsip-test-peer
 *     (raw SIP)       ◄── 200 OK ───    (this binary)
 *                     ── ACK ─────►
 *                     ── BYE ─────►
 *                     ◄── 200 OK ───
 *                                        pjsua_destroy, exit
 *
 *   Traffic flows through the tunnel stack built in step 2 —
 *   modemd-tunnel inside the VM, UdpTcpTunnel on the host. Since
 *   step 5c, modemd-tunnel binds the well-known SIP port (5060) on
 *   the VM side to accommodate real d-modem (whose PJSIP binds
 *   ephemeral). pjsip-test-peer therefore binds a DIFFERENT port —
 *   5090 by default — so its test-only binding doesn't collide with
 *   modemd-tunnel's production binding. Tests that use this peer
 *   drive their tunnel at a SIP port matching 5090 for outbound
 *   delivery; the tunnel still learns the peer on its first reply.
 *
 *   This is NOT a production binary. It does not:
 *     - Register with a SIP registrar (no `--sip-server` concept).
 *     - Handle more than one simultaneous call (not needed).
 *     - Do anything useful with media (media session starts and
 *       then idles; no actual audio is sent).
 *
 *   It DOES:
 *     - Create a PJSUA instance with a UDP transport on 127.0.0.1:5090.
 *     - Auto-answer incoming INVITEs with 200 OK (advertising PCMU).
 *     - Handle ACK + BYE correctly through pjsua's own machinery.
 *     - Run until SIGTERM.
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * CONFIGURATION (via environment, all optional)
 *
 *   PJSIP_TEST_PEER_SIP_PORT   UDP port to bind SIP on. Defaults 5090.
 *                              (Was 5060 before step 5c; moved to
 *                              avoid conflict with modemd-tunnel's
 *                              symmetric-port binding.)
 *   PJSIP_TEST_PEER_LOG_LEVEL  PJSIP console log level, 0..5.
 *                              Defaults to 3 (info).
 *
 * ═════════════════════════════════════════════════════════════════════
 *
 * BUILD
 *
 *   Built by scripts/build-pjsip-in-vm.sh alongside d-modem and
 *   modemd-tunnel. Links against the same statically-linked PJSIP
 *   install tree (prefix /build/pjsip.install) that d-modem uses.
 *   Produces an i386 PIE binary that runs in the bookworm runtime VM.
 *
 *   Host-builds will compile but produce binaries that won't load in
 *   the runtime VM (glibc 2.38+ __isoc23_ trap). Use the build VM.
 */

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pjsua-lib/pjsua.h>

#define THIS_FILE "test-peer"

/* Global flag flipped by signal handlers. Checked by the main wait
 * loop so we shut down pjsua cleanly instead of being SIGKILLed by
 * the test harness. */
static volatile sig_atomic_t g_should_exit = 0;

/* Track the current (single) call id so we can hang it up on shutdown. */
static pjsua_call_id g_current_call = PJSUA_INVALID_ID;

static void sig_handler(int sig) {
    (void)sig;
    g_should_exit = 1;
}

/* ─── PJSUA callbacks ──────────────────────────────────────────────── */

static void on_incoming_call(pjsua_acc_id acc_id, pjsua_call_id call_id,
                             pjsip_rx_data *rdata)
{
    pjsua_call_info ci;
    PJ_UNUSED_ARG(acc_id);
    PJ_UNUSED_ARG(rdata);

    pjsua_call_get_info(call_id, &ci);
    PJ_LOG(3, (THIS_FILE, "incoming call from %.*s (call_id=%d)",
               (int)ci.remote_info.slen, ci.remote_info.ptr, call_id));

    g_current_call = call_id;

    /* Auto-answer with 200 OK immediately. The test harness wants to
     * see a fast path through the signaling. */
    pjsua_call_answer(call_id, 200, NULL, NULL);
}

static void on_call_state(pjsua_call_id call_id, pjsip_event *e)
{
    pjsua_call_info ci;
    PJ_UNUSED_ARG(e);

    pjsua_call_get_info(call_id, &ci);
    PJ_LOG(3, (THIS_FILE, "call %d state=%.*s",
               call_id,
               (int)ci.state_text.slen, ci.state_text.ptr));

    if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
        PJ_LOG(3, (THIS_FILE, "call %d disconnected", call_id));
        if (g_current_call == call_id)
            g_current_call = PJSUA_INVALID_ID;
    }
}

static void on_call_media_state(pjsua_call_id call_id)
{
    pjsua_call_info ci;
    pjsua_call_get_info(call_id, &ci);

    PJ_LOG(3, (THIS_FILE, "call %d media status=%d", call_id,
               (int)ci.media_status));

    /* NOTE: simple_pjsua wires the call to the sound device here
     * (pjsua_conf_connect(ci.conf_slot, 0)). We build PJSIP with
     * --disable-sound, so slot 0 doesn't exist. For step 3 the
     * media session just idles — we only care that SIP signaling
     * works. Later steps will connect media via the conference
     * bridge to d-modem's custom port. */
}

/* ─── main ─────────────────────────────────────────────────────────── */

/* Tiny parse helper — avoid atoi/strtol to dodge glibc 2.38+
 * __isoc23_* trap. Returns -1 on no-digits. */
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

static void error_exit(const char *title, pj_status_t status) {
    pjsua_perror(THIS_FILE, title, status);
    pjsua_destroy();
    exit(1);
}

int main(int argc, char *argv[]) {
    pj_status_t status;
    int sip_port = 5090;
    int log_level = 3;

    PJ_UNUSED_ARG(argc);
    PJ_UNUSED_ARG(argv);

    /* Env config */
    {
        const char *s;
        if ((s = getenv("PJSIP_TEST_PEER_SIP_PORT"))) {
            int v = parse_dec_int(s);
            if (v > 0 && v < 65536) sip_port = v;
        }
        if ((s = getenv("PJSIP_TEST_PEER_LOG_LEVEL"))) {
            int v = parse_dec_int(s);
            if (v >= 0 && v <= 5) log_level = v;
        }
    }

    /* Signal handlers so SIGTERM does a clean pjsua_destroy() instead
     * of tearing the process down in the middle of a call. */
    {
        struct sigaction sa = { 0 };
        sa.sa_handler = sig_handler;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGTERM, &sa, NULL);
        sigaction(SIGINT,  &sa, NULL);
        signal(SIGPIPE, SIG_IGN);
    }

    /* ─── Create PJSUA ─────────────────────────────────────────── */
    status = pjsua_create();
    if (status != PJ_SUCCESS) error_exit("pjsua_create()", status);

    /* ─── Initialize PJSUA ─────────────────────────────────────── */
    {
        pjsua_config         cfg;
        pjsua_logging_config log_cfg;
        pjsua_media_config   media_cfg;

        pjsua_config_default(&cfg);
        cfg.cb.on_incoming_call    = &on_incoming_call;
        cfg.cb.on_call_state       = &on_call_state;
        cfg.cb.on_call_media_state = &on_call_media_state;

        pjsua_logging_config_default(&log_cfg);
        log_cfg.console_level = log_level;

        /* We built PJSIP with --disable-sound, so pjsua can't use the
         * normal audio device. Set clock rate explicitly; PJSUA will
         * use the null audio device we install below. */
        pjsua_media_config_default(&media_cfg);
        media_cfg.clock_rate       = 8000;
        media_cfg.snd_clock_rate   = 8000;
        /* Don't try to echo-cancel — saves CPU, not needed here. */
        media_cfg.ec_tail_len      = 0;

        status = pjsua_init(&cfg, &log_cfg, &media_cfg);
        if (status != PJ_SUCCESS) error_exit("pjsua_init()", status);
    }

    /* ─── Set null audio device ────────────────────────────────── *
     *
     * --disable-sound still leaves the audiodev framework in place;
     * we tell it to use the null device explicitly so pjsua won't
     * try to probe real soundcards that aren't there.
     */
    status = pjsua_set_null_snd_dev();
    if (status != PJ_SUCCESS) {
        PJ_LOG(2, (THIS_FILE, "pjsua_set_null_snd_dev failed; continuing"));
    }

    /* ─── Create UDP transport on 127.0.0.1:sip_port ───────────── */
    {
        pjsua_transport_config cfg;
        pjsua_transport_config_default(&cfg);
        cfg.port = sip_port;
        /* Bind to loopback explicitly — the tunnel delivers packets
         * here and PJSIP has no business talking to anything outside
         * the VM. */
        cfg.bound_addr = pj_str("127.0.0.1");

        status = pjsua_transport_create(PJSIP_TRANSPORT_UDP, &cfg, NULL);
        if (status != PJ_SUCCESS) error_exit("pjsua_transport_create()", status);
    }

    /* ─── Start pjsua ─────────────────────────────────────────── */
    status = pjsua_start();
    if (status != PJ_SUCCESS) error_exit("pjsua_start()", status);

    /* ─── Add a local SIP account ─────────────────────────────── *
     *
     * No registrar. This is just the identity we present as the
     * local party in SIP dialogs. reg_uri left empty so pjsua
     * doesn't try to REGISTER.
     */
    {
        pjsua_acc_config cfg;
        pjsua_acc_id     acc_id;
        pjsua_acc_config_default(&cfg);
        cfg.id = pj_str("sip:test-peer@127.0.0.1");
        /* No reg_uri → no REGISTER. */
        status = pjsua_acc_add(&cfg, PJ_TRUE, &acc_id);
        if (status != PJ_SUCCESS) error_exit("pjsua_acc_add()", status);
    }

    PJ_LOG(3, (THIS_FILE, "pjsip-test-peer ready on 127.0.0.1:%d", sip_port));

    /* ─── Main loop: wait for SIGTERM ─────────────────────────── */
    while (!g_should_exit) {
        /* pjsua has its own worker threads; we just idle. */
        pj_thread_sleep(200);
    }

    PJ_LOG(3, (THIS_FILE, "shutting down"));
    if (g_current_call != PJSUA_INVALID_ID) {
        pjsua_call_hangup(g_current_call, 0, NULL, NULL);
        pj_thread_sleep(200);   /* let BYE drain */
    }
    pjsua_destroy();
    return 0;
}
