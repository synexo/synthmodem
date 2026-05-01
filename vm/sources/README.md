# vm/sources/ — Corresponding Source for Redistributed Binaries

This directory holds unmodified upstream source tarballs for every
GPL/LGPL-licensed binary we redistribute, plus — for offline
reproducibility — the toolchain used to build those binaries inside
the Debian bookworm build VM.

## Do not delete these files

If they are missing, this repository is not a GPL-compliant distribution
of the binaries in `vm/kernel/`, `vm/busybox/`, `vm/libc/`, and
`vm/prebuilt/`.

They are kept in git so every clone of the repo includes the corresponding
source (GPL-2 §3(a) compliance).

## Three classes of files

The vendored sources split into three groups with different reasons
for being vendored.

### 1. Required for GPL/LGPL compliance — Debian-sourced

These are source tarballs fetched from Debian's archive, whose
compiled outputs we redistribute.

| Source | Binary it corresponds to |
|--------|--------------------------|
| `linux_6.1.159.orig.tar.xz` + debian.tar.xz + .dsc | `vm/kernel/bzImage`, virtio .ko modules |
| `busybox_1.35.0.orig.tar.bz2` + debian.tar.xz + .dsc | `vm/busybox/busybox` |
| `glibc_2.36.orig.tar.xz` + debian.tar.xz + .dsc | `vm/libc/ld-linux.so.2`, `vm/libc/libc.so.6`, `vm/libc/libm.so.6` |

These MUST be here for any GPL-compliant distribution.
`scripts/fetch-vm-sources.sh` downloads them with pinned SHA256
verification from `https://deb.debian.org/debian/pool/main/...`.

### 2. Required for GPL compliance — upstream-sourced

PJSIP is not packaged for Debian bookworm i386 at the version we
need, so we fetch it directly from the upstream GitHub release.

| Source | Binary it corresponds to |
|--------|--------------------------|
| `pjproject-2.15.1.tar.gz` | `vm/prebuilt/d-modem` (links PJSIP statically) |

This file is fetched from `https://github.com/pjsip/pjproject/archive/refs/tags/2.15.1.tar.gz`
and verified against the SHA256 pinned in `scripts/fetch-vm-sources.sh`.
The tarball is byte-identical to the `pjproject-2.15.1/` subtree
bundled in `synexo/D-Modem` at the commit pinned in
`vm/d-modem/UPSTREAM.txt` (verified at vendor time, 2026-04-23).

`d-modem.c` itself is vendored separately at `vm/d-modem/d-modem.c`
as an in-tree source file — it's ~29 KB and is the component whose
customizations we actively track, so it belongs in the main tree
rather than in a tarball here.

### 3. Vendored for offline reproducibility (not required by license)

These are the toolchain sources used by the build VM to produce the
binaries in group 1 and group 2:

| Source | What it builds |
|--------|----------------|
| `gcc-12_12.2.0.orig.tar.gz` + debian.tar.xz + .dsc | The GCC compiler used inside the build VM |
| `binutils_2.40.orig.tar.xz` + debian.tar.xz + .dsc | The assembler and linker |
| `make-dfsg_4.3.orig.tar.gz` + diff.gz + .dsc | GNU make |

GPL does **not** require shipping the toolchain's source alongside
the binary it produced — only the source of the binary itself, which
is covered by groups 1 and 2 plus the vendored sources at
`vm/slmodemd/` and `vm/d-modem/d-modem.c`. The toolchain sources
here are present purely for reproducibility: if Debian's archive
ever loses i386 support and the `.deb` files become hard to retrieve
from official sources, we can still rebuild the build VM from this
repository alone.

If disk space is tight you can delete the toolchain tarballs without
breaking GPL compliance — only groups 1 and 2 matter for that.

## How to populate

From the repository root, on your workstation:

    ./scripts/fetch-vm-sources.sh

That downloads ~285 MB into this directory (~170 MB for GPL-required
sources including PJSIP, plus ~115 MB for the toolchain
reproducibility bundle). Run once per workstation, then commit.

