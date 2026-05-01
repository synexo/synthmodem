#!/usr/bin/env bash
#
# build-slmodemd-in-vm.sh — rebuild vm/prebuilt/slmodemd from source
#                           using a Debian bookworm i386 build VM.
#
# ─────────────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS
#
#   slmodemd must link against the exact glibc that ships in the
#   runtime VM (Debian bookworm 2.36). Building on a modern host
#   produces a binary that references post-2.36 symbols and fails
#   to load inside the VM. This script sidesteps that by running
#   the build INSIDE the VM kernel with a temporary toolchain
#   initramfs derived from Debian bookworm .debs.
#
#   Output: vm/prebuilt/slmodemd (plus provenance update).
#
# WHEN TO RUN
#
#   - You just updated vm/slmodemd/ via scripts/fetch-slmodemd.sh.
#   - You want to verify the current prebuilt against its recipe.
#   - You bumped the pinned glibc or kernel and want a fresh binary.
#
#   Do NOT run routinely — vm/prebuilt/slmodemd is checked into git
#   and should stay stable across ordinary development.
#
# REQUIREMENTS
#
#   - qemu-system-i386
#   - cpio, gzip, mkfs.ext2 (not used here since we use 9p, but listed
#     as general dependency of the VM tooling)
#   - dpkg-deb (from dpkg)
#   - curl
#   - ~300 MB network download (first run only, cached after)
#   - ~1.5 GB free RAM to allocate to the VM during build
#
# USAGE
#
#   scripts/build-slmodemd-in-vm.sh                      # build + stage + update prebuilt
#   scripts/build-slmodemd-in-vm.sh --dry-run            # show what would happen
#   scripts/build-slmodemd-in-vm.sh --cache /path        # cache dir for .debs
#   scripts/build-slmodemd-in-vm.sh --keep-work          # keep builder work tree
#   SYNTHMODEM_DEB_CACHE=/path/to/debs ./scripts/build-slmodemd-in-vm.sh
#
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="$REPO_ROOT/vm"

# ─── Config ─────────────────────────────────────────────────────────

CACHE_DIR="${SYNTHMODEM_DEB_CACHE:-$HOME/.cache/synthmodem/debs}"
WORK_DIR=""
KEEP_WORK=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cache) CACHE_DIR="$2"; shift 2 ;;
    --keep-work) KEEP_WORK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '/^# USAGE/,/^# ──/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$CACHE_DIR"

# ─── Toolchain package pins (Debian bookworm, i386) ─────────────────
#
# Each entry is: SHA256 | path-in-Debian-pool
#
# When any of these change, PROVENANCE.txt must be updated too.

POOL="https://deb.debian.org/debian"
PKGS=(
  # gcc and deps
  "pool/main/g/gcc-12/gcc-12_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/cpp-12_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/gcc-12-base_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libcc1-0_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libgcc-12-dev_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libgcc-s1_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libstdc++6_12.2.0-14+deb12u1_i386.deb"
  # binutils
  "pool/main/b/binutils/binutils_2.40-2_i386.deb"
  "pool/main/b/binutils/binutils-common_2.40-2_i386.deb"
  "pool/main/b/binutils/binutils-i686-linux-gnu_2.40-2_i386.deb"
  "pool/main/b/binutils/libbinutils_2.40-2_i386.deb"
  "pool/main/b/binutils/libctf0_2.40-2_i386.deb"
  "pool/main/b/binutils/libctf-nobfd0_2.40-2_i386.deb"
  "pool/main/b/binutils/libgprofng0_2.40-2_i386.deb"
  # gcc transitive deps
  "pool/main/j/jansson/libjansson4_2.14-2_i386.deb"
  "pool/main/g/gmp/libgmp10_6.2.1+dfsg1-1.1_i386.deb"
  "pool/main/i/isl/libisl23_0.25-1.1_i386.deb"
  "pool/main/m/mpclib3/libmpc3_1.3.1-1_i386.deb"
  "pool/main/m/mpfr4/libmpfr6_4.2.0-1_i386.deb"
  "pool/main/libz/libzstd/libzstd1_1.5.4+dfsg2-5_i386.deb"
  "pool/main/z/zlib/zlib1g_1.2.13.dfsg-1_i386.deb"
  # glibc (same as runtime — this is the key to symbol compatibility)
  "pool/main/g/glibc/libc6_2.36-9+deb12u13_i386.deb"
  "pool/main/g/glibc/libc6-dev_2.36-9+deb12u13_i386.deb"
  "pool/main/g/glibc/libc-dev-bin_2.36-9+deb12u13_i386.deb"
  "pool/main/libx/libxcrypt/libcrypt1_4.4.33-2_i386.deb"
  "pool/main/libx/libxcrypt/libcrypt-dev_4.4.33-2_i386.deb"
  # kernel headers
  "pool/main/l/linux/linux-libc-dev_6.1.159-1_i386.deb"
  # make
  "pool/main/m/make-dfsg/make_4.3-4.1_i386.deb"
)

