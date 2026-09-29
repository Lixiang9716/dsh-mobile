#!/usr/bin/env bash
# gate: quickjs-boot-parse
# Proves the gate sees what node --check cannot: a break that is node-clean
# and QuickJS-fatal. Vehicle: a static import cycle between the split roots
# fs.js and fs-seeded.js — the exact 2026-09-29 split surface (node ESM
# tolerates cycles; the vendored quickjs-ng loader rejects them at load).
# Breaks the shim, requires the gate red naming the cycle, restores, and
# requires the same run green.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SEEDED="$REPO/runtime/spike/upstream/shims/fs-seeded.js"
GATE="$REPO/runtime/spike/ci/check-quickjs-boot-parse.sh"
[ -f "$SEEDED" ] || { echo "case-quickjs-boot-parse: FAIL — fs-seeded.js absent" >&2; exit 1; }
[ -x "$REPO/runtime/spike/build/dsh-spike-cli" ] || {
  # Cold CI: gov.yml materializes the engine SOURCES but never builds the
  # CLI (the ish link needs minutes the self-test case budget doesn't
  # carry). The proof is not lost — the quickjs-boot-parse GATE builds on
  # miss with a 300s budget and runs this same break/restore against the
  # real engine. Skip here, loudly, rather than fail on an absent artifact.
  echo "case-quickjs-boot-parse: SKIP — CLI absent on this runner; the quickjs-boot-parse gate builds and proves the break on demand (runtime/spike/host/build.sh)" >&2
  exit 0
}
cp "$SEEDED" "$SEEDED.case-tmp"
restore() { mv "$SEEDED.case-tmp" "$SEEDED" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'rm -f "$OUT"; restore' EXIT

printf '\n// case-quickjs-boot-parse: node-clean/QuickJS-fatal cycle (reverted)\nimport { vfs } from '"'"'upstream/shims/fs.js'"'"';\n' >> "$SEEDED"

# The break must be node-clean — otherwise the case proves nothing about the
# gap this gate exists to close.
if command -v node >/dev/null 2>&1; then
  node --check "$SEEDED" || {
    echo "case-quickjs-boot-parse: FAIL — fixture is node-dirty; it must be node-clean" >&2
    exit 1
  }
fi

if sh "$GATE" > "$OUT" 2>&1; then
  echo "case-quickjs-boot-parse: FAIL — a node-clean import cycle passed the gate" >&2
  exit 1
fi
grep -q "circular import" "$OUT" || {
  echo "case-quickjs-boot-parse: red but not about the import cycle" >&2
  exit 1
}

restore
if ! sh "$GATE" >/dev/null 2>&1; then
  echo "case-quickjs-boot-parse: FAIL — the restored tree still fails" >&2
  exit 1
fi
echo "case-quickjs-boot-parse: node-clean/QuickJS-fatal import cycle rejected; restored tree green"
