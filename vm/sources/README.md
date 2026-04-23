# vm/sources/ — Corresponding Source for Redistributed Binaries

This directory holds unmodified upstream source tarballs for every
GPL/LGPL-licensed binary we redistribute, plus — for offline
reproducibility — the toolchain used to build `vm/prebuilt/slmodemd`.

## Do not delete these files

If they are missing, this repository is not a GPL-compliant distribution
of the binaries in `vm/kernel/`, `vm/busybox/`, `vm/libc/`, and
`vm/prebuilt/`.

They are kept in git so every clone of the repo includes the corresponding
source (GPL-2 §3(a) compliance).

## Two classes of files

The vendored sources split into two groups with different reasons for
being vendored.

### Required for GPL/LGPL compliance

These are source tarballs whose compiled outputs we redistribute:

| Source | Binary it corresponds to |
|--------|--------------------------|
| `linux_6.1.159.orig.tar.xz` + debian.tar.xz + .dsc | `vm/kernel/bzImage`, virtio .ko modules |
| `busybox_1.35.0.orig.tar.bz2` + debian.tar.xz + .dsc | `vm/busybox/busybox` |
| `glibc_2.36.orig.tar.xz` + debian.tar.xz + .dsc | `vm/libc/ld-linux.so.2`, `vm/libc/libc.so.6`, `vm/libc/libm.so.6` |

These MUST be here for any GPL-compliant distribution. `scripts/fetch-vm-sources.sh`
downloads them with pinned SHA256 verification.

### Vendored for offline reproducibility (not required by license)

These are the toolchain sources used by `scripts/build-slmodemd-in-vm.sh`
to produce `vm/prebuilt/slmodemd`:

| Source | What it builds |
|--------|----------------|
| `gcc-12_12.2.0.orig.tar.gz` + debian.tar.xz + .dsc | The GCC compiler used inside the build VM |
| `binutils_2.40.orig.tar.xz` + debian.tar.xz + .dsc | The assembler and linker |
| `make-dfsg_4.3.orig.tar.gz` + diff.gz + .dsc | GNU make |

GPL does **not** require shipping the toolchain's source alongside the
binary it produced — only the source of the binary itself, which is
covered by the vendored slmodemd source in `vm/slmodemd/` and the
corresponding-source set above. The toolchain sources here are present
purely for reproducibility: if Debian's archive ever loses i386 support
and the `.deb` files become hard to retrieve from official sources, we
can still rebuild the build VM from this repository alone.

If disk space is tight you can delete the toolchain tarballs without
breaking GPL compliance — only the "Required" set matters for that.

## How to populate

From the repository root, on your workstation:

    ./scripts/fetch-vm-sources.sh

That downloads ~275 MB into this directory (160 MB for GPL-required
sources + 115 MB for the toolchain reproducibility bundle). Run once
per workstation, then commit.

The script is idempotent and re-runs cheaply: files already present
with a matching SHA256 are skipped.

## Size notes and GitHub limits

GitHub's per-file limit is 100 MB. File sizes here:

| File | Size | Under 100 MB? |
|------|------|---------------|
| `linux_6.1.159.orig.tar.xz`    | 131 MB | **No** |
| `gcc-12_12.2.0.orig.tar.gz`    | 83 MB  | Yes |
| `binutils_2.40.orig.tar.xz`    | 24 MB  | Yes |
| `glibc_2.36.orig.tar.xz`       | 19 MB  | Yes |
| everything else                | < 2 MB | Yes |

The Linux kernel orig tarball at 131 MB exceeds GitHub's limit. Three
options to handle this — choose one and document the choice in
`IMPLEMENTATION.md`:

1. **Git LFS**: track `linux_*.orig.tar.xz` (or all `*.orig.tar.*`) with
   Git LFS. Clean, keeps the tarball intact, standard tool.
   `.gitattributes` would contain:

       vm/sources/linux_*.orig.tar.xz filter=lfs diff=lfs merge=lfs -text

   This is the conservative option and matches how most kernel-embedding
   projects handle it.

2. **Unpack the kernel source into the repo**: commit
   `vm/sources/linux-6.1.159/` as a regular git tree instead of a
   tarball. Individual source files are all tiny, so no per-file
   limit hit. Repo gets bigger (uncompressed source is ~1.4 GB),
   but clones are still fine on normal networks. Verification
   becomes harder because nobody re-tars from a committed tree.

3. **External hosting**: keep the 131 MB tarball on GitHub Releases or
   an S3 bucket, with only `SHA256SUMS` and a fetch URL in this
   directory. Adds a download step for verification but keeps the git
   repo lean.

## Verification

To verify every file in this directory matches its pinned SHA256:

    ./scripts/fetch-vm-sources.sh --verify

Mismatches mean someone tampered with the tree or the upstream
archive has shifted (rare but possible).

## Updating

These pins are tied to what Debian bookworm shipped at the time the
runtime VM was built. Upgrading is a deliberate multi-step process:

1. Update URL + SHA256 in `scripts/fetch-vm-sources.sh`.
2. Update `scripts/fetch-vm-binaries.sh` in lockstep (binary .debs are
   from the same Debian release).
3. Update `scripts/build-slmodemd-in-vm.sh` if the toolchain moved.
4. Run all three fetch/build scripts.
5. Rebuild `vm/images/rootfs.cpio.gz` via `make -C vm`.
6. Boot the VM end-to-end and verify the smoke test passes.
7. Commit everything: new sources, new binaries, new prebuilt, updated
   PROVENANCE.txt.

Changes here should always land together with corresponding binary
changes — they are a single logical bump.
