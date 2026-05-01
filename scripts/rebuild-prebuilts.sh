#!/usr/bin/env bash
#
# rebuild-prebuilts.sh — Phase 2 of the maintainer release workflow.
#
# Rebuilds vm/prebuilt/* from the vendored sources and reassembles
# vm/images/{bzImage, rootfs-slmodemd-pjsip.cpio.gz}. Only run this
# when a vendored source has actually moved — the committed
# vm/prebuilt/* is authoritative between rebuilds.
#
# Prerequisite: scripts/vendor-sources.sh must have run successfully
# at least once. This script does not fetch anything — it only
# orchestrates the in-VM builds against already-vendored inputs.
#
# This script wraps:
#
#   scripts/build-slmodemd-in-vm.sh  — produces vm/prebuilt/slmodemd
#                                       (~9 min under TCG, much less
#                                       with KVM/HVF acceleration)
#
#   scripts/build-pjsip-in-vm.sh     — produces vm/prebuilt/d-modem,
#                                       modemd-tunnel-i386,
#                                       modemd-ctrl-i386, and
#                                       pjsip-test-peer-i386 (~32 min
#                                       under TCG cold; ~3 min on
#                                       subsequent runs via PJSIP cache;
#                                       much less with KVM/HVF)
#
#   make -C vm                       — assembles the runtime images
#                                       (~5 sec)
#
# After completion, compare the new hashes against
# vm/prebuilt/PROVENANCE.txt to confirm reproducibility.
#
# See MAINTAINERS.md for the full release workflow.
#
# Usage:
#   scripts/rebuild-prebuilts.sh             — rebuild everything
#   scripts/rebuild-prebuilts.sh --slmodemd  — rebuild only slmodemd
#   scripts/rebuild-prebuilts.sh --pjsip     — rebuild only the PJSIP
#                                              binaries (d-modem +
#                                              tunnel + ctrl + test-peer)
#   scripts/rebuild-prebuilts.sh --images    — rebuild only the runtime
#                                              images (skip the in-VM
#                                              builds; useful when
#                                              prebuilts haven't moved)
#
# License: GPL-2.0-or-later

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="$REPO_ROOT/vm"

DO_SLMODEMD=1
DO_PJSIP=1
DO_IMAGES=1

case "${1:-}" in
  "")            ;;
  --slmodemd)    DO_PJSIP=0; DO_IMAGES=0 ;;
  --pjsip)       DO_SLMODEMD=0; DO_IMAGES=0 ;;
  --images)      DO_SLMODEMD=0; DO_PJSIP=0 ;;
  -h|--help)
    sed -n '/^# rebuild-prebuilts.sh/,/^# License:/p' "$0" | sed 's/^# \?//'
    exit 0 ;;
  *) echo "Unknown argument: $1" >&2; exit 64 ;;
esac

step() {
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════"
}

# Pre-flight: vendor cache must exist. If it doesn't, fail fast with
# a pointer at vendor-sources.sh.
if [ ! -d "$VM_DIR/sources" ] || [ -z "$(ls -A "$VM_DIR/sources" 2>/dev/null)" ]; then
  echo "ERROR: vm/sources/ is empty." >&2
  echo "       Run scripts/vendor-sources.sh first." >&2
  exit 1
fi

if [ $DO_SLMODEMD -eq 1 ]; then
  step "Phase 2, step 1/3: Rebuild vm/prebuilt/slmodemd"
  bash "$SCRIPT_DIR/build-slmodemd-in-vm.sh"
fi

if [ $DO_PJSIP -eq 1 ]; then
  step "Phase 2, step 2/3: Rebuild vm/prebuilt/{d-modem,modemd-tunnel-i386,modemd-ctrl-i386,pjsip-test-peer-i386}"
  bash "$SCRIPT_DIR/build-pjsip-in-vm.sh"
fi

if [ $DO_IMAGES -eq 1 ]; then
  step "Phase 2, step 3/3: Rebuild vm/images/{bzImage, rootfs-slmodemd-pjsip.cpio.gz}"
  make -C "$VM_DIR" clean
  make -C "$VM_DIR"
fi

step "Rebuild complete"
echo ""
echo "Output binaries:"
ls -la "$VM_DIR/prebuilt/" 2>/dev/null | grep -v '^total\|^d' | awk '{print "  " $9 " (" $5 " bytes)"}'
echo ""
echo "Output images:"
ls -la "$VM_DIR/images/" 2>/dev/null | grep -v '^total\|^d' | awk '{print "  " $9 " (" $5 " bytes)"}'
echo ""
echo "Next steps:"
echo "  * Compare hashes against vm/prebuilt/PROVENANCE.txt:"
echo "      sha256sum vm/prebuilt/* | sort"
echo "  * If a hash differs and the change is intentional, update"
echo "    PROVENANCE.txt and commit the new binaries together with"
echo "    the source change."
echo "  * Note: modemd-ctrl-i386 embeds 'git describe --dirty' as"
echo "    BUILD_ID; commit your working tree first before comparing"
echo "    that one."
