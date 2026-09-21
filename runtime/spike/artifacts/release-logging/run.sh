#!/bin/sh
# run.sh — reproduce the release-logging evidence on the desktop CLI.
#
# Builds BOTH CLI variants (host/build.sh + host/build.sh --release, the same
# two logging regimes the platform Release configurations produce) and runs
# the same three probes against each. The assertions are the point: a release
# capture must contain ZERO "level":"debug" / "level":"info" records, the
# warn/error records must still be there (fail loud — rules.md rule 5), and
# the strip must hold on EVERY route that writes to the sink — not only on the
# canonical createLogger, whose silence the shims could otherwise mask.
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
# The sink probe runs from the bundle ROOT (base `.`), so its three routes are
# the canonical logger.js / upstream/web-shims.js / upstream/boot.js on disk —
# nothing staged beside it can drift. A failing assertion exits the CLI
# non-zero; that is turned into a loud message carrying the probe's own verdict
# record (which names the route and level that leaked) rather than letting
# `set -e` kill the run silently.
sink_probe() { # $1 = CLI binary, $2 = capture file
    if ! "./build/$1" . artifacts/release-logging/probe/sink-probe.js > "$ART/$2" 2>/dev/null; then
        echo "FAIL: the sink probe failed in $2 — the routes are not all stripped:" >&2
        grep 'probe.sink.verdict' "$ART/$2" >&2 || echo "  (no verdict record — the probe died before it)" >&2
        exit 1
    fi
}
sink_probe dsh-spike-cli sink.debug.txt
sink_probe dsh-spike-cli-release sink.release.txt
rm -f "$ART/probe/logger.js"

count() { grep -c "\"level\":\"$2\"" "$1" 2>/dev/null || true; }
# Records of ONE level on ONE route, by module — the per-route half of the
# evidence. Substring-matched WITH the surrounding quotes, so "probe.sink"
# never counts the verdict's "probe.sink.verdict" (nor "debug" a "debugging").
routed_count() { # $1 = file, $2 = module, $3 = level
    awk -v m="\"module\":\"$2\"" -v l="\"level\":\"$3\"" \
        'index($0, m) && index($0, l) { n++ } END { print n + 0 }' "$1"
}
# One route's four-level contract: the counts a build must produce. The
# debug/release difference is the whole point, so both are asserted by name.
assert_route() { # $1 = file, $2 = module, $3..$6 = debug/info/warn/error
    file=$1; module=$2
    for pair in "debug $3" "info $4" "warn $5" "error $6"; do
        level=${pair%% *}; want=${pair##* }
        got=$(routed_count "$file" "$module" "$level")
        [ "$got" -eq "$want" ] || {
            echo "FAIL: $(basename "$file") route $module level $level: want $want, got $got" >&2
            exit 1
        }
    done
}

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

# Every route that writes to the sink, in BOTH regimes. The console route's
# info count is 2 in debug because console.log and console.info both map to
# level info — a release build drops both.
assert_route "$ART/sink.debug.txt" probe.sink 1 1 1 1 || exit 1
assert_route "$ART/sink.debug.txt" upstream.console 1 2 1 1 || exit 1
assert_route "$ART/sink.debug.txt" cordis:probe.boot 1 1 1 1 || exit 1
assert_route "$ART/sink.release.txt" probe.sink 0 0 1 1 || exit 1
assert_route "$ART/sink.release.txt" upstream.console 0 0 1 1 || exit 1
assert_route "$ART/sink.release.txt" cordis:probe.boot 0 0 1 1 || exit 1
for f in sink.debug.txt sink.release.txt; do
    grep -q 'every sink route agrees with the release policy' "$ART/$f" ||
        { echo "FAIL: $f carries no sink-probe verdict — the probe did not run to its end" >&2; exit 1; }
done

echo "release-logging evidence: debug=$(wc -l < "$ART/m2-bridge-smoke.debug.txt" | tr -d ' ') records,"
echo "  release=$(wc -l < "$ART/m2-bridge-smoke.release.txt" | tr -d ' ') records;"
echo "  levels debug=$(wc -l < "$ART/levels.debug.txt" | tr -d ' ') → release=$(wc -l < "$ART/levels.release.txt" | tr -d ' ') (warn+error only)"
echo "  sink routes debug=$(wc -l < "$ART/sink.debug.txt" | tr -d ' ') → release=$(wc -l < "$ART/sink.release.txt" | tr -d ' ') (3 routes × warn+error)"
