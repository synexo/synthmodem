#!/usr/bin/env bash
#
# build-pjsip-in-vm.sh — rebuild vm/prebuilt/d-modem (+ its static PJSIP
#                        dependency) from source using a Debian bookworm
#                        i386 build VM.
#
# ─────────────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS
#
#   The d-modem binary links statically against PJSIP (pjproject 2.15.1).
#   Both must link against the exact glibc that ships in the runtime VM
#   (Debian bookworm 2.36). Building on a modern host produces binaries
#   that reference post-2.36 symbols and fail to load inside the VM.
#   This script sidesteps that by running the build INSIDE the VM kernel
#   with a temporary toolchain initramfs derived from Debian bookworm
#   .debs.
#
#   Output: vm/prebuilt/d-modem (plus modemd-tunnel-i386, modemd-ctrl-i386,
#   and pjsip-test-peer-i386, all built in the same VM session). All
#   prebuilts are committed to git; provenance hashes updated in
#   vm/prebuilt/PROVENANCE.txt.
#
#   Parallel to scripts/build-slmodemd-in-vm.sh, which produces
#   vm/prebuilt/slmodemd. The slmodemd binary is consumed by the
#   slmodemd-pjsip rootfs (d-modem drives slmodemd inside the VM), so
#   build-slmodemd-in-vm.sh must have been run at least once before
#   this script is useful — though in practice both prebuilts are
#   committed and most users never re-run either script.
#
# WHEN TO RUN
#
#   - First-time setup of the slmodemd-pjsip backend.
#   - You updated vm/d-modem/d-modem.c (refreshed the D-Modem pin).
#   - You updated vm/pjsip/UPSTREAM.txt / config_site.h.
#   - You bumped the pinned glibc or kernel and want a fresh binary.
#
#   Do NOT run routinely — vm/prebuilt/d-modem is checked into git
#   and should stay stable across ordinary development.
#
# REQUIREMENTS
#
#   - qemu-system-i386
#   - cpio, gzip
#   - dpkg-deb (from dpkg)
#   - curl
#   - vm/sources/pjproject-2.15.1.tar.gz present (via scripts/fetch-vm-sources.sh)
#   - ~300 MB network download for build .debs (first run only, cached after)
#   - ~1.5 GB free RAM to allocate to the VM during build
#   - Built PJSIP is ~60 MB of .a files during the build, ~5-8 MB
#     statically linked into the final d-modem binary.
#
# USAGE
#
#   scripts/build-pjsip-in-vm.sh                      # build + stage + update prebuilt
#   scripts/build-pjsip-in-vm.sh --dry-run            # show what would happen
#   scripts/build-pjsip-in-vm.sh --cache /path        # cache dir for .debs
#   scripts/build-pjsip-in-vm.sh --keep-work          # keep builder work tree
#   SYNTHMODEM_DEB_CACHE=/path/to/debs ./scripts/build-pjsip-in-vm.sh
#
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="$REPO_ROOT/vm"

# ─── Config ─────────────────────────────────────────────────────────

CACHE_DIR="${SYNTHMODEM_DEB_CACHE:-$HOME/.cache/synthmodem/debs}"
PJSIP_CACHE_DIR="${SYNTHMODEM_PJSIP_CACHE:-$HOME/.cache/synthmodem/pjsip}"
WORK_DIR=""
KEEP_WORK=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cache) CACHE_DIR="$2"; shift 2 ;;
    --pjsip-cache) PJSIP_CACHE_DIR="$2"; shift 2 ;;
    --keep-work) KEEP_WORK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '/^# USAGE/,/^# ──/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$CACHE_DIR" "$PJSIP_CACHE_DIR"

