#!/usr/bin/env bash
# tools/e2e/ensure-client-bundles.sh — materialize the W-SHELL application-
# tier client bundles (presentation/official-web/client-bundles/npm) and
# verify them against the committed MANIFEST.sha256. The bundle bytes are
# reproducible from upstream's own build (presentation/official-web/
# client-bundles/build-client-bundles.sh at the PROVENANCE pin), so a
# missing tree is rebuilt, never faked. The tree is UNTRACKED (like the
# official dist): the committed provenance record is MANIFEST.sha256 +
# ROSTER.json + PROVENANCE.md.
#
# usage: ensure-client-bundles.sh [--force]   exit 0 = bundles present + verified
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$HERE/presentation/official-web/client-bundles"
NPM="$DIR/npm"
MANIFEST="$DIR/MANIFEST.sha256"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ok() { (cd "$NPM" && shasum -a 256 -c "$MANIFEST" >/dev/null 2>&1); }

if [ "$FORCE" -eq 1 ]; then
  rm -rf "$NPM"
fi

if [ -d "$NPM" ] && ok; then
  echo "ensure-client-bundles: bundles verified ($(find "$NPM" -type f | wc -l | tr -d ' ') files)"
  exit 0
fi

if [ -d "$NPM" ]; then
  echo "ensure-client-bundles: npm tree present but MANIFEST mismatch — rebuilding" >&2
  rm -rf "$NPM"
fi

echo "ensure-client-bundles: building client bundles from the pinned upstream (reproducible; several minutes)"
"$DIR/build-client-bundles.sh" >/tmp/dsh-client-bundles-build.log 2>&1 \
  || {
    echo "ensure-client-bundles: build failed — build log follows:" >&2
    tail -40 /tmp/dsh-client-bundles-build.log >&2 || true
    exit 1
  }

ok || { echo "ensure-client-bundles: rebuilt tree still fails MANIFEST verification" >&2; exit 1; }
echo "ensure-client-bundles: bundles built and verified"
