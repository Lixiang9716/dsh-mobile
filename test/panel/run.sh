#!/bin/sh
# test/panel/run.sh — the panel unit-suite runner (vitest over the
# web-client-next page's pure logic). Node resolves through nvm like
# test/e2e/matrix.sh; the deps come from npm install in this dir on a fresh
# tree (test/upstream-suite pins the same vitest version). The suite's own
# config scopes collection to THIS dir — a repo-root run would sweep the
# vendored corpus (measured: 173 files, 3 failures that are not ours).
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
[ -x "$DIR/node_modules/.bin/vitest" ] || {
  echo "panel-tests: node_modules missing — run npm install in test/panel" >&2
  exit 2
}
cd "$DIR"
exec "$NODE" ./node_modules/.bin/vitest run
