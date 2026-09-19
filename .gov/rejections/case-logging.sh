#!/usr/bin/env bash
# gate: logging
# Proves the logging gate's L3 (function body has a log call) sees real
# function spans: a log-less function behind a ' */' block-comment closer
# AND one with a destructured signature must both be rejected — the two
# span shapes that were invisible before the 2026-09-20 ruler fix.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q .
mkdir -p runtime
cat > runtime/bad.js <<'JS'
/** doc
 */
function plain() {
  return 1;
}
export function destructure({ register }) {
  register('x', {});
}
JS
git add runtime/bad.js
git -c user.email=t@t -c user.name=t commit -qm fixture
if python3 "$REPO/tools/check-logging.py" > out.txt 2>&1; then
  echo "case-logging: FAIL — log-less functions passed" >&2
  exit 1
fi
grep -q "bad.js:3" out.txt || { echo "case-logging: 'plain' (line 3) not flagged" >&2; exit 1; }
grep -q "bad.js:6" out.txt || { echo "case-logging: 'destructure' (line 6) not flagged" >&2; exit 1; }
echo "case-logging: log-less functions behind ' */' and destructured signatures rejected"
