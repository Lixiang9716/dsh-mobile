#!/usr/bin/env bash
# gate: webclient-staged-tree
# Proves the staged-tree gate rejects the #288 leak class: one unsynced
# (untracked) file inside the whole-tree-staged presentation/web-client-next
# directory turns the file-count check red, and removing it restores green.
# This is the ask's hand counter-proof for A12, institutionalized per
# rules.md §6 (a gate that never fails is a vacuous script).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$REPO/presentation/web-client-next"
LEAK="$DIR/web/js/.case-leak-tmp.js"

restore() { rm -f "$LEAK"; }
trap restore EXIT

[ -d "$DIR" ] || {
  echo "case-webclient-staged-tree: FAIL — product directory absent" >&2
  exit 1
}
printf '/* rejection-case leak: an unsynced file the HAP cannot carry */\n' > "$LEAK"
OUT="$(mktemp)"
if sh "$REPO/tools/check-webclient-staged-tree.sh" > "$OUT" 2>&1; then
  echo "case-webclient-staged-tree: FAIL — an unsynced file in the staged tree PASSED the gate" >&2
  exit 1
fi
grep -qE "holds [0-9]+ files, expected exactly [0-9]+" "$OUT" || {
  echo "case-webclient-staged-tree: gate went red but not about the staged-file count" >&2
  exit 1
}
restore
if ! sh "$REPO/tools/check-webclient-staged-tree.sh" >/dev/null 2>&1; then
  echo "case-webclient-staged-tree: FAIL — the restored tree still fails the gate" >&2
  exit 1
fi
echo "case-webclient-staged-tree: unsynced file rejected (count mismatch named); restored tree green"
