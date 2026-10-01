#!/usr/bin/env bash
# gate: actionlint
# Proves the gate catches a workflow defect: a probe workflow with a broken
# `if:` expression (contains/1 — actionlint's expression type-checker rejects
# it three ways) appears under .github/workflows, the gate must go red naming
# it; removing the probe must turn the gate green. The probe is a NEW file —
# no real workflow is ever touched — and is removed on every exit path.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$REPO/tools/check-actionlint.sh"
WF_DIR="$REPO/.github/workflows"
PROBE="$WF_DIR/case-actionlint-probe.yml"
[ -f "$GATE" ] || { echo "case-actionlint: FAIL — gate script absent" >&2; exit 1; }
command -v actionlint >/dev/null 2>&1 || {
  # Same skip-on-absent contract as the gate itself; CI installs the pinned
  # release, so the proof is never lost there.
  echo "case-actionlint: SKIP — actionlint absent on this machine; the gate skip-louds the same way and gov.yml installs the pinned v1.7.12" >&2
  exit 0
}
[ -d "$WF_DIR" ] || { echo "case-actionlint: FAIL — .github/workflows absent" >&2; exit 1; }
OUT="$(mktemp)"
cleanup() { rm -f "$PROBE" "$OUT"; }
trap cleanup EXIT

cat > "$PROBE" <<'EOF'
# Throwaway probe of the actionlint rejection case — created and deleted by
# .gov/rejections/case-actionlint.sh, never committed.
on: push
jobs:
  case-probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo probe
        if: ${{ contains('only-one-arg') }}
EOF

if sh "$GATE" > "$OUT" 2>&1; then
  echo "case-actionlint: FAIL — a broken if: expression passed the gate" >&2
  exit 1
fi
grep -q "case-actionlint-probe.yml" "$OUT" || {
  echo "case-actionlint: red, but not about the probe workflow" >&2
  exit 1
}

cleanup
if ! sh "$GATE" > "$OUT" 2>&1; then
  echo "case-actionlint: FAIL — the tree without the probe still fails" >&2
  cat "$OUT" >&2
  exit 1
fi
echo "case-actionlint: probe workflow rejected, clean tree green — the gate sees .github/workflows"
