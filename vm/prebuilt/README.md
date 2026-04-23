# vm/prebuilt/ — Shipped binaries built from vendored source

This directory contains binaries that are part of the shipped VM image
but whose build process requires a specific userspace environment, so
we pre-build them once and commit the results here rather than asking
end users to build them.

## Why pre-built?

**slmodemd** is dynamically linked against glibc. Its binary must link
only against symbols present in the glibc version shipping inside the
runtime VM (Debian bookworm's `libc6 2.36-9+deb12u13`, i.e. glibc 2.36).

On modern build hosts (Ubuntu 24.04+, Fedora 39+, Arch, etc.) the host
glibc is ≥ 2.38, which quietly redirects `strtol` and `strtoul` to
`__isoc23_strtol` / `__isoc23_strtoul` (a C23 renaming introduced in
glibc 2.38). A binary built on such a host fails to load inside the
runtime VM with:

    version `GLIBC_2.38' not found (required by slmodemd)

To produce a VM-compatible binary reliably, we build slmodemd **inside
a bookworm i386 environment** and ship the result. The build recipe is
`scripts/build-slmodemd-in-vm.sh`, which launches the runtime VM
kernel with a temporary builder initramfs (Debian toolchain extracted
from pinned .debs).

## What's here

| File                | Size     | Architecture     | Linked against               |
|---------------------|----------|------------------|------------------------------|
| `slmodemd`          | 1.65 MB  | ELF 32-bit i386  | glibc 2.36 (Debian bookworm) |
| `modemd-shim-i386`  | 20 KB    | ELF 32-bit i386  | glibc 2.36 (Debian bookworm) |

Exact SHA256s are recorded in `PROVENANCE.txt`.

## Provenance and reproducibility

See `PROVENANCE.txt` for the exact versions of every input — the
vendored slmodemd source commit, kernel, glibc, toolchain packages —
used to produce this binary.

To reproduce:

    scripts/build-slmodemd-in-vm.sh

This will:
1. Extract the Debian bookworm i386 toolchain from the pinned .deb URLs
   listed in the script.
2. Build a temporary builder initramfs that combines the toolchain with
   the `vm/slmodemd/` source tree.
3. Boot the builder initramfs under QEMU using the runtime kernel.
4. Run `make` inside the VM against bookworm's glibc 2.36 + headers.
5. Copy the resulting binary out via a 9p virtfs share.
6. Write it to `vm/prebuilt/slmodemd`, replacing whatever's there.

The SHA256 should match PROVENANCE.txt exactly if nothing in the input
chain changed. A mismatch means one of the inputs moved — investigate
before committing the new binary.

## Updating

`vm/prebuilt/slmodemd` should be regenerated whenever:

- `vm/slmodemd/` source is refreshed via `scripts/fetch-slmodemd.sh`
- Runtime glibc pin changes (e.g. Debian bumps `libc6 2.36-9+deb12u13`
  to a new security-patch-level revision)
- You believe the build environment drifted and want a fresh binary

If none of those things changed, don't rebuild — the committed binary
is authoritative.

## Why modemd-shim is prebuilt too

Originally the shim wasn't prebuilt — the plan was "it's our own code,
easy to build on any host." That plan didn't survive contact with
glibc 2.38.

The shim uses `atoi()` twice (parsing fd numbers out of argv). On
Ubuntu 24.04 and newer hosts, glibc's `stdlib.h` redirects `atoi`
through `strtol`, which was C23-renamed to `__isoc23_strtol` in
glibc 2.38. A shim built on such a host fails to load inside our VM
(glibc 2.36) with the same `GLIBC_2.38 not found` error that caused
us to prebuild slmodemd in the first place.

So both binaries go through the same build-VM recipe, and both are
committed here. End users never compile either one.

## GPL note

Both binaries here are GPL-2.0-or-later (slmodemd from vendored
source in `vm/slmodemd/`, shim from `vm/shim/`). The corresponding
source is committed at `vm/slmodemd/`, `vm/shim/`, and `vm/sources/`
— see the top-level `COPYING` for the GPL compliance story.
