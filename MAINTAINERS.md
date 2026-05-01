# MAINTAINERS.md — release and reproducibility workflow

This document is for synthmodem maintainers preparing a release,
satisfying GPL §3(a) corresponding-source obligations, or rebuilding
the shipped binaries from source. End users do not need any of this
— they download a release tarball, run `npm install`, and start the
process. See `README.md` for the user path.

For per-component license attribution and the full
corresponding-source statement, see `COPYING`. For the catalog of
vendored upstream sources, see `vm/sources/README.md`. For the
shipped binaries themselves, see `vm/prebuilt/README.md` and
`vm/prebuilt/PROVENANCE.txt`.

## Two-script workflow

The maintainer-side workflow is split into two phases:

1. **Vendoring** — populate `vm/sources/` and the toolchain `.deb`
   cache. Required for distribution (GPL §3(a) compliance) and for
   any subsequent rebuild. Run once per release, or whenever an
   upstream pin moves.

2. **Rebuilding prebuilts** — produce fresh `vm/prebuilt/*` binaries
   from the vendored sources. Only required when a vendored source
   actually changed. The committed `vm/prebuilt/*` is authoritative
   between rebuilds.

Two top-level wrapper scripts cover these phases:

```
scripts/vendor-sources.sh       # phase 1
scripts/rebuild-prebuilts.sh    # phase 2 (requires phase 1 first)
```

Each is idempotent and re-runs cheaply.

## Phase 1: Vendoring

Run once per workstation, or whenever you bump a pin:

```sh
scripts/vendor-sources.sh
```

What it does:

| Step | What it populates                                | Size       |
|------|--------------------------------------------------|------------|
| 1    | `vm/sources/*` — GPL/LGPL upstream tarballs      | ~285 MB    |
| 2    | `~/.cache/synthmodem/debs/*` — toolchain `.deb`s | ~115 MB    |

After step 1, `vm/sources/` contains the corresponding source for
every GPL/LGPL binary the repository ships (Linux kernel, busybox,
glibc, PJSIP). This satisfies GPL §3(a). Commit `vm/sources/`
contents to git so every clone of the repo is itself a complete
distribution.

After step 2, `~/.cache/synthmodem/debs/` contains the Debian
bookworm i386 toolchain `.deb`s used inside the build VM. This is
NOT shipped — it's a host-side cache so subsequent rebuilds run
without network access. Each cached file is verified against its
pinned SHA256.

Internally, `scripts/vendor-sources.sh` calls
`scripts/fetch-vm-sources.sh` then `scripts/fetch-vm-binaries.sh`.

## Phase 2: Rebuilding prebuilts

Only run when a vendored source actually moved. **The committed
`vm/prebuilt/*` is authoritative**; never rebuild "just to be sure."

Prerequisites (run phase 1 first):

```sh
scripts/vendor-sources.sh   # if not already done
```

Then:

```sh
scripts/rebuild-prebuilts.sh
```

What it does:

| Step | What it produces                                 | Time (TCG) |
|------|--------------------------------------------------|------------|
| 1    | `vm/prebuilt/slmodemd`                           | ~9 min     |
| 2    | `vm/prebuilt/d-modem`                            | ~32 min*   |
| 2    | `vm/prebuilt/modemd-tunnel-i386`                 | (same VM)  |
| 2    | `vm/prebuilt/modemd-ctrl-i386`                   | (same VM)  |
| 2    | `vm/prebuilt/pjsip-test-peer-i386`               | (same VM)  |
| 3    | `vm/images/bzImage` + `vm/images/rootfs-slmodemd-pjsip.cpio.gz` | seconds |

\* First rebuild only. Subsequent runs reuse the cached PJSIP
install at `~/.cache/synthmodem/pjsip/pjsip.install.tar` and
finish in ~3 minutes (just rebuilds d-modem and the helpers). On
hosts with KVM (Linux) or HVF (macOS), expect a few minutes
total for both step 1 and step 2 even on a cold rebuild.

Internally, `scripts/rebuild-prebuilts.sh` calls (in order):

```
scripts/build-slmodemd-in-vm.sh
scripts/build-pjsip-in-vm.sh
make -C vm
```