# ─── Toolchain package pins (Debian bookworm, i386) ─────────────────
#
# Each entry is a Debian-pool path. SHA256 pins live in
# vm/prebuilt/PROVENANCE.txt alongside the pins for slmodemd's build.
#
# This list is a superset of build-slmodemd-in-vm.sh's PKGS: same
# gcc/binutils/glibc/make as slmodemd, plus packages PJSIP's aconfigure
# script probes for (pkg-config, perl-base for some generators), plus
# transitive deps.
#
# PJSIP ships a pre-generated aconfigure (via autoconf 2.72), so we
# do NOT need to pull in autoconf itself. The d-modem Makefile uses
# pkg-config to get PJSIP's --static --cflags/--libs, so pkg-config
# IS required.

POOL="https://deb.debian.org/debian"
PKGS=(
  # ─── Shared with build-slmodemd-in-vm.sh ─────────────────────
  # gcc and deps
  "pool/main/g/gcc-12/gcc-12_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/g++-12_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/cpp-12_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/gcc-12-base_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libcc1-0_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libgcc-12-dev_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libgcc-s1_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libstdc++6_12.2.0-14+deb12u1_i386.deb"
  "pool/main/g/gcc-12/libstdc++-12-dev_12.2.0-14+deb12u1_i386.deb"
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

  # ─── Additional pjsip/d-modem build dependencies ─────────────
  # pkg-config — used by vm/d-modem/Makefile to resolve PJSIP's
  # static link flags from the prefix install.
  "pool/main/p/pkgconf/pkg-config_1.8.1-1_i386.deb"
  "pool/main/p/pkgconf/pkgconf_1.8.1-1_i386.deb"
  "pool/main/p/pkgconf/pkgconf-bin_1.8.1-1_i386.deb"
  "pool/main/p/pkgconf/libpkgconf3_1.8.1-1_i386.deb"
  # perl-base — PJSIP's aconfigure probes run perl for some
  # config-header generation steps. Minimal perl is enough.
  "pool/main/p/perl/perl-base_5.36.0-7+deb12u3_i386.deb"
  # sed — aconfigure uses it heavily and busybox sed works for the
  # common cases, but PJSIP's configure script trips up on a few
  # GNU-sed-only constructs. Ship real sed.
  "pool/main/s/sed/sed_4.9-1_i386.deb"
  # grep — same story as sed. PJSIP's probes use -P (PCRE) in a
  # couple of places that busybox grep doesn't support.
  "pool/main/g/grep/grep_3.8-5_i386.deb"
  "pool/main/p/pcre2/libpcre2-8-0_10.42-1_i386.deb"
)

# ─── Prerequisite checks ────────────────────────────────────────────

err() { echo "ERROR: $*" >&2; exit 1; }

command -v qemu-system-i386 >/dev/null || err "qemu-system-i386 not found in PATH"
command -v dpkg-deb         >/dev/null || err "dpkg-deb not found (install 'dpkg')"
command -v cpio             >/dev/null || err "cpio not found"
command -v curl             >/dev/null || err "curl not found"

[ -f "$VM_DIR/kernel/bzImage" ] || \
  err "vm/kernel/bzImage missing — run scripts/fetch-vm-binaries.sh first"
[ -f "$VM_DIR/d-modem/d-modem.c" ] || \
  err "vm/d-modem/d-modem.c missing — vendored d-modem source should be committed"
[ -f "$VM_DIR/d-modem/Makefile" ] || \
  err "vm/d-modem/Makefile missing"
[ -f "$VM_DIR/pjsip/config_site.h" ] || \
  err "vm/pjsip/config_site.h missing"
[ -f "$VM_DIR/slmodemd/modem.h" ] || \
  err "vm/slmodemd/modem.h missing — d-modem.c includes it; run scripts/fetch-slmodemd.sh first"

PJSIP_TARBALL="$VM_DIR/sources/pjproject-2.15.1.tar.gz"
[ -f "$PJSIP_TARBALL" ] || \
  err "$PJSIP_TARBALL missing — run scripts/fetch-vm-sources.sh first"

