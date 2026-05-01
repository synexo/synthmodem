# vm/pjsip/

Build-time customization of the PJSIP library that d-modem.c links
against. PJSIP itself is NOT vendored here — its source tarball lives
in `vm/sources/pjproject-2.15.1.tar.gz` (committed to git, SHA256
pinned) and is unpacked/built inside the Debian bookworm build VM by
`scripts/build-vm-binaries.sh`.

## Contents

| File            | Purpose |
|-----------------|---------|
| `config_site.h` | Injected into the PJSIP source tree before ./configure |
| `UPSTREAM.txt`  | Pins the PJSIP release version, tarball URL, and tarball SHA256 |

## Why PJSIP source isn't unpacked here

PJSIP 2.15.1 is ~130 MB unpacked (~10 MB as a tarball) and we ship it
verbatim from upstream with zero source patches. Unpacking it into git
would add a lot of bulk for no benefit — the tarball in `vm/sources/`
is both more compact and a cleaner provenance artifact (one file,
one SHA256, exact byte-for-byte match to the upstream release).

## Building

The build happens inside the bookworm build VM. In summary:

1. `scripts/fetch-vm-sources.sh` downloads and verifies
   `vm/sources/pjproject-2.15.1.tar.gz` against its pinned SHA256.
2. `scripts/build-vm-binaries.sh` boots the bookworm VM, unpacks the
   tarball, copies `vm/pjsip/config_site.h` into the right place inside
   the extracted tree, runs `./configure --disable-video`, runs `make`
   and `make install` into a staging prefix, then builds `d-modem`
   against that staging install.
3. Output: `vm/prebuilt/d-modem` (statically linked against PJSIP).

This is the same pattern used today for `vm/prebuilt/slmodemd`, just
with an additional library dependency.

See `UPSTREAM.txt` for the exact PJSIP version pinned.