After completion, compare the new `vm/prebuilt/*` hashes against
`vm/prebuilt/PROVENANCE.txt`:

```sh
sha256sum vm/prebuilt/slmodemd vm/prebuilt/d-modem \
          vm/prebuilt/modemd-tunnel-i386 \
          vm/prebuilt/modemd-ctrl-i386 \
          vm/prebuilt/pjsip-test-peer-i386
```

A clean working tree should reproduce every hash exactly.
**Exception:** `modemd-ctrl-i386` embeds `git describe --dirty` as
its BUILD_ID; rebuilding from a dirty working tree produces a
different hash than the committed value, even though the binary
is otherwise byte-equivalent.

If hashes differ for a binary that should be reproducible:

- Commit the working tree first, then re-run, to rule out the
  `--dirty` BUILD_ID effect.
- Diff `vm/prebuilt/PROVENANCE.txt` against the rebuild output —
  one of the inputs (toolchain version, kernel, glibc, source
  pin) may have moved.
- If you intend the change, update `PROVENANCE.txt` to record
  the new hashes and commit the new binaries together with the
  source change in a single logical commit.

## Per-component pin updates

When you bump a vendored pin, the workflow is:

| Source           | Pin location                              | After bump, also update                |
|------------------|-------------------------------------------|----------------------------------------|
| Linux kernel     | `scripts/fetch-vm-sources.sh`             | `scripts/fetch-vm-binaries.sh` (matching `.deb`) |
| busybox          | `scripts/fetch-vm-sources.sh`             | `scripts/fetch-vm-binaries.sh`         |
| glibc            | `scripts/fetch-vm-sources.sh`             | `scripts/fetch-vm-binaries.sh`         |
| PJSIP            | `scripts/fetch-vm-sources.sh`             | `vm/pjsip/UPSTREAM.txt`                |
| slmodemd         | `vm/slmodemd/UPSTREAM.txt` + the source tree itself (refresh via `scripts/fetch-slmodemd.sh`) | none |
| d-modem.c        | `vm/d-modem/UPSTREAM.txt` + copy in the new file | update `file-sha256` line in UPSTREAM.txt |
| Debian toolchain | `scripts/fetch-vm-binaries.sh`            | `vm/prebuilt/PROVENANCE.txt` toolchain table |

After any pin update:

```sh
scripts/vendor-sources.sh        # re-fetch with new pins
scripts/rebuild-prebuilts.sh     # rebuild against new sources
# Verify, update PROVENANCE.txt, commit everything together.
```

## GPL compliance checklist

Before publishing a release tarball, confirm the following are
present in the distribution:

- [ ] `COPYING` at the repository root
- [ ] `licenses/` directory with `GPL-2.0.txt`, `SLMODEMD-BSD-3.txt`,
      `DSPLIBS-NOTICE`, `D-MODEM-NOTICE`, `PJSIP-NOTICE`,
      `README.md`
- [ ] `vm/sources/` populated (every GPL-required upstream tarball
      from group 1 + group 2 of `vm/sources/README.md` is present)
- [ ] `vm/slmodemd/` source tree
- [ ] `vm/d-modem/d-modem.c`
- [ ] `vm/tunnel/` source tree
- [ ] `vm/ctrl/` source tree
- [ ] `vm/pjsip-test-peer/` source tree (if shipping the test peer)
- [ ] `vm/pjsip/UPSTREAM.txt` and `vm/d-modem/UPSTREAM.txt` with
      current pins
- [ ] `MAINTAINERS.md` (this file)
- [ ] `vm/prebuilt/PROVENANCE.txt` matching the shipped binaries

`scripts/vendor-sources.sh --verify` runs the file-presence and
SHA256 checks for the upstream tarballs in step 1 of phase 1.
There is no automated check for the rest of the list above; review
manually.

## Kernel tarball size: GitHub 100 MB limit

`vm/sources/linux_6.1.159.orig.tar.xz` is 131 MB and exceeds
GitHub's per-file size limit. Pick one of the following for your
release; the choice is per-release and not yet baked into the
tooling.