# The minimal builder-base initramfs we'll extend. If it doesn't exist
# yet, build it (cheap — pure file assembly, no toolchain needed).
if [ ! -f "$VM_DIR/images/rootfs-builder-base.cpio.gz" ]; then
  echo "Building builder-base initramfs first (vm/images/rootfs-builder-base.cpio.gz)…"
  (cd "$VM_DIR" && make --no-print-directory rootfs-builder-base)
fi

# ─── Set up work directory ──────────────────────────────────────────

WORK_DIR="$(mktemp -d -t synthmodem-pjsipbuild.XXXXXX)"
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
ln -sf g++-12                  "$BUILDER_ROOT/usr/bin/g++"
ln -sf g++-12                  "$BUILDER_ROOT/usr/bin/c++"
ln -sf i686-linux-gnu-ld       "$BUILDER_ROOT/usr/bin/ld"
ln -sf i686-linux-gnu-ar       "$BUILDER_ROOT/usr/bin/ar"
ln -sf i686-linux-gnu-as       "$BUILDER_ROOT/usr/bin/as"
ln -sf i686-linux-gnu-ranlib   "$BUILDER_ROOT/usr/bin/ranlib"
# pkg-config is shipped as a symlink to pkgconf in bookworm; the
# .deb's own symlinks may or may not unpack cleanly depending on
# dpkg-deb version, so force the one we care about.
ln -sf pkgconf                 "$BUILDER_ROOT/usr/bin/pkg-config" 2>/dev/null || true

# Ensure /lib/ld-linux.so.2 exists (Debian sometimes puts it under
# /lib/i386-linux-gnu/ only). Copy rather than symlink so it survives
# cpio without dangling.
if [ ! -e "$BUILDER_ROOT/lib/ld-linux.so.2" ] \
   && [ -e "$BUILDER_ROOT/lib/i386-linux-gnu/ld-linux.so.2" ]; then
  cp "$BUILDER_ROOT/lib/i386-linux-gnu/ld-linux.so.2" "$BUILDER_ROOT/lib/ld-linux.so.2"
fi

echo "Adding slmodemd source tree at /src/slmodemd (for modem.h)…"
mkdir -p "$BUILDER_ROOT/src"
cp -a "$VM_DIR/slmodemd" "$BUILDER_ROOT/src/"

echo "Adding d-modem source tree at /src/d-modem…"
cp -a "$VM_DIR/d-modem" "$BUILDER_ROOT/src/"
# Scrub any host-built binaries from the source copy.
rm -f "$BUILDER_ROOT/src/d-modem/d-modem"

echo "Adding modemd-tunnel source tree at /src/tunnel…"
cp -a "$VM_DIR/tunnel" "$BUILDER_ROOT/src/"
rm -f "$BUILDER_ROOT/src/tunnel/modemd-tunnel"

# modemd-ctrl source tree. wire.h lives alongside modemd-ctrl.c
# (relocated from vm/shim/ when backend A was removed); the cp -a
# below brings both in together.
echo "Adding modemd-ctrl source tree at /src/ctrl…"
cp -a "$VM_DIR/ctrl" "$BUILDER_ROOT/src/"
rm -f "$BUILDER_ROOT/src/ctrl/modemd-ctrl" \
      "$BUILDER_ROOT/src/ctrl/modemd-ctrl-i386"

# pjsip-test-peer is optional — only ship it if the source is present
# in the tree. This keeps the build script backward-compatible with
# checkouts that haven't added step-3 yet.
if [ -d "$VM_DIR/pjsip-test-peer" ]; then
    echo "Adding pjsip-test-peer source tree at /src/pjsip-test-peer…"
    cp -a "$VM_DIR/pjsip-test-peer" "$BUILDER_ROOT/src/"
    rm -f "$BUILDER_ROOT/src/pjsip-test-peer/pjsip-test-peer"
fi

