/*
 * mock-slmodemd.c — a minimal stand-in for the real slmodemd, for use
 *                   in environments where we can't run the 32-bit ELF
 *                   (e.g. sandboxes without i386 kernel ABI support,
 *                   CI without multiarch, Windows dev boxes).
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * The REAL slmodemd:
 *   1. Creates a PTY and symlinks it to /dev/ttySL0.
 *   2. Creates two socketpair()s — one SOCK_STREAM for audio, one
 *      SOCK_DGRAM for SIP-info frames.
 *   3. fork()s. The child close()s its end of sockets[1]/sip_sockets[1],
 *      execs modem_exec (the -e argument) with argv:
 *          modem_exec [sip-opts] <dialstr> <audio_fd> <sip_info_fd>
 *      where audio_fd and sip_info_fd are the DECIMAL STRING
 *      representations of inherited FDs.
 *   4. Immediately writes an initial SOCKET_FRAME_AUDIO then a
 *      SOCKET_FRAME_VOLUME to the audio socket (telling the child
 *      "here's a starting silence frame + current volume setting").
 *   5. Thereafter: reads AT commands from the PTY, runs them through
 *      the modem state machine, and — when a call is active — pumps
 *      audio to/from the audio socket.
 *
 * This mock reproduces steps 1–4 faithfully so the shim gets the
 * exact argv and initial socket state it will get from the real
 * slmodemd. It then implements a trivial AT command responder on the
 * PTY that understands just enough to pass the M1 smoke test:
 *
 *     AT     → OK
 *     ATE0   → OK  (disable echo)
 *     ATE1   → OK  (enable echo, default)
 *     ATI    → mock-slmodemd / OK
 *     ATI3   → mock-slmodemd v0 / OK
 *     ATZ    → OK
 *     AT+MS? → +MS: 132,1,,14400 / OK  (fake V.32bis default)
 *     anything else → ERROR
 *
 * It does NOT implement dialing, ANSWERing, training, or DSP. That is
 * fine for M1 (AT round-trip only). In M2 when we move to the real VM
 * we exercise the genuine slmodemd binary and this mock steps aside.
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * We deliberately keep this in plain C with minimal dependencies so it
 * builds on whatever the developer has (no libraries, no build system
 * complication). It's a test tool; longevity isn't a concern.
 *
 * Copyright (C) 2026 synthmodem contributors
 * License: GPL-2.0-or-later (matches the real slmodemd).
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <poll.h>
#include <signal.h>
#include <termios.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <ctype.h>

/*
 * We need slmodemd's struct socket_frame definition to write the
 * initial frames in the exact shape the shim expects. Rather than
 * duplicate the struct here (risking drift), we include the real
 * header from the vendored slmodemd tree.
 */
#include "../../vm/slmodemd/modem.h"

/* Path where we symlink the created PTS for convenience. Optional;
 * the PTS name is also printed. */
#define DEFAULT_PTY_SYMLINK "/tmp/mock-ttySL0"

static volatile sig_atomic_t g_stop = 0;
static pid_t g_child_pid = -1;
static int   g_pty_master = -1;
static char  g_pty_symlink[256] = DEFAULT_PTY_SYMLINK;

static void on_signal(int sig) {
    (void)sig;
    g_stop = 1;
}

/*
 * Create a PTY pair. Returns master fd; writes PTS path into name_out.
 * The PTS (slave) end is not opened by us; consumers open it
 * themselves (via the path or the symlink).
 */
static int open_pty(char *name_out, size_t name_out_sz) {
    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0) { perror("posix_openpt"); return -1; }
    if (grantpt(master) < 0)    { perror("grantpt"); close(master); return -1; }
    if (unlockpt(master) < 0)   { perror("unlockpt"); close(master); return -1; }
    if (ptsname_r(master, name_out, name_out_sz) != 0) {
        perror("ptsname_r"); close(master); return -1;
    }
    /* Put the master in raw mode so we don't get line-discipline
     * processing of bytes we read from it. */
    struct termios t;
    if (tcgetattr(master, &t) == 0) {
        cfmakeraw(&t);
        tcsetattr(master, TCSANOW, &t);
    }
    fcntl(master, F_SETFL, O_NONBLOCK);
    return master;
}