1. **Git LFS.** Track `linux_*.orig.tar.xz` (or all `*.orig.tar.*`)
   with Git LFS. Add to `.gitattributes`:

       vm/sources/linux_*.orig.tar.xz filter=lfs diff=lfs merge=lfs -text

   Standard tool, conservative choice. Requires `git lfs` on every
   clone.

2. **Unpack the tree.** Commit `vm/sources/linux-6.1.159/` as a
   regular git tree. Individual source files are all tiny so the
   per-file limit is not hit. Repo gets bigger; clone size jumps
   to ~1.4 GB uncompressed. Verification against upstream is
   harder because nobody re-tars from a committed tree.

3. **External hosting.** Keep the 131 MB tarball on a GitHub
   Release asset or S3 bucket; in `vm/sources/` keep only
   `SHA256SUMS` and a fetch URL. `scripts/fetch-vm-sources.sh`
   already supports verifying against `SHA256SUMS`. Adds a
   network step for verification but keeps the git repo lean.

4. **Split tarball.** Split the orig tarball into N <100 MB parts
   at commit time, recombine on fetch. Custom tooling, no LFS
   dependency.

Document the chosen approach in your release notes and update
`vm/sources/README.md`'s "Size notes and GitHub limits" section
to describe the operational mechanic. This is a known gap; the
final maintainer call should be made before any v1 public
release.

## Release packaging

The shipped release tarball is built from a clean working tree
with the following exclusions (see `Handoff.md` for the
authoritative `tar` invocation):

- `.git/` — too big, recipients have their own repos
- `node_modules/` — recipients run `npm install`
- `captures/*` (but keep the `captures/` directory itself) —
  per-call artifacts, huge, host-specific
- `build/` — node-gyp intermediates
- `vm/.rootfs-build/` — Makefile staging
- `vm/sources/*.tar.*`, `vm/sources/*.dsc`, `vm/sources/*.diff.gz` —
  use `scripts/vendor-sources.sh` to populate these on receipt
- Source-tree intermediates: `vm/slmodemd/*.o` (except
  `dsplibs.o`!), `vm/slmodemd/slmodemd`, `vm/slmodemd/modem_test`,
  `vm/ctrl/modemd-ctrl`, `vm/ctrl/modemd-ctrl-i386`,
  `vm/tunnel/modemd-tunnel`
- `*.raw`, `.DS_Store` — debug dumps and macOS metadata

⚠️ Do NOT exclude `vm/slmodemd/dsplibs.o` — that's the proprietary
DSP blob, REQUIRED for the slmodemd-pjsip backend, and committed
under explicit permissive redistribution terms (see
`licenses/DSPLIBS-NOTICE`). It happens to match `*.o` so the
exclude pattern in tar must be specific enough to leave it alone.

The resulting tarball is roughly 21 MB. If it grows much beyond
that, something unintended is being packed.

## Quick reference: typical sessions

**Brand-new clone, want to be ready to release:**

```sh
scripts/vendor-sources.sh        # ~285 MB downloads
git add vm/sources && git commit -m 'vendor sources'
# done — vm/prebuilt/* is already committed authoritative
```

**Bumped a vendored source pin:**

```sh
scripts/vendor-sources.sh        # re-fetch (only what moved)
scripts/rebuild-prebuilts.sh     # rebuild affected binaries
sha256sum vm/prebuilt/*          # confirm against PROVENANCE.txt
# Update PROVENANCE.txt with new hashes if the bump was intentional.
git commit -am 'bump <component> to <version>; rebuild prebuilts'
```

**Just want to verify the committed binaries reproduce:**

```sh
scripts/vendor-sources.sh
scripts/rebuild-prebuilts.sh
diff <(sha256sum vm/prebuilt/* | sort) \
     <(grep '^  SHA256:' vm/prebuilt/PROVENANCE.txt | sort)
# (modemd-ctrl-i386 will differ if working tree is dirty.)
```

## Native Node.js addon (win-timer-resolution)

