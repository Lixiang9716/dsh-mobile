#!/usr/bin/env bash
# test/e2e/ensure-official-dist.sh — materialize the vendored official web
# dist (presentation/official-web/dist) and verify it against the committed
# MANIFEST.sha256. The dist bytes are reproducible from upstream's own build
# (presentation/official-web/build-upstream.sh at the PROVENANCE pin), so a
# missing tree is rebuilt, never faked.
#
# usage: ensure-official-dist.sh [--force]   exit 0 = dist present + verified
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="$HERE/presentation/official-web/dist"
MANIFEST="$HERE/presentation/official-web/MANIFEST.sha256"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ok() { (cd "$DIST" && shasum -a 256 -c "$MANIFEST" >/dev/null 2>&1); }
# The mismatch itself, on demand: `ok` is a predicate, but a bare
# "mismatch" with no filename is undiagnosable — it cost a full
# investigation to learn that a rebuilt tree can differ from the
# committed MANIFEST. Print the offending lines instead.
why() { (cd "$DIST" && shasum -a 256 -c "$MANIFEST" 2>&1 | grep -v ": OK$" || true); }

if [ "$FORCE" -eq 1 ]; then
  rm -rf "$DIST"
fi

if [ -f "$DIST/index.html" ] && ok; then
  echo "ensure-official-dist: dist verified ($(ls "$DIST" | wc -l | tr -d ' ') top-level entries)"
  exit 0
fi

if [ -f "$DIST/index.html" ]; then
  echo "ensure-official-dist: dist present but MANIFEST mismatch — rebuilding" >&2
  why >&2
  rm -rf "$DIST"
fi

echo "ensure-official-dist: building official dist from the pinned upstream (reproducible; several minutes)"
"$HERE/presentation/official-web/build-upstream.sh" >/tmp/dsh-official-dist-build.log 2>&1 \
  || {
    echo "ensure-official-dist: build failed — build log follows:" >&2
    tail -40 /tmp/dsh-official-dist-build.log >&2 || true
    exit 1
  }

ok || { echo "ensure-official-dist: rebuilt dist still fails MANIFEST verification" >&2; exit 1; }
echo "ensure-official-dist: dist built and verified"