echo "Adding PJSIP tarball at /src/pjproject-2.15.1.tar.gz…"
cp "$PJSIP_TARBALL" "$BUILDER_ROOT/src/pjproject-2.15.1.tar.gz"

echo "Adding PJSIP config_site.h at /src/config_site.h…"
cp "$VM_DIR/pjsip/config_site.h" "$BUILDER_ROOT/src/config_site.h"

echo "Adding 9p modules…"
# 9p modules are NOT in the runtime initramfs's slimmed module set,
# so we have to extract them from the kernel .deb directly.
mkdir -p "$BUILDER_ROOT/lib/modules/9p"
MODS_SRC="$WORK_DIR/kmods"
mkdir -p "$MODS_SRC"
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
# Builder init — PID 1 inside the build VM.
#
# Steps:
#   1. Mount /proc /sys /dev /dev/pts
#   2. Load virtio + 9p modules
#   3. Mount the host's output directory via 9p
#   4. Unpack PJSIP, inject config_site.h, configure, build, install
#   5. Build d-modem against the PJSIP install
#   6. Copy d-modem to /output/
#   7. Emit BUILD_SUCCESS / BUILD_FAILURE and poweroff

exec 1>/dev/console 2>&1
# We want to see command output but also trust exit codes through pipes.
# `set -e` is too aggressive for a script that deliberately continues
# past some errors (the file checks below). `set -o pipefail` makes
# `cmd | tail` exit with cmd's status when cmd fails, which is what we
# actually care about for configure/make.
set +e
set -o pipefail

echo "=== pjsip + d-modem build-in-VM ==="
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

# ─── Unpack PJSIP ───────────────────────────────────────────────────
# FAST PATH: if a prior run saved /output/pjsip.install.tar, reuse it.
# This shortcuts the ~25-minute PJSIP rebuild when we're iterating on
# d-modem.c or the d-modem Makefile only. The file is written by this
# same script at end-of-successful-pjsip-install (see below).

mkdir -p /build
if [ -f /output/pjsip.install.tar ]; then
  echo ""
  echo "restoring cached pjsip install from /output/pjsip.install.tar..."
  (cd /build && tar -xf /output/pjsip.install.tar)
  if [ -f /build/pjsip.install/lib/pkgconfig/libpjproject.pc ]; then
    echo "cached PJSIP restored, skipping pjsip build"
    PJSIP_CACHED=1
  else
    echo "cached tarball did not restore cleanly, falling back to full build"
    rm -rf /build/pjsip.install
    PJSIP_CACHED=0
  fi
else
  PJSIP_CACHED=0
fi

if [ "$PJSIP_CACHED" = "0" ]; then

echo ""
echo "unpacking pjproject-2.15.1.tar.gz..."
cd /build
tar -xzf /src/pjproject-2.15.1.tar.gz
if [ ! -d pjproject-2.15.1 ]; then
  echo "FATAL: PJSIP did not unpack to expected directory"
  poweroff -f
fi

echo "injecting config_site.h..."
cp /src/config_site.h pjproject-2.15.1/pjlib/include/pj/config_site.h

# ─── Configure + build PJSIP ────────────────────────────────────────

echo ""
echo "configuring pjsip (prefix=/build/pjsip.install)..."
cd /build/pjproject-2.15.1
mkdir -p /build/pjsip.install

