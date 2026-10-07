#!/usr/bin/env bash
# gate: transport-tokens
# Proves the transport-tokens checker rejects the exact defect class it
# exists for: a pre-rename token spelling resurfacing in a live layer file.
# Vehicle: append a comment carrying 'dsh.spike.log' to runtime/dsh/logger.js
# — the 2026-10 rename's most-contagious old spelling (139 verdict/tool
# files carried it), planted in the canonical closure a comment-only edit
# cannot reach. Asserts the red names the file AND the token, restores
# byte-identically, and proves the same run goes green.
#
# No live-tree case lock: the mutation is one inert comment line in
# runtime/dsh/logger.js — parse-neutral for case-quickjs-boot-parse,
# import-neutral for case-staging-check (its walker masks comments), and
# marker-neutral for the logging gates (no console/exempt-marker change);
# measured against every other case's checker, nothing flips verdicts. The
# checker's own green leg is robust to the sibling cases' windows: a
# tracked file temporarily moved reads as absent and is skipped, never a
# forbidden hit.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$REPO/runtime/dsh/logger.js"
[ -f "$TARGET" ] || { echo "case-transport-tokens: FAIL — logger.js absent" >&2; exit 1; }

cp "$TARGET" "$TARGET.case-tmp"
restore() { mv "$TARGET.case-tmp" "$TARGET" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'restore; rm -f "$OUT"' EXIT

# The injection: the old log-line prefix family, in a comment — the shape a
# copy-paste from a pre-rename artifact or a stale fixture reintroduces.
printf '\n// case-transport-tokens probe: the old prefix dsh.spike.log must be rejected\n' >> "$TARGET"

if node "$REPO/tools/check-transport-tokens.mjs" > "$OUT" 2>&1; then
  echo "case-transport-tokens: FAIL — a pre-rename spelling passed the checker" >&2
  exit 1
fi
grep -q 'runtime/dsh/logger.js' "$OUT" && grep -q "dsh.spike." "$OUT" || {
  echo "case-transport-tokens: red but not about the injected logger.js spelling" >&2
  exit 1
}

restore
if ! node "$REPO/tools/check-transport-tokens.mjs" >/dev/null 2>&1; then
  echo "case-transport-tokens: FAIL — the restored tree still fails" >&2
  exit 1
fi
echo "case-transport-tokens: pre-rename spelling rejected; restored tree green"
