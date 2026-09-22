#!/usr/bin/env bash
# test/e2e/ensure-client-bundles.sh — materialize the W-SHELL application-
# tier client bundles (presentation/official-web/client-bundles/npm) and
# verify them. The bundle bytes are reproducible from upstream's own build
# (presentation/official-web/client-bundles/build-client-bundles.sh at the
# PROVENANCE pin), so a missing tree is rebuilt, never faked. The tree is
# UNTRACKED (like the official dist): the committed provenance record is
# MANIFEST.sha256 + ROSTER.json + PROVENANCE.md.
#
# TWO records, two questions (D15):
#
#   MANIFEST.sha256.computed  travels WITH the tree and answers "are these the
#                             bytes THIS environment's build produced" — the
#                             integrity question a cache restore needs, and the
#                             one that can be answered everywhere.
#   MANIFEST.sha256           is the committed REFERENCE record, answering "are
#                             these the bytes the reference build produced". It
#                             is compared on every run and its divergence is
#                             bounded by verify-manifest.mjs: the upstream
#                             client build embeds the ABSOLUTE work path (in
#                             the dsh-css region markers and in lightningcss's
#                             css-module `[hash]_[local]`, which hashes the
#                             absolute virtual filename), so a macOS build and
#                             the Linux CI build differ in exactly the files
#                             that embed it — measured: the same 40 of 116. A
#                             divergence OUTSIDE that class is a real byte
#                             change and fails loud.
#
# Verifying a rebuilt tree against a record the build itself just wrote would be
# self-certification; the build therefore never renews the reference record, and
# the comparison above is what carries the provenance claim here.
#
# usage: ensure-client-bundles.sh [--force]   exit 0 = bundles present + verified
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$HERE/presentation/official-web/client-bundles"
NPM="$DIR/npm"
MANIFEST="$DIR/MANIFEST.sha256"
COMPUTED="$DIR/MANIFEST.sha256.computed"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Verify against a named record. See ensure-official-dist.sh why(): name the
# offending files rather than reporting an anonymous mismatch.
verifies() { (cd "$NPM" && shasum -a 256 -c "$1" >/dev/null 2>&1); }
why() { (cd "$NPM" && shasum -a 256 -c "$1" 2>&1 | grep -v ": OK$" || true); }

# Compare the tree against the committed reference and bound the divergence.
# Called for a tree this environment built or carried here from a cache: it
# never rebuilds, it reports. The work path is passed literally — the
# classifier accepts any leading-directory prefix of it, which is what a tree
# built on another platform embeds (the build pins the path, not its realpath).
compare() {
  node "$DIR/verify-manifest.mjs" --tree "$NPM" --reference "$MANIFEST" \
    --work /tmp/dsh-harness-src
}

if [ "$FORCE" -eq 1 ]; then
  rm -rf "$NPM"
fi

if [ -d "$NPM" ] && verifies "$MANIFEST"; then
  echo "ensure-client-bundles: bundles verified against the committed REFERENCE record ($(find "$NPM" -type f | wc -l | tr -d ' ') files)"
  exit 0
fi

if [ -d "$NPM" ] && verifies "$COMPUTED"; then
  echo "ensure-client-bundles: bundles verified against this environment's own build record ($(find "$NPM" -type f | wc -l | tr -d ' ') files)"
  compare
  exit 0
fi

if [ -d "$NPM" ]; then
  echo "ensure-client-bundles: npm tree present but matches neither record — rebuilding" >&2
  verifies "$COMPUTED" || why "$COMPUTED" >&2
  rm -rf "$NPM"
fi

echo "ensure-client-bundles: building client bundles from the pinned upstream (reproducible; several minutes)"
"$DIR/build-client-bundles.sh" >/tmp/dsh-client-bundles-build.log 2>&1 \
  || {
    echo "ensure-client-bundles: build failed — build log follows:" >&2
    tail -40 /tmp/dsh-client-bundles-build.log >&2 || true
    exit 1
  }

verifies "$COMPUTED" \
  || { echo "ensure-client-bundles: rebuilt tree fails this environment's own record" >&2; exit 1; }
echo "ensure-client-bundles: bundles built and verified against this environment's own build record"
compare