# Configure flags: strip PJSIP down to the narrowest build that still
# supports d-modem's needs. d-modem uses:
#   - pjsua-lib (call setup, media coordination)
#   - pjsip    (SIP protocol)
#   - pjmedia  (conference bridge, PCMU codec, media port subclassing)
#   - pjnath   (ICE off but we keep pjnath since pjsua depends on it)
#   - pjlib, pjlib-util (base)
#
# We don't need:
#   --disable-video          no video ever
#   --disable-sound          no local audio device (headless VM;
#                            we omit -DWITH_AUDIO in d-modem's build)
#   --disable-ssl            no TLS/SRTP over the SIP tunnel (all
#                            inside our trusted VM↔host pipe)
#   --disable-libsrtp        no media encryption
#   --disable-libyuv         video dependency
#   --disable-libwebrtc      AEC off, video off, not needed for modem
#   --disable-opus           not a modem codec
#   --disable-silk           "
#   --disable-speex-codec    "
#   --disable-speex-aec      no echo cancellation (d-modem sets ec_tail_len=0)
#   --disable-ilbc-codec     "
#   --disable-gsm-codec      "
#   --disable-g722-codec     "
#   --disable-g7221-codec    "
#   --disable-bcg729         "
#   --disable-opencore-amr   "
#   --disable-sdl            no UI
#   --disable-v4l2           no video
#   --disable-ffmpeg         no video
#   --disable-openh264       no video
#   --disable-vpx            no video
#   --disable-lyra           "
#   --disable-upnp           not needed, all-local networking
#   --disable-pjsua2         d-modem uses the C pjsua-lib API, not C++ pjsua2
#
# We keep L16 and G.711 codecs (PCMU — the only one we actually need).
# We keep pjnath (ICE/STUN/TURN infrastructure) because pjsua-lib
# links against it unconditionally, even if we don't enable ICE.
# We keep resample since pjmedia uses it internally.

./configure --prefix=/build/pjsip.install \
    --disable-video \
    --disable-sound \
    --disable-ssl \
    --disable-libsrtp \
    --disable-libyuv \
    --disable-libwebrtc \
    --disable-opus \
    --disable-silk \
    --disable-speex-codec \
    --disable-speex-aec \
    --disable-ilbc-codec \
    --disable-gsm-codec \
    --disable-g722-codec \
    --disable-g7221-codec \
    --disable-bcg729 \
    --disable-opencore-amr \
    --disable-sdl \
    --disable-v4l2 \
    --disable-ffmpeg \
    --disable-openh264 \
    --disable-vpx \
    --disable-lyra \
    --disable-upnp \
    --disable-pjsua2 \
    > /tmp/pjsip-configure.log 2>&1
CFG_RC=$?
tail -20 /tmp/pjsip-configure.log
if [ $CFG_RC -ne 0 ]; then
  echo "FATAL: pjsip configure failed (rc=$CFG_RC)"
  echo "--- full configure log (last 100 lines) ---"
  tail -100 /tmp/pjsip-configure.log
  cp /tmp/pjsip-configure.log /output/pjsip-configure.log 2>/dev/null
  sync
  poweroff -f
fi

echo ""
echo "building pjsip (this takes a while under TCG)..."
make dep > /tmp/pjsip-make-dep.log 2>&1
DEP_RC=$?
tail -10 /tmp/pjsip-make-dep.log
if [ $DEP_RC -ne 0 ]; then
  echo "FATAL: pjsip make dep failed (rc=$DEP_RC)"
  tail -50 /tmp/pjsip-make-dep.log
  cp /tmp/pjsip-make-dep.log /output/pjsip-make-dep.log 2>/dev/null
  sync
  poweroff -f
fi

make > /tmp/pjsip-make.log 2>&1
MAKE_RC=$?
tail -15 /tmp/pjsip-make.log
if [ $MAKE_RC -ne 0 ]; then
  echo "FATAL: pjsip make failed (rc=$MAKE_RC)"
  tail -100 /tmp/pjsip-make.log
  cp /tmp/pjsip-make.log /output/pjsip-make.log 2>/dev/null
  sync
  poweroff -f
fi

echo ""
echo "installing pjsip to /build/pjsip.install..."
make install > /tmp/pjsip-install.log 2>&1
INS_RC=$?
tail -10 /tmp/pjsip-install.log
if [ $INS_RC -ne 0 ] || [ ! -f /build/pjsip.install/lib/pkgconfig/libpjproject.pc ]; then
  echo "FATAL: pjsip install failed or did not produce libpjproject.pc"
  tail -40 /tmp/pjsip-install.log
  cp /tmp/pjsip-install.log /output/pjsip-install.log 2>/dev/null
  sync
  poweroff -f
