#!/usr/bin/env bash
#
# fetch-vm-sources.sh — populate vm/sources/ with upstream source tarballs
#                       for every GPL/LGPL binary redistributed in the
#                       VM image.
#
# ────────────────────────────────────────────────────────────────────
#
# RATIONALE
#
#   GPL-2 §3(a) requires that when we distribute compiled GPL binaries
#   (kernel bzImage, virtio .ko, busybox, PJSIP-linked binaries), the
#   complete corresponding source must accompany them on the same
#   medium.
#
#   Our chosen medium is this git repository — so the source tarballs
#   must be checked into git and travel with every clone.
#
#   This script downloads and verifies each source tarball. Run it
#   once per workstation; the files are then committed alongside the
#   binaries under vm/sources/.
#
#   glibc is LGPL-2.1; we redistribute libc.so.6 and ld-linux.so.2
#   unmodified and vendor the source here too so we retain the
#   ability to rebuild the VM image if Debian's archive ever goes
#   away.
#
#   PJSIP is GPL-2.0-or-later (dual-licensed with Teluu's commercial
#   option); we redistribute a statically-linked PJSIP binary in
#   vm/prebuilt/ and vendor its source tarball here. See
#   licenses/PJSIP-NOTICE for details.
#
#   Entries come from two upstream archives: Debian's pool (for every
#   package derived from the bookworm runtime VM's ecosystem) and
#   GitHub (for PJSIP, which has no Debian bookworm i386 equivalent
#   that matches what we want to build against). Both are captured
#   by the same SHA256-pinned fetch-and-verify mechanism below.
#
# USAGE
#
#   scripts/fetch-vm-sources.sh            # fetches everything
#   scripts/fetch-vm-sources.sh --verify   # verify existing files only
#
# After this completes:
#   1. Review the contents of vm/sources/.
#   2. git add vm/sources/ && git commit -m "Add vendored source tarballs"
#   3. git push
#
# ────────────────────────────────────────────────────────────────────
#
# PINS
#
#   These versions are what Debian bookworm (the last Debian release
#   shipping an i386 kernel) provided at the time this script was
#   written. They're baked in because the whole point is byte-for-byte
#   correspondence between source and shipped binaries; see
#   scripts/fetch-vm-binaries.sh for the matching binary .debs.
#
#   To upgrade: update URL + SHA256 both here and in fetch-vm-binaries.sh,
#   re-run both, rebuild the VM image, verify boot, commit everything.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/vm/sources"

# Source tarballs. Each entry has the form:
#
#     SHA256 | LOCATOR
#
# LOCATOR is one of:
#   - A Debian pool path like `l/linux/linux_6.1.159.orig.tar.xz`.
#     The full URL is $DEBIAN_BASE_URL/<path>; the destination
#     filename is basename(path).
#   - A full https://... URL. In that case the destination filename
#     is taken from the URL's last path component; if the URL ends
#     in `/archive/refs/tags/<tag>.tar.gz` (GitHub's auto-generated
#     release tarball pattern), the destination filename is rewritten
#     to `<project>-<tag>.tar.gz` so the committed file has a
#     meaningful name rather than just `2.15.1.tar.gz`.
#
# Keep this list in sync with vm/sources/README.md.

