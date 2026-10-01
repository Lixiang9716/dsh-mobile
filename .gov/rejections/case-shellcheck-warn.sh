#!/usr/bin/env bash
# gate: shellcheck-warn
# Proves two contracts have teeth. (1) Threshold 0: a warning-grade finding
# (SC2034, the exact grade #289 zeroed) injected into a surface script turns
# the gate red; restoring the file turns it green again. (2) No vacuous
# green: a surface file shellcheck cannot JUDGE (mode 000 — shellcheck exits
# 2, zero comments) must fail the gate loudly, never print green (PR #294
# review: the gate once swallowed rc>=2 into a fake pass). Both legs run the
# gate narrowed to the one script — the full-surface pass costs ~5s and
# would not fit the case budget; a narrowed run is the same binary, severity
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
MODE=$(stat -f '%Lp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET")
restore() {
  chmod "$MODE" "$TARGET" 2>/dev/null || true
  if [ -f "$TARGET.case-tmp" ]; then mv "$TARGET.case-tmp" "$TARGET" 2>/dev/null || true; fi
}
OUT="$(mktemp)"
trap 'rm -f "$OUT"; restore' EXIT

# Leg 1 — the break: one dead variable — SC2034, warning grade, threshold 0.
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

# Leg 2 — the unjudgeable file: mode 000 makes shellcheck exit 2 with zero
# comments. The gate must refuse to read that as a pass.
chmod 000 "$TARGET"
if sh "$GATE" "$TARGET" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — an unjudgeable file produced a green verdict (vacuous green)" >&2
  exit 1
fi
grep -q "could not judge the surface" "$OUT" || {
  echo "case-shellcheck-warn: red, but not about the unjudgeable file" >&2
  exit 1
}

restore
if ! sh "$GATE" "$TARGET" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — after the mode restore the tree still fails" >&2
  cat "$OUT" >&2
  exit 1
fi
echo "case-shellcheck-warn: SC2034 rejected, unjudgeable file rejected, restored tree green — threshold 0 and no vacuous green both have teeth"
