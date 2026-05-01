# vm/d-modem/Makefile
#
# Builds the d-modem binary inside the Debian bookworm build VM.
# Invoked by scripts/build-vm-binaries.sh after PJSIP has been built
# and installed into $(PJSIP_PREFIX).
#
# This mirrors the top-level Makefile from synexo/D-Modem, adapted
# to the synthmodem tree layout:
#
#   Upstream layout                    Our layout
#   ────────────────                   ──────────
#   ./d-modem.c                        vm/d-modem/d-modem.c
#   ./slmodemd/modem.h                 vm/slmodemd/modem.h
#   ./pjsip.install/lib/pkgconfig/*    $(PJSIP_PREFIX)/lib/pkgconfig/*
#
# Required inputs (typically set by build-vm-binaries.sh):
#   PJSIP_PREFIX   — where `make install` placed PJSIP headers + libs
#   SLMODEMD_DIR   — path to slmodemd sources (for modem.h)
#
# Example invocation:
#   make PJSIP_PREFIX=/build/pjsip.install SLMODEMD_DIR=/repo/vm/slmodemd

PJSIP_PREFIX   ?= $(CURDIR)/../../build/pjsip.install
SLMODEMD_DIR   ?= $(CURDIR)/../slmodemd
PKG_CONFIG_PATH = $(PJSIP_PREFIX)/lib/pkgconfig

# pkg-config gives us the full static-link flags for PJSIP (pjsua-lib,
# pjsip, pjmedia, pjnath, pjlib-util, pjlib, plus whatever third_party
# libs PJSIP was configured with). The D-Modem upstream builds with
# --static for self-containment; we do the same so vm/prebuilt/d-modem
# has no shared-library surprises at runtime inside the runtime VM.

PJSIP_CFLAGS = $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --static --cflags libpjproject)
PJSIP_LIBS   = $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --static --libs   libpjproject)

CFLAGS  ?= -O2 -Wall
# Note: upstream D-Modem builds with -DWITH_AUDIO, which enables a
# splitter/combiner that feeds call audio to a local soundcard for
# monitoring. In a headless VM that functionality is dead weight and
# pulls in pjmedia-audiodev/pjmedia-splitcomb dependencies we don't
# otherwise need. We deliberately omit -DWITH_AUDIO here.
#
# We need TWO include paths:
#   1. -I<parent-of-slmodemd>  — so `#include "slmodemd/modem.h"` in
#                                d-modem.c resolves.
#   2. -I$(SLMODEMD_DIR)        — so `#include <modem_defs.h>` inside
#                                slmodemd/modem.h resolves (angle-
#                                bracket includes search the -I path
#                                list directly).
# `$(dir $(SLMODEMD_DIR:/=))` strips any trailing slash and returns
# the parent directory.
CFLAGS  += -I$(dir $(SLMODEMD_DIR:/=)) -I$(SLMODEMD_DIR) $(PJSIP_CFLAGS)
LDFLAGS ?=
LDLIBS  += $(PJSIP_LIBS)

.PHONY: all clean

all: d-modem

d-modem: d-modem.c $(SLMODEMD_DIR)/modem.h
	$(CC) $(CFLAGS) -o $@ d-modem.c $(LDFLAGS) $(LDLIBS)

clean:
	rm -f d-modem d-modem.o
