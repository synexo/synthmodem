# vm/ctrl/Makefile — build modemd-ctrl
#
# Copyright (C) 2026 synthmodem contributors
# License: GPL-2.0-or-later
#
# ─────────────────────────────────────────────────────────────────────────
# modemd-ctrl is the control-channel helper for backend B. It bridges
# slmodemd's PTY to the Node host over a virtio-serial chardev using the
# wire protocol defined in wire.h (alongside this Makefile). This is the
# wire.h originated as a vm/shim/ header (the deprecated modemd-shim spoke
# the same protocol); it now lives alongside modemd-ctrl, its sole consumer.
#
# Two-target split: native for host
# dev/testing, i386 for the real VM (where slmodemd is i386).
# ─────────────────────────────────────────────────────────────────────────

CC         ?= gcc
CFLAGS     ?= -O2 -Wall -Wextra -Wno-unused-parameter
CFLAGS_STD := -std=gnu99
# wire.h lives alongside this Makefile; no extra includes.
CFLAGS_INC :=
LDFLAGS    ?=

BUILD_ID ?= $(shell git describe --always --dirty 2>/dev/null || echo dev)
DEFINES  := -DBUILD_ID_DEFAULT='"$(BUILD_ID)"'

.PHONY: all clean i386 help
.DEFAULT_GOAL := all

help:
	@echo "Targets:"
	@echo "  make             — build native + i386 modemd-ctrl"
	@echo "  make i386        — just 32-bit modemd-ctrl-i386"
	@echo "  make clean       — remove build artifacts"

all: modemd-ctrl modemd-ctrl-i386

modemd-ctrl: modemd-ctrl.c wire.h
	$(CC) $(CFLAGS_STD) $(CFLAGS) $(CFLAGS_INC) $(DEFINES) -o $@ $< $(LDFLAGS)

i386: modemd-ctrl-i386
modemd-ctrl-i386: modemd-ctrl.c wire.h
	$(CC) -m32 $(CFLAGS_STD) $(CFLAGS) $(CFLAGS_INC) $(DEFINES) -o $@ $< $(LDFLAGS)

clean:
	rm -f modemd-ctrl modemd-ctrl-i386