SOURCES=(
  # ─── Required for GPL compliance (Debian pool) ────────────────────
  # Corresponding source for every GPL binary we redistribute in the
  # runtime VM image itself (kernel, busybox, glibc). Without these,
  # shipping vm/kernel/bzImage and friends is not a GPL-2 §3(a)
  # compliant distribution.

  # Linux kernel 6.1.159-1 (Debian bookworm) — runtime kernel
  "aee9073581b7b34d516ca28ec2a8473dccb9d169118b587dcbfea5deb269a711|l/linux/linux_6.1.159.orig.tar.xz"
  "1b360e038ac5fc42fd258e64c3fff5bb8ccfb1516feb1d69f17c2eb239ec113e|l/linux/linux_6.1.159-1.debian.tar.xz"
  "2e05b8b357b6810c021b4a0a6ae89c2845976bf6e3461602ad1d136b0a822557|l/linux/linux_6.1.159-1.dsc"

  # busybox 1.35.0-4 (Debian bookworm) — runtime init + utilities
  "faeeb244c35a348a334f4a59e44626ee870fb07b6884d68c10ae8bc19f83a694|b/busybox/busybox_1.35.0.orig.tar.bz2"
  "d611281ea49cfac240a5dfdb0de6f440138e3345490e087d8e39b7434a6bd819|b/busybox/busybox_1.35.0-4.debian.tar.xz"
  "3a867bd80e41345808a2a29b5df5b110b51b4dde956e54b44821a953fb5ebb4f|b/busybox/busybox_1.35.0-4.dsc"

  # glibc 2.36-9+deb12u13 (Debian bookworm) — runtime libc + loader
  "a543c02070d46ccaf866957efd13f10c924daa74c86a90a0254db09a92a708ee|g/glibc/glibc_2.36.orig.tar.xz"
  "728086077548b13c37a348a99f74b9c7a437d6a8aed4aab5e2ed86b3a5ff6df6|g/glibc/glibc_2.36-9+deb12u13.debian.tar.xz"
  "c034e180a28197c8a9d2b378bcf621d87766a49b3d1bb2d82cc25068ba398cac|g/glibc/glibc_2.36-9+deb12u13.dsc"

  # ─── Vendored for offline reproducibility (not required by license) ──
  # These are the sources for the toolchain used by
  # scripts/build-slmodemd-in-vm.sh. GCC/binutils/make produce binaries
  # we redistribute (vm/prebuilt/slmodemd), but the GPL's
  # "corresponding source" obligation does NOT require shipping the
  # compiler's source — only the source of the binary you're shipping.
  # See COPYING / licenses/README.md for the analysis.
  #
  # We vendor these anyway so that if Debian's bookworm archive
  # disappears in the future and i386 support is widely lost, we can
  # still rebuild the build VM from repo contents alone. Without them
  # you'd need to re-download from a Debian snapshot service.

  # GCC 12.2.0-14+deb12u1 (Debian bookworm i386 toolchain)
  "b8298be16aeeb96a889c6afed0a8e2241b47452e89cc81fe65ea849d5c740fcb|g/gcc-12/gcc-12_12.2.0.orig.tar.gz"
  "59f7f7763a0c355e3f27ff9e7ac80d06382b29939361a87e7b139226bfe7402e|g/gcc-12/gcc-12_12.2.0-14+deb12u1.debian.tar.xz"
  "3aed0b189189c744dc9f4b74798a51d3e512ea85e492568db788a927c88e20ba|g/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc"

  # binutils 2.40-2 (Debian bookworm)
  "d78c2d2eb24a9be1e02f8854cb1bd435556d7f584fb6bfb6b07e6527d43fc41d|b/binutils/binutils_2.40.orig.tar.xz"
  "a71c03e51d7ac2be8d97daa29dc02e578978c8eeddfd51045502fd008cec8adc|b/binutils/binutils_2.40-2.debian.tar.xz"
  "cd75da7829d819189ba6154d408666373b307e222b393223804c4c4a7156f421|b/binutils/binutils_2.40-2.dsc"

  # make 4.3-4.1 (Debian bookworm)
  "be4c17542578824e745f83bcd2a9ba264206187247cb6a5f5df99b0a9d1f9047|m/make-dfsg/make-dfsg_4.3.orig.tar.gz"
  "753c254ecaba425ebe2e0a0fb4d299847701e1c3eeb43df563e39975cae56b4c|m/make-dfsg/make-dfsg_4.3-4.1.diff.gz"
  "d2523d94f4d4198df6801f238d36cf0dea2ab5521f1d19ee76b2e8ee1f1918bb|m/make-dfsg/make-dfsg_4.3-4.1.dsc"

  # ─── Required for GPL compliance (non-Debian upstream) ────────────
  # PJSIP is GPL-2.0-or-later (dual-licensed with a Teluu commercial
  # option; we use the GPL edition). We statically link PJSIP into
  # vm/prebuilt/d-modem and redistribute that binary, so the PJSIP
  # source must travel with every clone. Debian bookworm does not
  # package this version, so we fetch from upstream GitHub directly.

  # pjproject 2.15.1 — PJSIP library, built inside the bookworm VM
  # and statically linked into vm/prebuilt/d-modem.
  "8f3bd99caf003f96ed8038b8a36031eb9d8cd9eaea1eaff7e01c2eef6bd55706|https://github.com/pjsip/pjproject/archive/refs/tags/2.15.1.tar.gz"
)

DEBIAN_BASE_URL="https://deb.debian.org/debian/pool/main"

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then VERIFY_ONLY=1; fi

mkdir -p "$SRC_DIR"

