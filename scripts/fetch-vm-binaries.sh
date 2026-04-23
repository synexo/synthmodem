#!/usr/bin/env bash
#
# fetch-vm-binaries.sh — populate vm/kernel/, vm/busybox/, vm/libc/
#                        with prebuilt binaries extracted from Debian
#                        bookworm i386 .deb packages.
#
# ────────────────────────────────────────────────────────────────────
#
# WHAT THIS DOES
#
#   Downloads three .deb packages from Debian's archive, verifies each
#   against a pinned SHA256, extracts the specific binaries we need,
#   and places them in the appropriate vm/ subdirectory. The .deb files
#   themselves are discarded after extraction.
#
#   Corresponding source tarballs live in vm/sources/ and are fetched
#   by scripts/fetch-vm-sources.sh. Run that one too — GPL compliance
#   depends on both directories being populated.
#
# WHAT WE EXTRACT
#
#   from linux-image-6.1.0-42-686-pae-unsigned_6.1.159-1_i386.deb:
#     - vm/kernel/bzImage              (the compressed kernel)
#     - vm/kernel/config               (the Debian .config for provenance)
#     - vm/kernel/modules/virtio*.ko   (virtio drivers — kernel has them
#                                       as =m, we load them at boot)
#
#   from busybox-static_1.35.0-4+b7_i386.deb:
#     - vm/busybox/busybox             (the static i386 busybox binary)
#
#   from libc6_2.36-9+deb12u13_i386.deb:
#     - vm/libc/libc.so.6              (i386 glibc)
#     - vm/libc/ld-linux.so.2          (i386 dynamic loader)
#     - vm/libc/libm.so.6              (just in case slmodemd builds grow
#                                       any float uses — harmless otherwise)
#
#   That's everything the VM image needs to run slmodemd and modemd-shim.
#
# USAGE
#
#   scripts/fetch-vm-binaries.sh           # fetches + extracts
#   scripts/fetch-vm-binaries.sh --verify  # check extracted files only
#
# Idempotent — safe to re-run, it skips files that already match.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="$REPO_ROOT/vm"
WORK_DIR="$(mktemp -d -t synthmodem-vmbin.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Pinned .debs (SHA256|URL)
KERNEL_DEB_SHA="1e0e56cba6241bd122a353e67406142afa13ff0406d2b8d926fb7554a944e57a"
KERNEL_DEB_URL="https://deb.debian.org/debian/pool/main/l/linux/linux-image-6.1.0-42-686-pae-unsigned_6.1.159-1_i386.deb"

BUSYBOX_DEB_SHA="a387f023f0e92ba220d90ac20245517be1c67c26536fbf39f494adb43d8d51f7"
BUSYBOX_DEB_URL="https://deb.debian.org/debian/pool/main/b/busybox/busybox-static_1.35.0-4+b7_i386.deb"

LIBC_DEB_SHA="cc30f1ce0a1a836ecf7d713032dad45c924ba81e3934f78bf2b8c6f827117749"
LIBC_DEB_URL="https://deb.debian.org/debian/pool/main/g/glibc/libc6_2.36-9+deb12u13_i386.deb"

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then VERIFY_ONLY=1; fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  echo "need sha256sum or shasum on PATH" >&2; exit 1
fi

sha_of() { $SHA_CMD "$1" | awk '{print $1}'; }

# Optional: SYNTHMODEM_DEB_CACHE can point at a directory of already-
# downloaded .debs with matching names. If set, fetch_deb prefers the
# cache over the network. Useful for CI, offline builds, and working
# around transient archive mirror issues.
DEB_CACHE="${SYNTHMODEM_DEB_CACHE:-}"

try_cache() {
  local sha="$1" url="$2" out="$3"
  [ -n "$DEB_CACHE" ] || return 1
  local name=$(basename "$url")
  local cached="$DEB_CACHE/$name"
  [ -f "$cached" ] || return 1
  if [ "$(sha_of "$cached")" = "$sha" ]; then
    cp "$cached" "$out"
    echo "  ok   $name (from cache $DEB_CACHE)"
    return 0
  fi
  return 1
}

fetch_deb() {
  local sha="$1" url="$2" out="$3"
  if [ -f "$out" ] && [ "$(sha_of "$out")" = "$sha" ]; then
    echo "  ok   $(basename "$out") (cached)"
    return 0
  fi
  if try_cache "$sha" "$url" "$out"; then
    return 0
  fi
  if [ "$VERIFY_ONLY" = "1" ]; then
    echo "  MISS $(basename "$out")" >&2
    return 1
  fi
  echo "  get  $(basename "$out")"
  curl -fsSL --max-time 600 -o "$out.tmp" "$url"
  local actual
  actual=$(sha_of "$out.tmp")
  if [ "$actual" != "$sha" ]; then
    echo "       SHA256 mismatch: expected $sha got $actual" >&2
    rm -f "$out.tmp"
    return 1
  fi
  mv "$out.tmp" "$out"
}

mkdir -p "$VM_DIR/kernel/modules" "$VM_DIR/busybox" "$VM_DIR/libc"

