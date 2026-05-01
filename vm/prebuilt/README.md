# vm/prebuilt/ — Shipped binaries built from vendored source

This directory contains binaries that are part of the shipped VM image
but whose build process requires a specific userspace environment
(Debian bookworm i386 + its glibc 2.36 toolchain). Rather than asking
end users to reproduce that environment, we pre-build the binaries
once on the maintainer's host and commit the results here.

## Why pre-built?

**glibc compatibility.** Every binary here is dynamically linked
against glibc and must link only against symbols present in the glibc
version shipping inside the runtime VM (Debian bookworm's
`libc6 2.36-9+deb12u13`, i.e. glibc 2.36).

On modern build hosts (Ubuntu 24.04+, Fedora 39+, Arch, etc.) the host
glibc is ≥ 2.38, which quietly redirects calls like `atoi`, `strtol`,
`strtoul`, and `sscanf` to their C23-renamed `__isoc23_*` symbols (a
GCC + glibc convention introduced in glibc 2.38). A binary built on
such a host fails to load inside the runtime VM with:

    version `GLIBC_2.38' not found (required by ...)

To produce VM-compatible binaries reliably, every binary here is
built **inside a bookworm i386 builder VM** and the resulting ELF
images are committed to git.

## What's here

| File                       | Size     | Architecture     | Linked against               | Source              |
|----------------------------|----------|------------------|------------------------------|---------------------|
| `slmodemd`                 | ~1.65 MB | ELF 32-bit i386  | glibc 2.36 (Debian bookworm) | `vm/slmodemd/`      |
| `d-modem`                  | ~1.78 MB | ELF 32-bit i386  | glibc 2.36 + static PJSIP    | `vm/d-modem/`, `vm/sources/pjproject-2.15.1.tar.gz` |
| `modemd-tunnel-i386`       | ~20 KB   | ELF 32-bit i386  | glibc 2.36 (Debian bookworm) | `vm/tunnel/`        |
| `modemd-ctrl-i386`         | ~20 KB   | ELF 32-bit i386  | glibc 2.36 (Debian bookworm) | `vm/ctrl/`          |
| `pjsip-test-peer-i386`     | ~1.76 MB | ELF 32-bit i386  | glibc 2.36 + static PJSIP    | `vm/pjsip-test-peer/` |

Plus this `README.md` and `PROVENANCE.txt`.

Exact SHA256 hashes for each binary are recorded in `PROVENANCE.txt`.

## What each binary does

- **`slmodemd`** — the modem DSP. Originated as Smart Link's user-space
  driver for their soft-modem hardware; we drive it as a pure software
  modem against synthetic G.711 audio. PTY-based AT command interface
  plus a pulse-coded audio stream over a socketpair.

- **`d-modem`** — PJSIP `pjmedia_port` subclass, vendored verbatim from
  the synexo/D-Modem project. Bridges a PJSIP audio call to slmodemd's
  socketpair, giving slmodemd PCM samples paced by PJSIP's media
  scheduler. Statically links PJSIP 2.15.1.

- **`modemd-tunnel-i386`** — the in-VM endpoint of synthmodem's
  UDP-over-TCP tunnel. PJSIP inside the VM speaks UDP on the loopback;
  this helper reads those UDP datagrams off the loopback and ships
  them to Node on the host over a TCP virtio-serial chardev (and the
  reverse direction). Wire protocol is documented in
  `vm/tunnel/PROTOCOL.md`.

- **`modemd-ctrl-i386`** — bridges slmodemd's PTY to a TCP virtio-serial
  chardev. Lets Node on the host drive AT commands and exchange
  data-mode bytes with slmodemd inside the VM. Wire protocol shared
  with `modemd-tunnel`'s control plane via the header at
  `vm/ctrl/wire.h`.

- **`pjsip-test-peer-i386`** — a tiny PJSIP UAS that answers a fixed
  number, plays back, and hangs up. Used in `test/pjsip/*` integration
  tests to give the in-VM PJSIP something to talk to without standing
  up a real BBS. Production runtime never uses it.

## Provenance and reproducibility

See `PROVENANCE.txt` for the exact versions of every input — vendored
source commits, kernel, glibc, toolchain packages, and PJSIP release —
used to produce each binary.

To reproduce locally:

    # First time: vendor sources + toolchain (~285 MB GPL source +
    # ~115 MB toolchain .debs cached at ~/.cache/synthmodem/debs)
    scripts/fetch-vm-sources.sh
    scripts/fetch-vm-binaries.sh

    # Build slmodemd (~9 minutes under sandbox TCG, much faster
    # with KVM/HVF).
    scripts/build-slmodemd-in-vm.sh

    # Build d-modem + helpers (~32 minutes under sandbox TCG, much
    # faster with KVM/HVF; subsequent runs are ~3 minutes via the
    # PJSIP install cache at ~/.cache/synthmodem/pjsip/).
    scripts/build-pjsip-in-vm.sh

The build scripts overwrite `vm/prebuilt/*` in place. Compare against
`PROVENANCE.txt` to verify the rebuild reproduced the committed
hashes; differences in `modemd-ctrl-i386` from a dirty working tree
are expected (the binary embeds `git describe --dirty` as its
BUILD_ID).

For the maintainer-facing release workflow, see `MAINTAINERS.md` at
the repository root.

## When to rebuild

The committed binaries are authoritative. Rebuild only when:

- A vendored source has changed (`vm/slmodemd/`, `vm/d-modem/`,
  `vm/tunnel/`, `vm/ctrl/`, `vm/pjsip-test-peer/`), or
- The runtime glibc pin moves (rare — Debian bookworm bumps), or
- The PJSIP version pin moves
  (`scripts/fetch-vm-sources.sh` + `vm/pjsip/UPSTREAM.txt`)

Otherwise, leave them alone.

## GPL note

All binaries here are GPL-2.0-or-later. The corresponding source is
committed under `vm/slmodemd/`, `vm/d-modem/`, `vm/tunnel/`,
`vm/ctrl/`, `vm/pjsip-test-peer/`, and `vm/sources/`. See the
top-level `COPYING` for the full attribution table and `MAINTAINERS.md`
for the GPL §3(a) corresponding-source obligations.