# Prefer sha256sum if available (Linux), otherwise shasum -a 256 (macOS).
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  echo "need sha256sum or shasum on PATH" >&2
  exit 1
fi

verify_one() {
  local expected="$1" file="$2"
  local actual
  actual=$($SHA_CMD "$file" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "  FAIL $(basename "$file"): expected $expected got $actual" >&2
    return 1
  fi
  return 0
}

# Given a LOCATOR, print "<url>\t<dest-basename>".
# - https:// → URL is the locator verbatim. Dest is the URL's final
#   path component, except for GitHub's /archive/refs/tags/<tag>.tar.gz
#   pattern where we rewrite to <project>-<tag>.tar.gz so the file has
#   a self-describing name once committed.
# - anything else → treated as a Debian pool path relative to
#   $DEBIAN_BASE_URL. Dest is basename(locator).
resolve_locator() {
  local locator="$1"
  local url dest
  case "$locator" in
    https://*)
      url="$locator"
      case "$locator" in
        *"/archive/refs/tags/"*)
          # https://github.com/<owner>/<project>/archive/refs/tags/<tag>.tar.gz
          local project tag suffix
          # Strip everything up to and including the project name.
          project="${locator%/archive/refs/tags/*}"
          project="${project##*/}"
          suffix="${locator##*/archive/refs/tags/}"   # e.g. "2.15.1.tar.gz"
          tag="${suffix%.tar.gz}"
          tag="${tag%.tar.bz2}"
          tag="${tag%.zip}"
          # Preserve the actual compression extension.
          case "$suffix" in
            *.tar.gz)  dest="${project}-${tag}.tar.gz"  ;;
            *.tar.bz2) dest="${project}-${tag}.tar.bz2" ;;
            *.zip)     dest="${project}-${tag}.zip"     ;;
            *)         dest="${project}-${tag}"         ;;
          esac
          ;;
        *)
          dest="${locator##*/}"
          ;;
      esac
      ;;
    *)
      url="$DEBIAN_BASE_URL/$locator"
      dest="${locator##*/}"
      ;;
  esac
  printf "%s\t%s\n" "$url" "$dest"
}

status=0
for entry in "${SOURCES[@]}"; do
  sha=${entry%%|*}
  locator=${entry##*|}
  resolved=$(resolve_locator "$locator")
  url=${resolved%%$'\t'*}
  dest_name=${resolved##*$'\t'}
  dest="$SRC_DIR/$dest_name"

  if [ -f "$dest" ]; then
    if verify_one "$sha" "$dest"; then
      printf "  ok   %s (already present, hash verified)\n" "$dest_name"
      continue
    else
      printf "  bad  %s (hash mismatch — removing)\n" "$dest_name"
      rm -f "$dest"
    fi
  fi

  if [ "$VERIFY_ONLY" = "1" ]; then
    printf "  MISS %s (--verify: not fetching)\n" "$dest_name" >&2
    status=1
    continue
  fi

  printf "  get  %s\n" "$dest_name"
  if ! curl -fsSL --max-time 600 -o "$dest.tmp" "$url"; then
    printf "       download failed: %s\n" "$url" >&2
    rm -f "$dest.tmp"
    status=1
    continue
  fi
  if ! verify_one "$sha" "$dest.tmp"; then
    printf "       SHA256 mismatch — download corrupt or upstream changed\n" >&2
    rm -f "$dest.tmp"
    status=1
    continue
  fi
  mv "$dest.tmp" "$dest"
done

# Write a SHA256SUMS file alongside so anyone can verify without running
# this script. (Identical hashes to the pins above.)
if [ "$VERIFY_ONLY" = "0" ]; then
  (
    cd "$SRC_DIR"
    for entry in "${SOURCES[@]}"; do
      sha=${entry%%|*}
      locator=${entry##*|}
      resolved=$(resolve_locator "$locator")
      name=${resolved##*$'\t'}
      [ -f "$name" ] && printf "%s  %s\n" "$sha" "$name"
    done
  ) | sort > "$SRC_DIR/SHA256SUMS"
fi

echo
if [ $status -eq 0 ]; then
  echo "All source tarballs present and verified in $SRC_DIR"
  echo
  echo "Next steps:"
  echo "  git add vm/sources/"
  echo "  git commit -m \"Add vendored GPL/LGPL corresponding source\""
  echo "  git push"
else
  echo "Some files missing or failed verification (see above)." >&2
  exit 1
fi
