#!/bin/sh
# test/panel/run.sh — the panel unit-suite runner (vitest over the
# web-client-next page's pure logic). Node resolves through nvm like
# test/e2e/matrix.sh. The suite SELF-PROVISIONS its deps: node_modules/ is
# gitignored, so a fresh checkout (and CI) lands without it — review finding
# on PR #280: the gate must not be red-by-construction there. With the
# committed package-lock.json the install is `npm ci`; the fallback covers a
# tree where the lockfile cannot resolve (registry drift).
set -eu
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "panel-tests: no node on PATH and none under ~/.nvm — cannot run the panel suite" >&2
  exit 2
fi
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"
NPM="$DIR/node_modules/.bin/vitest"
if [ ! -x "$NPM" ]; then
  echo "panel-tests: node_modules missing — provisioning (npm install; CI has network)" >&2
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi
[ -x "$NPM" ] || {
  echo "panel-tests: vitest still missing after provisioning — npm install failed" >&2
  exit 2
}
exec "$NODE" ./node_modules/.bin/vitest run
