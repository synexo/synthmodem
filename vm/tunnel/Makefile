# vm/tunnel/Makefile
#
# Builds modemd-tunnel, the VM-side UDP↔TCP bridge for backend B.
# Invoked by scripts/build-pjsip-in-vm.sh inside the bookworm build VM
# so the resulting binary links against glibc 2.36 (matching the
# runtime VM).
#
# Host-builds will work on dev hosts with glibc ≤ 2.36 but produce
# binaries with __isoc23_* symbols on modern Ubuntu / Fedora — and
# those binaries won't load in the runtime VM. Use
# scripts/build-pjsip-in-vm.sh for the authoritative build.

CC       ?= gcc
CFLAGS   ?= -O2 -Wall -Wextra
LDFLAGS  ?=

.PHONY: all clean

all: modemd-tunnel

modemd-tunnel: modemd-tunnel.c
	$(CC) $(CFLAGS) -o $@ modemd-tunnel.c $(LDFLAGS)

clean:
	rm -f modemd-tunnel modemd-tunnel.o
