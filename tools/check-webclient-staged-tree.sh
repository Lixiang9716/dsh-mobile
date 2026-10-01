#!/bin/sh
# check-webclient-staged-tree.sh — the staged-tree invariant as a REAL gate
# (A12): presentation/web-client-next is WHOLE-TREE staged into the harmony
# HAP rawfile (hosts/harmony/ci/vendor-official.sh's webclient_files find()s
# every file), so the product directory must hold exactly its shipped files —
# test tooling (node_modules, coverage/, vite caches) may not leak into it.
#
# This invariant used to live ONLY inside tools/test/run-presentation-tests.sh,
# a CI-workflow step — so a local `gov run` could go green while CI went red
# on exactly this class (measured: #288). gates.json now carries the check as
# the `webclient-staged-tree` gate, and the runner calls THIS script instead
# of carrying its own copy of the count — one home for the number.
#
# usage: sh tools/check-webclient-staged-tree.sh   exit 0 = tree intact
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="$ROOT/presentation/web-client-next"

# 16 shipped files (14 through the BYOK onboarding leg #280; +2 since the
# marketplace panel #288: marketplace-core.js + marketplace.js). The count
# moves only with a reviewed product change — never with tooling leakage.
PRODUCT_FILES=16

[ -d "$DIR" ] || {
    echo "webclient-staged-tree: FAIL — $DIR absent" >&2
    exit 1
}
count=$(find "$DIR" -type f | wc -l | tr -d ' ')
if [ "$count" -ne "$PRODUCT_FILES" ]; then
    echo "webclient-staged-tree: FAIL — presentation/web-client-next holds $count files, expected exactly $PRODUCT_FILES; the whole-tree-staged HAP directory admits no tooling leakage" >&2
    git -C "$ROOT" ls-files --others --exclude-standard -- "$DIR" | head -20 | sed 's/^/  leak (untracked): /' >&2 || true
    find "$DIR" -type d \( -name node_modules -o -name coverage -o -name .vite \) | head -5 | sed 's/^/  leak (ignored tooling dir): /' >&2 || true
    exit 1
fi
echo "webclient-staged-tree: OK — presentation/web-client-next holds exactly its $PRODUCT_FILES shipped files"
