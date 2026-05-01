#!/usr/bin/env bash
#
# fetch-slmodemd.sh — refresh vm/slmodemd/ from the D-Modem upstream.
#
# This vendors slmodemd's source (and the redistributable dsplibs.o
# closed-source DSP blob) into vm/slmodemd/. We do not fork slmodemd,
# and we never modify files inside vm/slmodemd/. The synthmodem-specific
# driver logic lives in src/backends/.
#
# Usage:
#   scripts/fetch-slmodemd.sh                 # uses pinned commit in UPSTREAM.txt
#   scripts/fetch-slmodemd.sh --rev <sha>     # fetches a specific commit
#   scripts/fetch-slmodemd.sh --rev main      # latest on the default branch
#
# After running, inspect the diff, update vm/slmodemd/UPSTREAM.txt with
# the new commit hash and today's date, and commit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vm/slmodemd"
UPSTREAM_FILE="$VENDOR_DIR/UPSTREAM.txt"

UPSTREAM_REPO_DEFAULT="https://github.com/synexo/D-Modem"
UPSTREAM_SUBPATH="slmodemd"

REV="$(awk -F': *' '/^upstream-commit:/ {print $2}' "$UPSTREAM_FILE" 2>/dev/null || true)"
REPO="$(awk -F': *' '/^upstream-repo:/   {print $2}' "$UPSTREAM_FILE" 2>/dev/null || true)"
REPO="${REPO:-$UPSTREAM_REPO_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --rev)   REV="$2"; shift 2 ;;
    --repo)  REPO="$2"; shift 2 ;;
    *)       echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -z "$REV" ]; then
  echo "No revision pinned in $UPSTREAM_FILE and none passed with --rev." >&2
  exit 1
fi

echo "Fetching $REPO ($UPSTREAM_SUBPATH) at revision $REV ..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --quiet --filter=blob:none "$REPO" "$TMP/src"
cd "$TMP/src"
git checkout --quiet "$REV"
RESOLVED_SHA="$(git rev-parse HEAD)"
cd - > /dev/null

# Preserve the UPSTREAM.txt we already have (it's synthmodem-specific),
# then replace the source files wholesale. dsplibs.o IS vendored (it's
# the redistributable blob); *.bak and *.o.mod files are not (they
# were upstream's own staging artifacts).
SAVED_UPSTREAM="$(mktemp)"
cp "$UPSTREAM_FILE" "$SAVED_UPSTREAM"

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

# Copy source files + the one blob. Explicitly reject build leftovers.
cp -r "$TMP/src/$UPSTREAM_SUBPATH/." "$VENDOR_DIR/"
find "$VENDOR_DIR" \( -name '*.o' -o -name '*.bak' -o -name '*.o.mod' \) \
  -not -name 'dsplibs.o' -delete

mv "$SAVED_UPSTREAM" "$UPSTREAM_FILE"

echo
echo "vm/slmodemd/ refreshed to $RESOLVED_SHA"
echo
echo "Next steps:"
echo "  1. Edit $UPSTREAM_FILE and update upstream-commit + vendored-at."
echo "  2. git diff vm/slmodemd/ and review."
echo "  3. cd vm && make  (verify the build still works)."
echo "  4. Commit."
