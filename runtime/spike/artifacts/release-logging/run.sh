#!/bin/sh
# run.sh — reproduce the release-logging evidence on the desktop CLI.
#
# Builds BOTH CLI variants (host/build.sh + host/build.sh --release, the same
# two logging regimes the platform Release configurations produce) and runs
# the same two probes against each. The assertions are the point: a release
# capture must contain ZERO "level":"debug" / "level":"info" records, and the
# warn/error records must still be there (fail loud — rules.md rule 5).
#
# usage: runtime/spike/artifacts/release-logging/run.sh   (from the repo root)
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
ART="$ROOT/runtime/spike/artifacts/release-logging"
SPIKE="$ROOT/runtime/spike"
cd "$SPIKE"

sh host/build.sh >/dev/null
sh host/build.sh --release >/dev/null

# The probe bundle: the canonical logger copied beside the probe entry (never
# a second committed copy of logger.js — it would drift).
rm -rf "$ART/probe/logger.js"
cp "$SPIKE/logger.js" "$ART/probe/logger.js"

./build/dsh-spike-cli . scenario/m2-bridge-smoke.js > "$ART/m2-bridge-smoke.debug.txt" 2>/dev/null
./build/dsh-spike-cli-release . scenario/m2-bridge-smoke.js > "$ART/m2-bridge-smoke.release.txt" 2>/dev/null
./build/dsh-spike-cli "$ART/probe" probe.js > "$ART/levels.debug.txt" 2>/dev/null
./build/dsh-spike-cli-release "$ART/probe" probe.js > "$ART/levels.release.txt" 2>/dev/null
rm -f "$ART/probe/logger.js"

count() { grep -c "\"level\":\"$2\"" "$1" 2>/dev/null || true; }

for f in m2-bridge-smoke.debug.txt levels.debug.txt; do
    [ "$(count "$ART/$f" debug)" -gt 0 ] ||
        { echo "FAIL: $f has no debug record — the harness lost its stream" >&2; exit 1; }
done
for f in m2-bridge-smoke.release.txt levels.release.txt; do
    [ "$(count "$ART/$f" debug)" -eq 0 ] ||
        { echo "FAIL: $f carries \"level\":\"debug\" in a release build" >&2; exit 1; }
    [ "$(count "$ART/$f" info)" -eq 0 ] ||
        { echo "FAIL: $f carries \"level\":\"info\" in a release build" >&2; exit 1; }
done
[ "$(count "$ART/levels.release.txt" warn)" -eq 1 ] && [ "$(count "$ART/levels.release.txt" error)" -eq 1 ] ||
    { echo "FAIL: the release critical set dropped warn/error" >&2; exit 1; }

echo "release-logging evidence: debug=$(wc -l < "$ART/m2-bridge-smoke.debug.txt" | tr -d ' ') records,"
echo "  release=$(wc -l < "$ART/m2-bridge-smoke.release.txt" | tr -d ' ') records;"
echo "  levels debug=$(wc -l < "$ART/levels.debug.txt" | tr -d ' ') → release=$(wc -l < "$ART/levels.release.txt" | tr -d ' ') (warn+error only)"
