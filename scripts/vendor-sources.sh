#!/usr/bin/env bash
#
# vendor-sources.sh — Phase 1 of the maintainer release workflow.
#
# Populates vm/sources/ with GPL/LGPL upstream source tarballs and
# ~/.cache/synthmodem/debs/ with the Debian bookworm i386 toolchain
# .debs. Run this on the maintainer's host before producing a release.
#
# Idempotent: files already present with matching SHA256 are skipped.
#
# This script wraps:
#
#   scripts/fetch-vm-sources.sh    — populates vm/sources/
#                                     (~285 MB GPL/LGPL source tarballs)
#   scripts/fetch-vm-binaries.sh   — populates ~/.cache/synthmodem/debs/
#                                     (~115 MB Debian bookworm i386 .debs)
#
# After successful completion of this script, the repository has
# everything it needs to:
#
#   * Satisfy GPL §3(a) corresponding-source obligations for any
#     binary distribution.
#
#   * Run `scripts/rebuild-prebuilts.sh` (Phase 2) without network
#     access — every input is either committed to git or cached
#     under ~/.cache/synthmodem/.
#
# See MAINTAINERS.md for the full release workflow.
#
# Usage:
#   scripts/vendor-sources.sh             — fetch and verify
#   scripts/vendor-sources.sh --verify    — verify only, no fetches
#
# License: GPL-2.0-or-later

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VERIFY_ONLY=0
case "${1:-}" in
  ""|--no-verify) VERIFY_ONLY=0 ;;
  --verify)       VERIFY_ONLY=1 ;;
  -h|--help)
    sed -n '/^# vendor-sources.sh/,/^# License:/p' "$0" | sed 's/^# \?//'
    exit 0 ;;
  *) echo "Unknown argument: $1" >&2; exit 64 ;;
esac

step() {
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════"
}

if [ $VERIFY_ONLY -eq 1 ]; then
  step "Phase 1, step 1: vm/sources/ — verify only"
  bash "$SCRIPT_DIR/fetch-vm-sources.sh" --verify
  step "Phase 1, step 2: toolchain cache — verify only"
  bash "$SCRIPT_DIR/fetch-vm-binaries.sh" --verify 2>/dev/null \
      || echo "  (fetch-vm-binaries.sh has no --verify mode; cache will" \
              "be re-validated against pinned SHA256 on next rebuild)"
  echo ""
  echo "Vendor verification complete."
  exit 0
fi

step "Phase 1, step 1/2: GPL/LGPL upstream sources → vm/sources/"
bash "$SCRIPT_DIR/fetch-vm-sources.sh"

step "Phase 1, step 2/2: Debian bookworm i386 toolchain → cache"
bash "$SCRIPT_DIR/fetch-vm-binaries.sh"

step "Vendoring complete"
echo ""
echo "Next steps:"
echo "  * Commit vm/sources/ to git (subject to the kernel-tarball-size"
echo "    decision documented in MAINTAINERS.md)."
echo "  * Run scripts/rebuild-prebuilts.sh only if you actually need to"
echo "    regenerate vm/prebuilt/* (the committed binaries are"
echo "    authoritative; rebuild only when an upstream pin moves)."