echo "── Kernel ─────────────────────────────────────────"
KDEB="$WORK_DIR/linux-image.deb"
fetch_deb "$KERNEL_DEB_SHA" "$KERNEL_DEB_URL" "$KDEB"
if [ "$VERIFY_ONLY" = "0" ]; then
  mkdir -p "$WORK_DIR/kext"
  dpkg-deb -x "$KDEB" "$WORK_DIR/kext"

  # bzImage
  cp "$WORK_DIR/kext/boot/vmlinuz-6.1.0-42-686-pae" "$VM_DIR/kernel/bzImage"
  echo "  extracted: vm/kernel/bzImage ($(stat -c%s "$VM_DIR/kernel/bzImage") bytes)"

  # Kernel config for provenance
  cp "$WORK_DIR/kext/boot/config-6.1.0-42-686-pae" "$VM_DIR/kernel/config"
  echo "  extracted: vm/kernel/config"

  # System.map for debugging (tiny)
  if [ -f "$WORK_DIR/kext/boot/System.map-6.1.0-42-686-pae" ]; then
    cp "$WORK_DIR/kext/boot/System.map-6.1.0-42-686-pae" "$VM_DIR/kernel/System.map"
  fi

  # Virtio modules we need to insmod at boot. The kernel has these as
  # =m, not built in. We ship them alongside the kernel so the init
  # script can load them before the device nodes are needed.
  KMOD_SRC="$WORK_DIR/kext/lib/modules/6.1.0-42-686-pae/kernel"
  MODULES=(
    "drivers/virtio/virtio.ko"
    "drivers/virtio/virtio_ring.ko"
    "drivers/virtio/virtio_pci.ko"
    "drivers/virtio/virtio_pci_legacy_dev.ko"
    "drivers/virtio/virtio_pci_modern_dev.ko"
    "drivers/char/virtio_console.ko"
  )
  : > "$VM_DIR/kernel/modules/MANIFEST"
  for m in "${MODULES[@]}"; do
    src="$KMOD_SRC/$m"
    dest="$VM_DIR/kernel/modules/$(basename "$m")"
    if [ ! -f "$src" ]; then
      echo "  WARN: kernel module missing in deb: $m" >&2
      continue
    fi
    cp "$src" "$dest"
    printf "  %s  %s\n" "$(sha_of "$dest")" "$(basename "$m")" >> "$VM_DIR/kernel/modules/MANIFEST"
    echo "  extracted: vm/kernel/modules/$(basename "$m")"
  done
fi

echo "── busybox ───────────────────────────────────────"
BDEB="$WORK_DIR/busybox-static.deb"
fetch_deb "$BUSYBOX_DEB_SHA" "$BUSYBOX_DEB_URL" "$BDEB"
if [ "$VERIFY_ONLY" = "0" ]; then
  mkdir -p "$WORK_DIR/bext"
  dpkg-deb -x "$BDEB" "$WORK_DIR/bext"
  # Debian's busybox-static installs as /bin/busybox (Ubuntu's layout
  # puts it at /usr/bin/busybox; we prefer Debian here because the
  # pinned source is Debian's).
  if [ -f "$WORK_DIR/bext/bin/busybox" ]; then
    cp "$WORK_DIR/bext/bin/busybox" "$VM_DIR/busybox/busybox"
  elif [ -f "$WORK_DIR/bext/usr/bin/busybox" ]; then
    cp "$WORK_DIR/bext/usr/bin/busybox" "$VM_DIR/busybox/busybox"
  else
    echo "       could not find busybox in extracted deb" >&2
    exit 1
  fi
  chmod +x "$VM_DIR/busybox/busybox"
  echo "  extracted: vm/busybox/busybox ($(stat -c%s "$VM_DIR/busybox/busybox") bytes)"
fi

echo "── libc / loader ─────────────────────────────────"
LDEB="$WORK_DIR/libc6.deb"
fetch_deb "$LIBC_DEB_SHA" "$LIBC_DEB_URL" "$LDEB"
if [ "$VERIFY_ONLY" = "0" ]; then
  mkdir -p "$WORK_DIR/lext"
  dpkg-deb -x "$LDEB" "$WORK_DIR/lext"

  # The paths inside the i386 libc6 deb. Some are symlinks — use cp -L
  # to dereference so we ship the real binaries, not dangling links.
  # /lib/ld-linux.so.2  (the runtime loader)
  # /lib/i386-linux-gnu/libc.so.6
  # /lib/i386-linux-gnu/libm.so.6 (harmless extra)
  if [ -e "$WORK_DIR/lext/lib/ld-linux.so.2" ]; then
    cp -L "$WORK_DIR/lext/lib/ld-linux.so.2" "$VM_DIR/libc/ld-linux.so.2"
    echo "  extracted: vm/libc/ld-linux.so.2 ($(stat -c%s "$VM_DIR/libc/ld-linux.so.2") bytes)"
  fi
  if [ -e "$WORK_DIR/lext/lib/i386-linux-gnu/libc.so.6" ]; then
    cp -L "$WORK_DIR/lext/lib/i386-linux-gnu/libc.so.6" "$VM_DIR/libc/libc.so.6"
    echo "  extracted: vm/libc/libc.so.6 ($(stat -c%s "$VM_DIR/libc/libc.so.6") bytes)"
  fi
  if [ -e "$WORK_DIR/lext/lib/i386-linux-gnu/libm.so.6" ]; then
    cp -L "$WORK_DIR/lext/lib/i386-linux-gnu/libm.so.6" "$VM_DIR/libc/libm.so.6"
    echo "  extracted: vm/libc/libm.so.6 ($(stat -c%s "$VM_DIR/libc/libm.so.6") bytes)"
  fi
fi

echo
echo "Done. Extracted to vm/kernel/, vm/busybox/, vm/libc/."
echo
echo "GPL compliance: make sure vm/sources/ is also populated."
echo "If not, run: scripts/fetch-vm-sources.sh"
