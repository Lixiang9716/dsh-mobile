#!/usr/bin/env bash
# gate: staging-check
# Proves the staging-manifest verifier catches the disease it exists for
# (the 2026-09 fresh-install death): a file the import graph REACHES that
# the hand manifest no longer stages. Vehicle: the upstream/boot.js row in
# harmony's Index.ets BUNDLE_FILES — a boot entry every reached file hangs
# from, so dropping its single row is the minimal real gap. Runs the checker
# against the real tree with the row removed, asserts the red names the file
# as a GAP on a blocking host, restores byte-identically, and proves the
# same run goes green.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IDX="$REPO/hosts/harmony/entry/src/main/ets/pages/Index.ets"
[ -f "$IDX" ] || { echo "case-staging-check: FAIL — Index.ets absent" >&2; exit 1; }
grep -q "^\s*'upstream/boot\.js',$" "$IDX" || {
  echo "case-staging-check: FAIL — fixture row 'upstream/boot.js' absent from BUNDLE_FILES" >&2
  exit 1
}
cp "$IDX" "$IDX.case-tmp"
restore() { mv "$IDX.case-tmp" "$IDX" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'rm -f "$OUT"; restore' EXIT

grep -v "^\s*'upstream/boot\.js',$" "$IDX" > "$IDX.case-tmp.2" && mv "$IDX.case-tmp.2" "$IDX"

if node "$REPO/tools/check-staging.mjs" --json --block harmony,android,ios > "$OUT" 2>&1; then
  echo "case-staging-check: FAIL — a boot entry missing from BUNDLE_FILES passed the gate" >&2
  exit 1
fi
# --json mode: the gap surfaces as a structured row of the harmony result,
# not the human "GAP … NOT staged" line — assert on the payload itself.
grep -q '"file": "upstream/boot.js"' "$OUT" || {
  echo "case-staging-check: red but not about the unstaged boot entry" >&2
  exit 1
}

restore
if ! node "$REPO/tools/check-staging.mjs" --json --block harmony,android,ios >/dev/null 2>&1; then
  echo "case-staging-check: FAIL — the restored tree still fails" >&2
  exit 1
fi
echo "case-staging-check: unstaged boot entry rejected; restored tree green"
