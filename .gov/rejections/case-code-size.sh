#!/usr/bin/env bash
# gate: code-size
# Proves code-size goes red on an oversized function hiding behind the
# common ' */' comment-closer style — the exact shape that made the span
# ruler vacuous before the 2026-09-20 fix (empty spans, silent green).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q .
python3 - <<'PY'
body = "\n".join(f"  x{i} = {i}  // padding" for i in range(60))
open("big.js", "w").write(
    "/** doc\n"
    " */\n"          # indented closer — must NOT swallow the file
    "function big() {\n"
    f"{body}\n"
    "}\n"
)
PY
git add big.js
git -c user.email=t@t -c user.name=t commit -qm fixture
if python3 "$REPO/tools/check-size.py" > out.txt 2>&1; then
  echo "case-code-size: FAIL — oversized function with ' */' closer passed" >&2
  exit 1
fi
grep -q "big.js" out.txt || { echo "case-code-size: red but not about big.js" >&2; exit 1; }
echo "case-code-size: oversized function behind ' */' closer rejected"
