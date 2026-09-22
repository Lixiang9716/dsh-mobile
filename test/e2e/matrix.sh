#!/bin/sh
# Run the evidence-matrix checker with a resolvable `node`.
#
# The gate in gates.json calls THIS, not `node` directly: a gate command that
# cannot resolve is a red gate, not a skipped one, and `node` is absent from
# this project's local PATH (it lives under nvm) while the ubuntu CI runner has
# it. Calling `node` directly would have made every local `gov run` red and
# every local push refused.
set -eu
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "e2e-matrix: no node on PATH and none under ~/.nvm — cannot check the evidence matrix" >&2
  exit 2
fi
exec "$NODE" "$(dirname "$0")/matrix.mjs" "$@"