/*
 * Write an entire buffer or die trying. Used only on the PTY master,
 * which should almost never block for the tiny strings we write.
 */
static void pty_write_all(int fd, const char *buf, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, buf, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                /* Back off briefly. Unlikely but possible if the
                 * child fell behind reading. */
                usleep(1000);
                continue;
            }
            perror("mock-slmodemd: pty write");
            return;
        }
        buf += w; n -= (size_t)w;
    }
}

static void pty_writeln(int fd, const char *line) {
    pty_write_all(fd, line, strlen(line));
    pty_write_all(fd, "\r\n", 2);
}

/*
 * Minimal AT-command responder.
 *
 *   line   null-terminated, stripped of CR/LF, already uppercased.
 *   echo   whether E1 is active (default yes; flipped by ATE0/ATE1)
 *
 * Returns the new echo state (possibly unchanged).
 *
 * Protocol formatting matches what the Hayes-style interpreter in the
 * real slmodemd produces: CRLF before every response line, OK/ERROR
 * as the final result code. The shim's PTY reader will see the same
 * byte stream it would see from the real thing.
 */
static int handle_at(int pty_fd, const char *line, int echo) {
    /* Re-echo the command line if echo is on. Real modems do this;
     * so does slmodemd when ATE1 is in effect. */
    if (echo) {
        pty_write_all(pty_fd, line, strlen(line));
        pty_write_all(pty_fd, "\r\n", 2);
    }

    /* Empty line (user hit Enter alone): do nothing, not even OK. */
    if (line[0] == '\0') return echo;

    /* Every AT command MUST start with "AT". */
    if (strncmp(line, "AT", 2) != 0) {
        pty_writeln(pty_fd, "");
        pty_writeln(pty_fd, "ERROR");
        return echo;
    }
    const char *rest = line + 2;

    /* Plain "AT" → OK */
    if (*rest == '\0') {
        pty_writeln(pty_fd, "");
        pty_writeln(pty_fd, "OK");
        return echo;
    }

    if (!strcmp(rest, "E0"))    { echo = 0; goto ok; }
    if (!strcmp(rest, "E1"))    { echo = 1; goto ok; }
    if (!strcmp(rest, "Z"))     { echo = 1; goto ok; }     /* reset */
    if (!strcmp(rest, "I"))     {
        pty_writeln(pty_fd, "");
        pty_writeln(pty_fd, "mock-slmodemd");
        goto ok;
    }
    if (!strcmp(rest, "I3"))    {
        pty_writeln(pty_fd, "");
        pty_writeln(pty_fd, "mock-slmodemd v0");
        goto ok;
    }
    if (!strcmp(rest, "+MS?"))  {
        pty_writeln(pty_fd, "");
        pty_writeln(pty_fd, "+MS: 132,1,,14400");
        goto ok;
    }

    /* Unknown command */
    pty_writeln(pty_fd, "");
    pty_writeln(pty_fd, "ERROR");
    return echo;

ok:
    pty_writeln(pty_fd, "");
    pty_writeln(pty_fd, "OK");
    return echo;
}

/*
 * Fork & exec the -e child program with the socketpair FDs passed
 * as decimal-string argv, mirroring real slmodemd.
 */
static pid_t fork_exec_child(const char *exec_path,
                             const char *dialstr,
                             int audio_fd_child,
                             int sip_fd_child) {
    pid_t pid = fork();
    if (pid < 0) { perror("mock-slmodemd: fork"); return -1; }
    if (pid == 0) {
        /* Child: ensure inherited FDs aren't CLOEXEC. socketpair()
         * returns FDs without FD_CLOEXEC by default, but be explicit. */
        int flags;
        flags = fcntl(audio_fd_child, F_GETFD); if (flags >= 0) fcntl(audio_fd_child, F_SETFD, flags & ~FD_CLOEXEC);
        flags = fcntl(sip_fd_child,   F_GETFD); if (flags >= 0) fcntl(sip_fd_child,   F_SETFD, flags & ~FD_CLOEXEC);

        char audio_fd_str[16], sip_fd_str[16];
        snprintf(audio_fd_str, sizeof(audio_fd_str), "%d", audio_fd_child);
        snprintf(sip_fd_str,   sizeof(sip_fd_str),   "%d", sip_fd_child);

        /* Build argv: [exec_path, dialstr, audio_fd, sip_fd, NULL]
         * We do NOT pass --sip-server/user/password here; the shim
         * doesn't use them and real slmodemd only passes them when
         * configured. Keeping the mock simple. */
        char *argv[] = {
            (char *)exec_path,
            (char *)dialstr,
            audio_fd_str,
            sip_fd_str,
            NULL
        };
        execv(exec_path, argv);
        /* If we get here, exec failed. */
        fprintf(stderr, "mock-slmodemd: execv %s: %s\n",
                exec_path, strerror(errno));
        _exit(127);
    }
    return pid;
}

