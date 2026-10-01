#!/usr/bin/env bash
# gate: shellcheck-warn
# Proves the gate's threshold-0 contract has teeth: a warning-grade finding
# (SC2034, the exact grade #289 zeroed) injected into a surface script turns
# the gate red; restoring the file turns it green again. Runs the gate
# narrowed to the one script — the full 89-script pass costs ~5s and would
# not fit the case budget twice; a narrowed run is the same binary, severity
# floor, and threshold (see the gate's usage comment).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$REPO/build/check-closures.sh"
GATE="$REPO/tools/check-shellcheck-warn.sh"
[ -f "$TARGET" ] || { echo "case-shellcheck-warn: FAIL — build/check-closures.sh absent" >&2; exit 1; }
[ -f "$GATE" ] || { echo "case-shellcheck-warn: FAIL — gate script absent" >&2; exit 1; }
command -v shellcheck >/dev/null 2>&1 || {
  # Same skip-on-absent contract as the gate itself: no tool, no judgment —
  # but say so, loudly, instead of faking a proof.
  echo "case-shellcheck-warn: SKIP — shellcheck absent on this machine; the gate skip-louds the same way and CI asserts the binary" >&2
  exit 0
}
cp "$TARGET" "$TARGET.case-tmp"
restore() { mv "$TARGET.case-tmp" "$TARGET" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'rm -f "$OUT"; restore' EXIT

# The break: one dead variable — SC2034, warning grade, threshold 0.
printf '\n# case-shellcheck-warn: warning-grade probe (reverted)\nDSH_CASE_SC2034_PROBE=1\n' >> "$TARGET"

if sh "$GATE" "$TARGET" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — an injected SC2034 passed the gate (threshold not 0?)" >&2
  exit 1
fi
grep -q "SC2034" "$OUT" || {
  echo "case-shellcheck-warn: red, but not about the injected finding" >&2
  exit 1
}

restore
if ! sh "$GATE" "$TARGET" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — the restored tree still fails" >&2
  cat "$OUT" >&2
  exit 1
fi
grep -q "0 warning/error-grade findings" "$OUT" || {
  echo "case-shellcheck-warn: green, but not via the clean verdict line" >&2
  exit 1
}
echo "case-shellcheck-warn: SC2034 rejected, restored tree green — threshold 0 has teeth"