The script is idempotent and re-runs cheaply: files already present
with a matching SHA256 are skipped.

## Covers everything needed for a full from-scratch rebuild

Between this directory, `scripts/fetch-vm-sources.sh`, and the
sibling documents listed below, a fresh clone of synthmodem on a
disconnected workstation can in principle rebuild every binary in
`vm/prebuilt/` without reaching the network, provided the toolchain
tarballs have been fetched and committed:

| What you need               | Where it lives                          |
|-----------------------------|-----------------------------------------|
| Source for the runtime VM's kernel, libc, busybox | `vm/sources/` (group 1) |
| Source for PJSIP            | `vm/sources/pjproject-2.15.1.tar.gz`    |
| Source for slmodemd         | `vm/slmodemd/` (in-tree)                |
| Source for d-modem.c        | `vm/d-modem/d-modem.c` (in-tree)        |
| Source for modemd-tunnel    | `vm/tunnel/` (in-tree)                  |
| Source for modemd-ctrl      | `vm/ctrl/` (in-tree)                    |
| PJSIP build customization   | `vm/pjsip/config_site.h` (in-tree)      |
| d-modem build recipe        | `vm/d-modem/Makefile` (in-tree)         |
| In-VM build orchestration   | `scripts/build-slmodemd-in-vm.sh`, `scripts/build-pjsip-in-vm.sh` |
| Toolchain (gcc/binutils/make) source | `vm/sources/` (group 3)        |
| Toolchain .deb binary cache | `scripts/fetch-vm-binaries.sh` populates `~/.cache/synthmodem/debs` |
| License texts and notices   | `licenses/` and the `COPYING` at the repo root |
| Maintainer workflow         | `MAINTAINERS.md` at the repo root       |

## Size notes and GitHub limits

GitHub's per-file limit is 100 MB. File sizes here:

| File | Size | Under 100 MB? |
|------|------|---------------|
| `linux_6.1.159.orig.tar.xz`    | 131 MB | **No** |
| `gcc-12_12.2.0.orig.tar.gz`    |  83 MB | Yes |
| `binutils_2.40.orig.tar.xz`    |  24 MB | Yes |
| `glibc_2.36.orig.tar.xz`       |  19 MB | Yes |
| `pjproject-2.15.1.tar.gz`      |  10 MB | Yes |
| everything else                | < 2 MB | Yes |

The Linux kernel orig tarball at 131 MB exceeds GitHub's limit. The
maintainer must choose one of three handling strategies (LFS, unpacked
tree, or external hosting); see `MAINTAINERS.md` for the criteria and
the chosen approach. This is a per-release decision and is documented
there rather than here.

The three options, summarized:

1. **Git LFS**: track `linux_*.orig.tar.xz` (or all `*.orig.tar.*`)
   with Git LFS. Clean, keeps the tarball intact, standard tool.
   `.gitattributes` would contain:

       vm/sources/linux_*.orig.tar.xz filter=lfs diff=lfs merge=lfs -text

   Conservative option, matches how most kernel-embedding projects
   handle it.

2. **Unpack the kernel source into the repo**: commit
   `vm/sources/linux-6.1.159/` as a regular git tree instead of a
   tarball. Individual source files are all tiny, so no per-file
   limit hit. Repo gets bigger (uncompressed source is ~1.4 GB),
   but clones are still fine on normal networks. Verification
   becomes harder because nobody re-tars from a committed tree.

3. **External hosting**: keep the 131 MB tarball on GitHub Releases
   or an S3 bucket, with only `SHA256SUMS` and a fetch URL in this
   directory. Adds a download step for verification but keeps the
   git repo lean.

4. **Split tarball**: split the orig tarball into N <100 MB parts at
   commit time, recombine on fetch. Custom tooling, low ceremony,
   no LFS dependency.

