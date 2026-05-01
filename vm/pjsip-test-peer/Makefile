# vm/pjsip-test-peer/Makefile
#
# Builds pjsip-test-peer inside the bookworm build VM. Test-only
# binary; built alongside d-modem because it links the same PJSIP
# install tree.
#
# Required inputs:
#   PJSIP_PREFIX   — where `make install` placed PJSIP headers + libs
#                    (defaults to /build/pjsip.install in build VM)
#
# Example:
#   make PJSIP_PREFIX=/build/pjsip.install

PJSIP_PREFIX    ?= /build/pjsip.install
PKG_CONFIG_PATH  = $(PJSIP_PREFIX)/lib/pkgconfig

PJSIP_CFLAGS = $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --static --cflags libpjproject)
PJSIP_LIBS   = $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --static --libs   libpjproject)

CFLAGS  ?= -O2 -Wall
CFLAGS  += $(PJSIP_CFLAGS)
LDFLAGS ?=
LDLIBS  += $(PJSIP_LIBS)

.PHONY: all clean

all: pjsip-test-peer

pjsip-test-peer: pjsip-test-peer.c
	$(CC) $(CFLAGS) -o $@ pjsip-test-peer.c $(LDFLAGS) $(LDLIBS)

clean:
	rm -f pjsip-test-peer pjsip-test-peer.o
