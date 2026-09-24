#!/usr/bin/env bash
# gate: bundle-files
# Proves the harmony BUNDLE_FILES ↔ rawfile cross-check rejects the
# #56/#57 drift class: a BUNDLE_FILES entry whose rawfile copy is missing
# (the direction that kills every fresh launch at copyRawFile before a
# single scenario line — silent E2E starvation). Runs the checker against
# the real tree with one rawfile file temporarily removed, asserts the red
# names the missing copy, restores, and proves the same run goes green.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REL="scenario/composer-web-live.js"
RAW="$REPO/hosts/harmony/entry/src/main/resources/rawfile/spike/$REL"
[ -f "$RAW" ] || {
  echo "case-bundle-files: FAIL — fixture file absent; materialize rawfile first (vendor-official.sh)" >&2
  exit 1
}
mv "$RAW" "$RAW.case-tmp"
restore() { mv "$RAW.case-tmp" "$RAW" 2>/dev/null || true; }
trap restore EXIT
OUT="$(mktemp)"
if node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" > "$OUT" 2>&1; then
  echo "case-bundle-files: FAIL — a missing rawfile copy passed" >&2
  exit 1
fi
grep -q "missing from rawfile" "$OUT" || {
  echo "case-bundle-files: red but not about the missing rawfile copy" >&2
  exit 1
}
restore
if ! node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" >/dev/null 2>&1; then
  echo "case-bundle-files: FAIL — the restored tree still fails" >&2
  exit 1
fi
echo "case-bundle-files: missing rawfile copy rejected; restored tree green"