fi

# Save the PJSIP install tree to the 9p output share so subsequent
# builds can reuse it without rebuilding all of PJSIP. The staging
# logic on the host side will check for /output/pjsip.install.tar
# at the next run and, if present, restore it into /build/ instead
# of unpacking + configuring + make-dep + make + make-install from
# scratch. That turns a ~30-minute cycle into a ~1-minute one for
# d-modem-only iteration.
echo ""
echo "saving PJSIP install tree for future iterations..."
(cd /build && tar -cf /output/pjsip.install.tar pjsip.install/ 2>/dev/null)
if [ -f /output/pjsip.install.tar ]; then
  ls -la /output/pjsip.install.tar
else
  echo "WARNING: could not save pjsip.install tarball"
fi

fi  # end of: if [ "$PJSIP_CACHED" = "0" ]; then ... pjsip build ... fi

# ─── Build d-modem ──────────────────────────────────────────────────

echo ""
echo "building d-modem..."
cd /src/d-modem
make PJSIP_PREFIX=/build/pjsip.install SLMODEMD_DIR=/src/slmodemd > /tmp/dmodem-make.log 2>&1
MAKE_RC=$?
tail -15 /tmp/dmodem-make.log

DMODEM_OK=0
if [ $MAKE_RC -eq 0 ] && [ -x d-modem ]; then
  echo ""
  echo "=== d-modem build OK ==="
  ls -la d-modem
  echo "glibc symbols:"
  strings d-modem 2>/dev/null | grep -E '^GLIBC_[0-9.]+$' | sort -u | sed 's/^/  /'
  if strings d-modem 2>/dev/null | grep -q __isoc23; then
    echo "WARNING: d-modem still has __isoc23_ symbols"
  fi
  cp d-modem /output/d-modem
  DMODEM_OK=1
else
  echo "d-modem build FAILED (rc=$MAKE_RC)"
  tail -60 /tmp/dmodem-make.log
  cp /tmp/dmodem-make.log /output/dmodem-make.log 2>/dev/null
fi

# ─── Build modemd-tunnel ───────────────────────────────────────────
#
# Standalone C program, no third-party deps. Builds in ~1 second even
# under TCG. Compile-failures here should not block the d-modem
# output since the two binaries are independent.

echo ""
echo "building modemd-tunnel..."
cd /src/tunnel
make > /tmp/tunnel-make.log 2>&1
TUNNEL_RC=$?
tail -10 /tmp/tunnel-make.log

TUNNEL_OK=0
if [ $TUNNEL_RC -eq 0 ] && [ -x modemd-tunnel ]; then
  echo ""
  echo "=== modemd-tunnel build OK ==="
  ls -la modemd-tunnel
  echo "glibc symbols:"
  strings modemd-tunnel 2>/dev/null | grep -E '^GLIBC_[0-9.]+$' | sort -u | sed 's/^/  /'
  if strings modemd-tunnel 2>/dev/null | grep -q __isoc23; then
    echo "WARNING: modemd-tunnel has __isoc23_ symbols"
  fi
  cp modemd-tunnel /output/modemd-tunnel
  TUNNEL_OK=1
else
  echo "modemd-tunnel build FAILED (rc=$TUNNEL_RC)"
  tail -40 /tmp/tunnel-make.log
  cp /tmp/tunnel-make.log /output/tunnel-make.log 2>/dev/null
fi

# ─── Build modemd-ctrl ─────────────────────────────────────────────
#
# Control-channel helper for slmodemd-pjsip. Standalone C program, no
# third-party deps. wire.h is included alongside modemd-ctrl.c in
# vm/ctrl/ (relocated there from vm/shim/ when backend A was removed).