# ─── Prerequisite checks ────────────────────────────────────────────

err() { echo "ERROR: $*" >&2; exit 1; }

command -v qemu-system-i386 >/dev/null || err "qemu-system-i386 not found in PATH"
command -v dpkg-deb         >/dev/null || err "dpkg-deb not found (install 'dpkg')"
command -v cpio             >/dev/null || err "cpio not found"
command -v curl             >/dev/null || err "curl not found"

[ -f "$VM_DIR/kernel/bzImage" ] || \
  err "vm/kernel/bzImage missing — run scripts/fetch-vm-binaries.sh first"
[ -f "$VM_DIR/slmodemd/Makefile" ] || \
  err "vm/slmodemd/ missing — run scripts/fetch-slmodemd.sh first"
[ -f "$VM_DIR/slmodemd/dsplibs.o" ] || \
  err "vm/slmodemd/dsplibs.o missing — re-fetch slmodemd subtree"

# The minimal builder-base initramfs we'll extend. If it doesn't exist
# yet, build it (cheap — pure file assembly, no toolchain needed).
if [ ! -f "$VM_DIR/images/rootfs-builder-base.cpio.gz" ]; then
  echo "Building builder-base initramfs first (vm/images/rootfs-builder-base.cpio.gz)…"
  (cd "$VM_DIR" && make --no-print-directory rootfs-builder-base)
fi

# ─── Set up work directory ──────────────────────────────────────────