Separate from the VM-prebuilt workflow above, synthmodem ships a
small native Node.js addon that raises the Windows multimedia timer
to 1 ms. This is needed by **every backend that runs the modem DSP
on Node's event loop on Windows**: `native` throughout the call,
and `auto` during its post-swap phase (when V.8 has timed out and
the call has handed off from slmodemd-pjsip to native). The
`slmodemd-pjsip` backend alone does not need this — its DSP and
pacing run in C inside the VM on PJSIP's own clock.

> **Note for future maintainers.** The startup-time check that
> claims the 1 ms timer (in `src/index.js`) currently keys off
> `config.modem.backend === 'native' || backend === 'auto'`. **If a
> future fourth backend is added that runs the native DSP on the
> host event loop, that condition MUST be extended to include it.**
> Forgetting to do this caused a multi-day diagnostic arc when the
> `auto` backend was first added (2026-04-30) — the symptom is
> intermittent garbage characters on the caller's terminal during
> long pure-marking idle, often masked by audio capture being
> enabled (sync `fs.writeSync` per audio chunk happens to dampen
> the timer-quantum bursts). See `Handoff.md` for the full
> diagnostic story.

See `native/win-timer-resolution/README.md` for the technical
rationale and `Handoff.md` (or whichever phase-history doc
supersedes it) for the diagnostic arc that led to it.

The addon is N-API and ABI-stable across Node major versions, so a
single binary built once works on every later Node major version
without rebuilding. It compiles to a no-op stub on non-Windows
targets, so it's irrelevant on Linux and macOS.

### Refreshing the win32-x64 prebuilt

Run on a Windows x64 machine with **Visual Studio Build Tools 2019+
(C++ workload)** and **Python 3** installed. node-gyp ships with
npm; you don't need to install it separately.

```cmd
npm run build:prebuilt
```

That:

1. Invokes `node-gyp rebuild` for `native/win-timer-resolution/`
   (via the bundled `node-gyp.js` directly, not via `npx.cmd` —
   `npx.cmd` is broken since Node 18.20.2 / 20.12.2 / 21.7.3 due
   to CVE-2024-27980).
2. Copies the produced `.node` file into
   `native/win-timer-resolution/prebuilt/win32-x64/win_timer_resolution.node`.

Then commit the resulting file:

```cmd
git add native/win-timer-resolution/prebuilt/win32-x64/win_timer_resolution.node
git commit -m "win-timer-resolution: refresh win32-x64 prebuilt"
```

End users on Windows x64 then `npm install` and pick up the
prebuilt automatically — no compiler required.

### Verifying the prebuilt reproduces

To confirm the committed binary matches the source:

```cmd
del native\win-timer-resolution\prebuilt\win32-x64\win_timer_resolution.node
npm run build:prebuilt
```

The build is deterministic for our 80 lines of C++; the bytes will
match exactly modulo Visual Studio version differences. If you
upgrade VS or change the source, recommit the new binary.

### Other architectures

We don't ship prebuilts for win32-ia32 or win32-arm64. Users on
those architectures fall through to the from-source build path
during `npm install`. They need the same VS Build Tools + Python 3
prerequisites. If `npm install` succeeds and the addon was built,
the runtime wrapper finds it under `build/Release/`. If the
toolchain isn't present, `npm install` still succeeds with a
warning and the app runs without the timer fix.

If you ever want to ship a prebuilt for one of these architectures
too, run `npm run build:prebuilt` on a machine of that arch and
commit the result. The directory layout and runtime loader already
support `prebuilt/<plat>-<arch>/` for any combination.

### Windows .zip release

Provide a SynthModem-win-x64.zip file that is a copy of the repository with the following files removed:

(note vm/ keeps only images and qemu-runner)
build/
docs/
MAINTAINERS.md
test/
test-client/ (may come back when working)
tools/
vm/buildroot
vm/busybox
vm/ctrl
vm/d-modem
vm/kernel
vm/libc
vm/Makefile
vm/overlay-pjsip
vm/pjsip
vm/pjsip-test-peer
vm/prebuilt
vm/slmodemd
vm/sources
vm/tunnel
win/qemu-source
win/nodejs-release
.git
.gitattributes
.gitignore

Must remain < 100MB compressed.
