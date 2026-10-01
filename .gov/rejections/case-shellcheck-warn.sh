#!/usr/bin/env bash
# gate: shellcheck-warn
# Proves two contracts have teeth. (1) Threshold 0: a warning-grade finding
# (SC2034, the exact grade #289 zeroed) turns the gate red; fixing the file
# turns it green again. (2) No vacuous green: a file shellcheck cannot JUDGE
# (mode 000 — shellcheck exits 2, zero comments) must fail the gate loudly,
# never print green (PR #294 review: the gate once swallowed rc>=2 into a
# fake pass). Both legs run the gate narrowed to a THROWAWAY probe file in
# /tmp — never a repository file: the DAG runs this case (via self-test) and
# the shellcheck-warn gate CONCURRENTLY on one tree, and leg mutations to a
# tracked surface script would race a concurrent full-surface scan into a
# false red (seen on CI). A narrowed run is the same binary, severity floor,
# and threshold (see the gate's usage comment).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$REPO/tools/check-shellcheck-warn.sh"
[ -f "$GATE" ] || { echo "case-shellcheck-warn: FAIL — gate script absent" >&2; exit 1; }
command -v shellcheck >/dev/null 2>&1 || {
  # Same skip-on-absent contract as the gate itself: no tool, no judgment —
  # but say so, loudly, instead of faking a proof.
  echo "case-shellcheck-warn: SKIP — shellcheck absent on this machine; the gate skip-louds the same way and CI asserts the binary" >&2
  exit 0
}
PROBE="$(mktemp /tmp/case-sc-probe.XXXXXX.sh)"
OUT="$(mktemp)"
trap 'rm -f "$PROBE" "$OUT"' EXIT

# Leg 1 — threshold 0: one dead variable (SC2034, warning grade) turns the
# gate red naming SC2034; a clean probe turns it green again.
printf '#!/bin/sh\n# case-shellcheck-warn: warning-grade probe (reverted)\nDSH_CASE_SC2034_PROBE=1\n' > "$PROBE"
if sh "$GATE" "$PROBE" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — an injected SC2034 passed the gate (threshold not 0?)" >&2
  exit 1
fi
grep -q "SC2034" "$OUT" || {
  echo "case-shellcheck-warn: red, but not about the injected finding" >&2
  exit 1
}
printf '#!/bin/sh\n# case-shellcheck-warn: clean probe (reverted)\necho ok\n' > "$PROBE"
if ! sh "$GATE" "$PROBE" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — the fixed probe still fails" >&2
  cat "$OUT" >&2
  exit 1
fi
grep -q "0 warning/error-grade findings" "$OUT" || {
  echo "case-shellcheck-warn: green, but not via the clean verdict line" >&2
  exit 1
}

# Leg 2 — no vacuous green: an unjudgeable file (mode 000, shellcheck rc=2,
# zero comments) must fail the gate loudly, then pass once judgeable again.
chmod 000 "$PROBE"
if sh "$GATE" "$PROBE" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — an unjudgeable file produced a green verdict (vacuous green)" >&2
  exit 1
fi
grep -q "could not judge the surface" "$OUT" || {
  echo "case-shellcheck-warn: red, but not about the unjudgeable file" >&2
  exit 1
}
chmod 644 "$PROBE"
if ! sh "$GATE" "$PROBE" > "$OUT" 2>&1; then
  echo "case-shellcheck-warn: FAIL — after the mode restore the probe still fails" >&2
  cat "$OUT" >&2
  exit 1
fi
echo "case-shellcheck-warn: SC2034 rejected, unjudgeable file rejected, fixed probe green — threshold 0 and no vacuous green both have teeth"