** This release contains the split tarball for the linux kernel **
```
# sha256sum linux_6.1.159.orig.tar.xz
aee9073581b7b34d516ca28ec2a8473dccb9d169118b587dcbfea5deb269a711  linux_6.1.159.orig.tar.xz

# split -b 70M linux_6.1.159.orig.tar.xz "linux_6.1.159.orig.tar.xz.part"

# ls -l linux_6.1.159.orig.tar.xz.part*
-rwxrwxrwx 1 root root  70M May  1 15:20 linux_6.1.159.orig.tar.xz.partaa
-rwxrwxrwx 1 root root  62M May  1 15:20 linux_6.1.159.orig.tar.xz.partab

# cat linux_6.1.159.orig.tar.xz.part* | sha256sum
aee9073581b7b34d516ca28ec2a8473dccb9d169118b587dcbfea5deb269a711  
```

To restore:
```
cat linux_6.1.159.orig.tar.xz.part* > linux_6.1.159.orig.tar.xz
```

## A note on GitHub-sourced tarballs

`pjproject-2.15.1.tar.gz` is fetched from GitHub's auto-generated
release archive endpoint (`/archive/refs/tags/<tag>.tar.gz`). These
are produced on demand by `git archive` inside GitHub. In practice
the output has been bit-stable for pjproject for years, and our
pinned SHA256 is the ground truth, but upstream cannot guarantee the
byte pattern forever. Three consequences:

- Anyone verifying a cold checkout uses the committed file under
  `vm/sources/`, not a re-fetch — the hash in `SHA256SUMS` matches
  that committed artifact regardless of whether GitHub's archive
  still yields the same bytes at fetch time.
- If the upstream archive ever drifts, `fetch-vm-sources.sh` will
  refuse the download with "SHA256 mismatch — download corrupt or
  upstream changed". That's a signal to investigate, not to update
  the pin reflexively.
- If for any reason we need a more durable source, we can mirror
  the tarball elsewhere (GitHub Release asset on our own repo,
  object storage, etc.) and update the URL in the fetch script.
  The SHA256 would not change because we are verifying the same
  bytes.

## Verification

To verify every file in this directory matches its pinned SHA256:

    ./scripts/fetch-vm-sources.sh --verify

Mismatches mean someone tampered with the tree or the upstream
archive has shifted (rare but possible).

A `SHA256SUMS` file is also written alongside the tarballs for tools
that prefer to use `sha256sum -c` directly:

    cd vm/sources/
    sha256sum -c SHA256SUMS

## Updating

These pins are tied to what Debian bookworm shipped at the time the
runtime VM was built, plus the specific PJSIP release we target.
Upgrading is a deliberate multi-step process:

1. Update URL + SHA256 in `scripts/fetch-vm-sources.sh`.
2. For Debian pins: update `scripts/fetch-vm-binaries.sh` in
   lockstep (binary .debs are from the same Debian release).
3. For PJSIP: update `vm/pjsip/UPSTREAM.txt` to match. If the new
   release needs different configure flags, update
   `vm/pjsip/config_site.h` or `scripts/build-pjsip-in-vm.sh`.
4. For D-Modem / d-modem.c: update `vm/d-modem/UPSTREAM.txt` if the
   upstream commit moves; copy in the new d-modem.c and update the
   `file-sha256:` line.
5. Update `scripts/build-slmodemd-in-vm.sh` and
   `scripts/build-pjsip-in-vm.sh` if the toolchain moved.
6. Run all fetch/build scripts (or use `MAINTAINERS.md`'s
   `scripts/vendor-sources.sh` + `scripts/rebuild-prebuilts.sh`
   wrappers).
7. Rebuild `vm/images/rootfs-slmodemd-pjsip.cpio.gz` and
   `vm/images/bzImage` via `make -C vm`.
8. Boot the VM end-to-end and verify the smoke test passes.
9. Commit everything: new sources, new binaries, new prebuilt,
   updated `PROVENANCE.txt`, updated license notices if applicable.

Changes here should always land together with corresponding binary
changes — they are a single logical bump.
