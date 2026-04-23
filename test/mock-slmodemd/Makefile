# Makefile — mock slmodemd for local testing.
#
# We build as a plain 64-bit native binary (no -m32, no dsplibs.o); this
# is ONLY a test harness for environments where the real i386 slmodemd
# can't run (sandboxes, macOS dev boxes, Windows CI without multiarch).
#
# The mock includes vm/slmodemd/modem.h to get the exact struct layout
# the real slmodemd writes on its startup socket, so the shim sees an
# identical byte stream.
#
# Requires libutil (for openpty/ptsname_r/etc.) on glibc. On musl the
# PTY functions live in libc directly; the -lutil link is still
# harmless on most toolchains.

CC      ?= cc
CFLAGS  ?= -O2 -g -Wall -Wextra -Wno-unused-parameter -I../../vm/slmodemd
LDFLAGS ?=
LDLIBS  ?= -lutil

SRCS := mock-slmodemd.c
OBJS := $(SRCS:.c=.o)
BIN  := mock-slmodemd

.PHONY: all clean
all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJS) $(BIN)