if [ -d /src/ctrl ]; then
  echo ""
  echo "building modemd-ctrl..."
  cd /src/ctrl
  make i386 > /tmp/ctrl-make.log 2>&1
  CTRL_RC=$?
  tail -10 /tmp/ctrl-make.log

  CTRL_OK=0
  if [ $CTRL_RC -eq 0 ] && [ -x modemd-ctrl-i386 ]; then
    echo ""
    echo "=== modemd-ctrl build OK ==="
    ls -la modemd-ctrl-i386
    echo "glibc symbols:"
    strings modemd-ctrl-i386 2>/dev/null | grep -E '^GLIBC_[0-9.]+$' | sort -u | sed 's/^/  /'
    if strings modemd-ctrl-i386 2>/dev/null | grep -q __isoc23; then
      echo "WARNING: modemd-ctrl-i386 has __isoc23_ symbols"
    fi
    cp modemd-ctrl-i386 /output/modemd-ctrl
    CTRL_OK=1
  else
    echo "modemd-ctrl build FAILED (rc=$CTRL_RC)"
    tail -40 /tmp/ctrl-make.log
    cp /tmp/ctrl-make.log /output/ctrl-make.log 2>/dev/null
  fi
else
  # Not checked out — skip silently.
  CTRL_OK=1
fi

# ─── Build pjsip-test-peer ────────────────────────────────────────
#
# Test-only binary that links the same PJSIP install tree d-modem
# uses. Used by test/pjsip/signaling.test.js to exercise SIP
# signaling through the tunnel without needing slmodemd in the
# loop (step 3 of PJSIP.md). Skipped in production rootfs builds.

if [ -d /src/pjsip-test-peer ]; then
  echo ""
  echo "building pjsip-test-peer..."
  cd /src/pjsip-test-peer
  make PJSIP_PREFIX=/build/pjsip.install > /tmp/testpeer-make.log 2>&1
  TP_RC=$?
  tail -15 /tmp/testpeer-make.log
  TESTPEER_OK=0
  if [ $TP_RC -eq 0 ] && [ -x pjsip-test-peer ]; then
    echo ""
    echo "=== pjsip-test-peer build OK ==="
    ls -la pjsip-test-peer
    echo "glibc symbols:"
    strings pjsip-test-peer 2>/dev/null | grep -E '^GLIBC_[0-9.]+$' | sort -u | sed 's/^/  /'
    if strings pjsip-test-peer 2>/dev/null | grep -q __isoc23; then
      echo "WARNING: pjsip-test-peer has __isoc23_ symbols"
    fi
    cp pjsip-test-peer /output/pjsip-test-peer
    TESTPEER_OK=1
  else
    echo "pjsip-test-peer build FAILED (rc=$TP_RC)"
    tail -40 /tmp/testpeer-make.log
    cp /tmp/testpeer-make.log /output/testpeer-make.log 2>/dev/null
  fi
else
  # Not checked out — skip silently. Build script works on partial
  # trees.
  TESTPEER_OK=1
fi

sync
echo ""
if [ $DMODEM_OK = 1 ] && [ $TUNNEL_OK = 1 ] && [ $CTRL_OK = 1 ] && [ $TESTPEER_OK = 1 ]; then
    echo "BUILD_SUCCESS"
else
    echo "BUILD_FAILURE (d-modem=$DMODEM_OK tunnel=$TUNNEL_OK ctrl=$CTRL_OK testpeer=$TESTPEER_OK)"
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

# Restore PJSIP install tarball from persistent cache, if present.
# When the in-VM init script sees /output/pjsip.install.tar at boot,
# it skips the ~25-min PJSIP compile and only rebuilds d-modem +
# helpers (~1-2 min). The cache is host-side persistent (across
# sandbox / workdir resets) at $PJSIP_CACHE_DIR/pjsip.install.tar.
if [ -f "$PJSIP_CACHE_DIR/pjsip.install.tar" ]; then
  echo ""
  echo "  pjsip cache hit — copying $PJSIP_CACHE_DIR/pjsip.install.tar"
  cp "$PJSIP_CACHE_DIR/pjsip.install.tar" "$OUTPUT_DIR/pjsip.install.tar"