/*
 * Write the two initial frames (AUDIO silence + VOLUME) that real
 * slmodemd sends to the child immediately after fork, so the shim
 * sees the same startup sequence.
 */
static int write_initial_frames(int audio_fd) {
    struct socket_frame sf;
    memset(&sf, 0, sizeof(sf));
    sf.type = SOCKET_FRAME_AUDIO;
    /* sf.data.audio.buf is already zeroed — semantic silence. */
    if (write(audio_fd, &sf, sizeof(sf)) != (ssize_t)sizeof(sf)) {
        perror("mock-slmodemd: write initial AUDIO");
        return -1;
    }

    memset(&sf, 0, sizeof(sf));
    sf.type = SOCKET_FRAME_VOLUME;
    sf.data.volume.value = 2;   /* a sane default; child may ignore */
    if (write(audio_fd, &sf, sizeof(sf)) != (ssize_t)sizeof(sf)) {
        perror("mock-slmodemd: write initial VOLUME");
        return -1;
    }
    return 0;
}

static void usage(const char *prog) {
    fprintf(stderr,
        "Usage: %s -e <exec-path> [-L <pty-symlink>] [-d <dialstr>]\n"
        "\n"
        "  -e PATH   Program to fork/exec (the -e contract, e.g. modemd-shim)\n"
        "  -L PATH   Where to symlink the created PTS (default %s)\n"
        "  -d STR    Initial dial string passed as first argv to child\n"
        "            (default empty; mirrors slmodemd's behavior when no\n"
        "             ATD has been issued yet)\n"
        "\n"
        "Prints the PTS name on stdout. Reads AT commands from the PTY\n"
        "and responds with a minimal Hayes-style responder. Exit with\n"
        "SIGINT/SIGTERM.\n",
        prog, DEFAULT_PTY_SYMLINK);
}