WORK_DIR="$(mktemp -d -t synthmodem-buildvm.XXXXXX)"
cleanup() {
  if [ "$KEEP_WORK" = "1" ]; then
    echo "Keeping work dir: $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ─── Fetch / cache toolchain .debs ──────────────────────────────────

echo ""
echo "── Toolchain packages ──"

for rel in "${PKGS[@]}"; do
  name=$(basename "$rel")
  cached="$CACHE_DIR/$name"
  if [ -f "$cached" ]; then
    echo "  ok   $name (cached)"
    continue
  fi
  echo "  get  $name"
  if [ "$DRY_RUN" = "1" ]; then continue; fi
  curl -fsSL --max-time 600 -o "$cached.tmp" "$POOL/$rel"
  mv "$cached.tmp" "$cached"
done

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "Dry-run: would proceed to extract toolchain + build builder initramfs + boot."
  exit 0
fi

# ─── Assemble builder rootfs ────────────────────────────────────────

BUILDER_ROOT="$WORK_DIR/builder-root"
mkdir -p "$BUILDER_ROOT"

echo ""
echo "── Assembling builder rootfs ──"
echo "Base: extracting builder-base initramfs…"
(cd "$BUILDER_ROOT" && zcat "$VM_DIR/images/rootfs-builder-base.cpio.gz" | cpio -i --quiet --make-directories)

echo "Overlay: extracting toolchain debs…"
for rel in "${PKGS[@]}"; do
  name=$(basename "$rel")
  dpkg-deb -x "$CACHE_DIR/$name" "$BUILDER_ROOT"
done

echo "Adding tool symlinks…"
# Debian normally uses update-alternatives; we don't have dpkg running
# inside the image, so create the canonical names by hand.
ln -sf gcc-12                  "$BUILDER_ROOT/usr/bin/gcc"
ln -sf gcc-12                  "$BUILDER_ROOT/usr/bin/cc"
ln -sf i686-linux-gnu-ld       "$BUILDER_ROOT/usr/bin/ld"
ln -sf i686-linux-gnu-ar       "$BUILDER_ROOT/usr/bin/ar"
ln -sf i686-linux-gnu-as       "$BUILDER_ROOT/usr/bin/as"
ln -sf i686-linux-gnu-ranlib   "$BUILDER_ROOT/usr/bin/ranlib"

# Ensure /lib/ld-linux.so.2 exists (Debian sometimes puts it under
# /lib/i386-linux-gnu/ only). Copy rather than symlink so it survives
# cpio without dangling.
if [ ! -e "$BUILDER_ROOT/lib/ld-linux.so.2" ] \
   && [ -e "$BUILDER_ROOT/lib/i386-linux-gnu/ld-linux.so.2" ]; then
  cp "$BUILDER_ROOT/lib/i386-linux-gnu/ld-linux.so.2" "$BUILDER_ROOT/lib/ld-linux.so.2"
fi

echo "Adding slmodemd source tree at /src/slmodemd…"
mkdir -p "$BUILDER_ROOT/src"
cp -a "$VM_DIR/slmodemd" "$BUILDER_ROOT/src/"

echo "Adding 9p modules…"
# 9p modules are NOT in the runtime initramfs's slimmed module set,
# so we have to extract them from the kernel .deb directly.
mkdir -p "$BUILDER_ROOT/lib/modules/9p"
MODS_SRC="$WORK_DIR/kmods"
mkdir -p "$MODS_SRC"
# Extract the kernel .deb into a temp location for module fishing.
# We already fetched it as part of fetch-vm-binaries; look up from cache.
KDEB_CACHE="$CACHE_DIR/linux-image-6.1.0-42-686-pae-unsigned_6.1.159-1_i386.deb"
KDEB_URL="$POOL/pool/main/l/linux/linux-image-6.1.0-42-686-pae-unsigned_6.1.159-1_i386.deb"
if [ ! -f "$KDEB_CACHE" ]; then
  echo "  get  linux-image-6.1.0-42-686-pae-unsigned..."
  curl -fsSL --max-time 600 -o "$KDEB_CACHE.tmp" "$KDEB_URL"
  mv "$KDEB_CACHE.tmp" "$KDEB_CACHE"
fi
dpkg-deb -x "$KDEB_CACHE" "$MODS_SRC"
KMOD_TREE="$MODS_SRC/lib/modules/6.1.0-42-686-pae/kernel"
for m in \
  "fs/netfs/netfs.ko" \
  "fs/fscache/fscache.ko" \
  "net/9p/9pnet.ko" \
  "net/9p/9pnet_virtio.ko" \
  "fs/9p/9p.ko" ; do
  src="$KMOD_TREE/$m"
  [ -f "$src" ] || err "kernel module missing from .deb: $m"
  cp "$src" "$BUILDER_ROOT/lib/modules/9p/"
done

echo "Installing build-init script…"
# Replace /init with our build script. Remove the symlink first so
# cp doesn't dereference it and clobber /sbin/init → /bin/busybox.
rm -f "$BUILDER_ROOT/init"
cat > "$BUILDER_ROOT/init" <<'INIT_EOF'
#!/bin/sh
#
# Builder init — PID 1 inside the build VM. Loads virtio + 9p, mounts
# the host's output directory, runs `make`, copies the result out, and
# powers off. Output on the host-side 9p share is what scripts/build-
# slmodemd-in-vm.sh picks up.
exec 1>/dev/console 2>&1
set +e

echo "=== slmodemd build-in-VM ==="
echo "kernel: $(uname -r)"

mount -t proc     proc     /proc     2>/dev/null
mount -t sysfs    sysfs    /sys      2>/dev/null
mount -t devtmpfs devtmpfs /dev      2>/dev/null
mkdir -p /dev/pts
mount -t devpts   devpts   /dev/pts  2>/dev/null

echo "loading virtio modules..."
for m in virtio virtio_ring virtio_pci_legacy_dev virtio_pci_modern_dev virtio_pci; do
  [ -f "/lib/modules/virtio/$m.ko" ] && insmod "/lib/modules/virtio/$m.ko" 2>/dev/null
done

echo "loading 9p modules..."
for m in netfs fscache 9pnet 9pnet_virtio 9p; do
  [ -f "/lib/modules/9p/$m.ko" ] && insmod "/lib/modules/9p/$m.ko" 2>/dev/null
done

echo "mounting 9p 'output' share..."
mkdir -p /output
mount -t 9p -o trans=virtio,version=9p2000.L,msize=1048576 output /output \
    || { echo "FATAL: 9p mount failed"; poweroff -f; }

echo "building slmodemd..."
cd /src/slmodemd
make clean 2>&1 | tail -1
make 2>&1 | tail -5

SLMODEMD_OK=0

if [ -x slmodemd ]; then
    echo ""
    echo "=== slmodemd build OK ==="
    ls -la slmodemd
    echo "glibc symbols:"
    strings slmodemd 2>/dev/null | grep -E '^GLIBC_[0-9.]+$' | sort -u | sed 's/^/  /'
    if strings slmodemd 2>/dev/null | grep -q __isoc23; then
        echo "WARNING: slmodemd still has __isoc23_ symbols"
    fi
    cp slmodemd /output/slmodemd
    SLMODEMD_OK=1
fi

sync
echo ""
if [ $SLMODEMD_OK = 1 ]; then
    echo "BUILD_SUCCESS"
else
    echo "BUILD_FAILURE (slmodemd=$SLMODEMD_OK)"
fi

umount /output 2>/dev/null
sync
sleep 1
poweroff -f
INIT_EOF
chmod +x "$BUILDER_ROOT/init"

# ─── Pack the builder initramfs ─────────────────────────────────────

echo ""
echo "── Packing builder initramfs ──"
BUILDER_CPIO="$WORK_DIR/builder.cpio.gz"
(cd "$BUILDER_ROOT" && find . -print0 | cpio --null -H newc --create --quiet) \
    | gzip -5 > "$BUILDER_CPIO"
echo "  size: $(du -h "$BUILDER_CPIO" | awk '{print $1}')"

# ─── Run the builder VM ─────────────────────────────────────────────

OUTPUT_DIR="$WORK_DIR/output"
mkdir -p "$OUTPUT_DIR"

echo ""
echo "── Running builder VM ──"
echo "RAM: 1024 MB, accel: tcg (software emulation)"

# Capture console output; we grep it for success/failure markers.
VM_LOG="$WORK_DIR/vm.log"
timeout 600 qemu-system-i386 \
    -M pc -m 1024 -nographic \
    -kernel "$VM_DIR/kernel/bzImage" \
    -initrd "$BUILDER_CPIO" \
    -fsdev local,id=outputfs,path="$OUTPUT_DIR",security_model=none \
    -device virtio-9p-pci,fsdev=outputfs,mount_tag=output \
    -append "console=ttyS0 panic=-1 loglevel=3" \
    -no-reboot \
    -accel tcg \
    > "$VM_LOG" 2>&1 || true

if ! grep -q 'BUILD_SUCCESS' "$VM_LOG"; then
  echo ""
  echo "── VM log (last 40 lines) ──"
  tail -40 "$VM_LOG"
  err "Build inside VM did not report BUILD_SUCCESS. See $VM_LOG"
fi

if [ ! -f "$OUTPUT_DIR/slmodemd" ]; then
  err "Builder VM did not produce slmodemd"
fi

# ─── Install the prebuilts ──────────────────────────────────────────

mkdir -p "$VM_DIR/prebuilt"
echo ""
echo "── Installing to vm/prebuilt/ ──"
cp "$OUTPUT_DIR/slmodemd"         "$VM_DIR/prebuilt/slmodemd"
chmod +x "$VM_DIR/prebuilt/slmodemd"

SLMODEMD_HASH=$(sha256sum "$VM_DIR/prebuilt/slmodemd"         | awk '{print $1}')
echo "  slmodemd            SHA256: $SLMODEMD_HASH"
echo "                      Size:   $(stat -c%s "$VM_DIR/prebuilt/slmodemd") bytes"

echo ""
echo "Build complete. Update vm/prebuilt/PROVENANCE.txt if these hashes"
echo "differ from the committed values, then commit the new binaries."