fi

echo ""
echo "── Running builder VM ──"
echo "RAM: 2048 MB, accel: tcg (software emulation)"
echo "Timeout: 3600 s — full build under TCG runs ~30-35 minutes"
echo "         in sandboxed environments; KVM/HVF hosts finish in"
echo "         a few minutes."

# More RAM than build-slmodemd-in-vm.sh because PJSIP's compile phase
# pushes peak memory higher than slmodemd's. 2 GB gives headroom for
# concurrent compile + link steps without OOM pressure under TCG.
#
# Timeout: 60 minutes. PJSIP's full build under TCG (sandboxed gVisor
# environment) runs ~30-35 min for compile + link + d-modem +
# modemd-tunnel + modemd-ctrl + pjsip-test-peer. With KVM/HVF accel
# it's much faster (a few minutes), but TCG is the lowest common
# denominator in CI/sandboxes, so we size the timeout for that case.
VM_LOG="$WORK_DIR/vm.log"
timeout 3600 qemu-system-i386 \
    -M pc -m 2048 -nographic \
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
  echo "── VM log (last 60 lines) ──"
  tail -60 "$VM_LOG"
  err "Build inside VM did not report BUILD_SUCCESS. See $VM_LOG"
fi

if [ ! -f "$OUTPUT_DIR/d-modem" ]; then
  err "Builder VM did not produce d-modem"
fi

# ─── Install the prebuilts ──────────────────────────────────────────
#
# All four binaries are built inside the VM and copied to /output by
# the init script. We install whatever's present and report hashes.
# d-modem is required (errored above if missing); the others are
# treated as best-effort but we warn loudly if expected ones are
# missing — they all should build under normal conditions.

mkdir -p "$VM_DIR/prebuilt"
echo ""
echo "── Installing to vm/prebuilt/ ──"

install_one() {
  local src_name="$1"     # name in /output (inside VM)
  local dst_name="$2"     # name in vm/prebuilt/
  local required="$3"     # "yes" or "no"
  local src="$OUTPUT_DIR/$src_name"
  if [ ! -f "$src" ]; then
    if [ "$required" = "yes" ]; then
      err "Builder VM did not produce $src_name"
    else
      echo "  WARN: $src_name not produced — skipping"
      return
    fi
  fi
  cp "$src" "$VM_DIR/prebuilt/$dst_name"
  chmod +x "$VM_DIR/prebuilt/$dst_name"
  local hash size
  hash=$(sha256sum "$VM_DIR/prebuilt/$dst_name" | awk '{print $1}')
  size=$(stat -c%s "$VM_DIR/prebuilt/$dst_name")
  printf '  %-22s SHA256: %s\n' "$dst_name" "$hash"
  printf '  %-22s Size:   %d bytes\n' " " "$size"
}

install_one d-modem            d-modem               yes
install_one modemd-tunnel      modemd-tunnel-i386    no
install_one modemd-ctrl        modemd-ctrl-i386      no
install_one pjsip-test-peer    pjsip-test-peer-i386  no

# Save PJSIP install tarball to persistent cache so subsequent runs
# can skip the ~25-min PJSIP compile.
if [ -f "$OUTPUT_DIR/pjsip.install.tar" ]; then
  cp "$OUTPUT_DIR/pjsip.install.tar" "$PJSIP_CACHE_DIR/pjsip.install.tar"
  echo ""
  echo "  cached pjsip.install.tar at $PJSIP_CACHE_DIR/pjsip.install.tar"
  echo "  (subsequent runs will skip the PJSIP compile phase)"
fi

echo ""
echo "Build complete. Update vm/prebuilt/PROVENANCE.txt if these hashes"
echo "differ from the committed values, then commit the new binaries."