int main(int argc, char **argv) {
    const char *exec_path = NULL;
    const char *dialstr = "";
    int opt;

    /* --- arg parsing --- */
    while ((opt = getopt(argc, argv, "e:L:d:h")) != -1) {
        switch (opt) {
        case 'e': exec_path = optarg; break;
        case 'L': snprintf(g_pty_symlink, sizeof(g_pty_symlink), "%s", optarg); break;
        case 'd': dialstr = optarg; break;
        case 'h': usage(argv[0]); return 0;
        default:  usage(argv[0]); return 64;
        }
    }
    if (!exec_path) {
        fprintf(stderr, "mock-slmodemd: -e <exec-path> is required\n");
        usage(argv[0]);
        return 64;
    }

    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);

    /* --- PTY --- */
    char pts_name[256];
    g_pty_master = open_pty(pts_name, sizeof(pts_name));
    if (g_pty_master < 0) return 1;
    fprintf(stderr, "mock-slmodemd: PTS created at %s\n", pts_name);

    /* Symlink it for convenience (ignored if we can't; the real
     * pts_name is authoritative). */
    unlink(g_pty_symlink);
    if (symlink(pts_name, g_pty_symlink) == 0) {
        fprintf(stderr, "mock-slmodemd: symlink %s -> %s\n", g_pty_symlink, pts_name);
    }

    /* Stdout line for test harnesses that scrape it. */
    printf("PTS=%s\n", pts_name);
    fflush(stdout);

    /* --- socketpairs, mirroring real slmodemd --- */
    int audio_pair[2], sip_pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, audio_pair) < 0) {
        perror("mock-slmodemd: socketpair(AUDIO)"); return 1;
    }
    if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sip_pair) < 0) {
        perror("mock-slmodemd: socketpair(SIP)"); return 1;
    }
    /* Parent keeps [1]; child gets [0]. */
    int audio_parent = audio_pair[1];
    int audio_child  = audio_pair[0];
    int sip_parent   = sip_pair[1];
    int sip_child    = sip_pair[0];

    /* --- fork/exec the child --- */
    g_child_pid = fork_exec_child(exec_path, dialstr, audio_child, sip_child);
    if (g_child_pid < 0) return 1;

    /* Parent closes child's ends. */
    close(audio_child);
    close(sip_child);

    /* Initial frames, same order the real slmodemd uses. */
    if (write_initial_frames(audio_parent) < 0) {
        kill(g_child_pid, SIGTERM);
        return 1;
    }

    /* --- AT command loop on PTY + socket drain loop --- */
    int echo = 1;
    char at_buf[512];
    size_t at_len = 0;
    /* For audio path: the shim will write audio frames at us; we
     * must drain them so it doesn't block, but we don't otherwise
     * care. Drain into a throwaway buffer. */
    char drain_buf[1024];

    struct pollfd pfds[3];
    while (!g_stop) {
        pfds[0].fd = g_pty_master;   pfds[0].events = POLLIN;
        pfds[1].fd = audio_parent;   pfds[1].events = POLLIN;
        pfds[2].fd = sip_parent;     pfds[2].events = POLLIN;

        int r = poll(pfds, 3, 200);
        if (r < 0) {
            if (errno == EINTR) continue;
            perror("mock-slmodemd: poll");
            break;
        }
        /* Did the child exit? */
        int status;
        pid_t wp = waitpid(g_child_pid, &status, WNOHANG);
        if (wp == g_child_pid) {
            fprintf(stderr, "mock-slmodemd: child exited (status=%d)\n", status);
            g_child_pid = -1;
            break;
        }

        if (pfds[0].revents & POLLIN) {
            /* Read AT bytes, accumulate until CR or LF, then dispatch. */
            char rb[128];
            ssize_t n = read(g_pty_master, rb, sizeof(rb));
            if (n > 0) {
                for (ssize_t i = 0; i < n; i++) {
                    char c = rb[i];
                    if (c == '\r' || c == '\n') {
                        at_buf[at_len] = '\0';
                        /* Uppercase in place; AT is case-insensitive. */
                        for (size_t j = 0; j < at_len; j++) at_buf[j] = (char)toupper((unsigned char)at_buf[j]);
                        echo = handle_at(g_pty_master, at_buf, echo);
                        at_len = 0;
                    } else if (at_len + 1 < sizeof(at_buf)) {
                        at_buf[at_len++] = c;
                    }
                    /* else: overflow; silently discard. */
                }
            }
        }
        if (pfds[1].revents & POLLIN) {
            /* Drain audio frames from the shim. */
            ssize_t n = read(audio_parent, drain_buf, sizeof(drain_buf));
            (void)n; /* ignore — we're a mock, no DSP */
        }
        if (pfds[2].revents & POLLIN) {
            char tmp[256];
            ssize_t n = read(sip_parent, tmp, sizeof(tmp));
            (void)n;
        }
    }

    /* --- cleanup --- */
    fprintf(stderr, "mock-slmodemd: shutting down\n");
    if (g_child_pid > 0) {
        kill(g_child_pid, SIGTERM);
        /* Give it a moment to exit gracefully. */
        for (int i = 0; i < 20; i++) {
            if (waitpid(g_child_pid, NULL, WNOHANG) == g_child_pid) { g_child_pid = -1; break; }
            usleep(50000);
        }
        if (g_child_pid > 0) {
            kill(g_child_pid, SIGKILL);
            waitpid(g_child_pid, NULL, 0);
        }
    }
    close(g_pty_master);
    close(audio_parent);
    close(sip_parent);
    unlink(g_pty_symlink);
    return 0;
}
