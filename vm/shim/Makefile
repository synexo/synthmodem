# vm/shim/Makefile — build the modemd-shim program
#
# Copyright (C) 2026 synthmodem contributors
# License: GPL-2.0-or-later
#
# ─────────────────────────────────────────────────────────────────────────
# Two targets:
#
#   modemd-shim         — native (host architecture). Useful for M1
#                         development on x86_64 without needing 32-bit
#                         libs, and for unit-testing wire.h without
#                         slmodemd in the loop. Does NOT link against
#                         slmodemd or dsplibs.o.
#
#   modemd-shim-i386    — 32-bit i386 build, required for talking to
#                         slmodemd (which is i386 because dsplibs.o is
#                         i386). This is the one that actually ships
#                         to the VM or to a real slmodemd install.
#
# On Ubuntu/Debian the i386 build needs:
#     sudo apt install gcc-multilib libc6-dev-i386
# ─────────────────────────────────────────────────────────────────────────

CC         ?= gcc
CFLAGS     ?= -O2 -Wall -Wextra -Wno-unused-parameter
CFLAGS_STD := -std=gnu99
# modem.h is vendored in vm/slmodemd/. The shim needs it for
# struct socket_frame (slmodemd's audio + sip-info framing).
CFLAGS_INC := -I../slmodemd
LDFLAGS    ?=

# Build identifier — stamped into HELLO. Derived from git if possible,
# falls back to "dev". Override at build time:
#     make BUILD_ID=v0.1.0
BUILD_ID ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
DEFINES  := -DBUILD_ID_DEFAULT='"$(BUILD_ID)"'

HEADERS := wire.h

.PHONY: all clean help
.DEFAULT_GOAL := all

help:
	@echo "Targets:"
	@echo "  make             — build native modemd-shim"
	@echo "  make i386        — build 32-bit modemd-shim-i386"
	@echo "  make all         — both"
	@echo "  make clean       — remove build artifacts"
	@echo ""
	@echo "The native build is for host-side development and testing."
	@echo "The i386 build is the one that ships with slmodemd."

all: modemd-shim modemd-shim-i386

# Native (host arch) build. Useful for early dev + unit tests.
modemd-shim: modemd-shim.c $(HEADERS)
	$(CC) $(CFLAGS_STD) $(CFLAGS) $(CFLAGS_INC) $(DEFINES) -o $@ $< $(LDFLAGS)

# 32-bit i386 build. Required for interop with slmodemd's i386 ABI.
# If 32-bit libs are missing this target fails with a link error,
# which is the right behavior — no silent fallback.
i386: modemd-shim-i386
modemd-shim-i386: modemd-shim.c $(HEADERS)
	$(CC) -m32 $(CFLAGS_STD) $(CFLAGS) $(CFLAGS_INC) $(DEFINES) -o $@ $< $(LDFLAGS)

clean:
	rm -f modemd-shim modemd-shim-i386
