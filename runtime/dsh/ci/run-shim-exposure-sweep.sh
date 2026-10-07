#!/bin/bash
# runtime/dsh/ci/run-shim-exposure-sweep.sh — the shim exposure survey's
# evidence run: every transpiled upstream spec under the QuickJS CLI with
# DSH_MODULE_MANIFEST pointed at a per-spec manifest file. The QJS leg ONLY —
# the exposure survey needs what the loader resolved, not the node
# differential verdicts (run-upstream-suite-sweep.sh owns that heavier shape).
#
# Also produces the HARNESS BASELINE: one leg run with a nonexistent spec —
# the harness boots, the import fails, and the manifest names exactly the
# shims every spec leg pays for before any spec body runs
# (__baseline__.txt; tools/shim-exposure.mjs treats __* as auxiliary).
#
# NO retry leg (unlike the verdict sweep): a spec that times out at the cap
# still contributes the loads it got up to the timeout, and the survey
# reports per-spec manifests so a partial run is inspectable, not silent.
#
# usage: runtime/dsh/ci/run-shim-exposure-sweep.sh [--paral N] [--out DIR]
# output: $OUT/<stem>.txt per spec + $OUT/__baseline__.txt; aggregate with
#   node tools/shim-exposure.mjs <OUT> --baseline <OUT>/__baseline__.txt
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SPIKE="$ROOT/runtime/dsh"
OUT="$ROOT/tmp/shim-manifests"
LOGDIR="$ROOT/tmp/shim-sweep-logs"
PARAL=4
while [ $# -gt 0 ]; do
    case "$1" in
        --paral) PARAL="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        *) echo "usage: $0 [--paral N] [--out DIR]" >&2; exit 2 ;;
    esac
done
mkdir -p "$OUT" "$LOGDIR"

# macOS has no timeout(1): run_to <seconds> <cmd...> via perl alarm.
run_to() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# The harness baseline FIRST (cheap): a spec name that cannot load — the
# boot-staging faces all run, the import fails, __dshComplete(false) fires.
: > "$OUT/__baseline__.txt"
DSH_MODULE_MANIFEST="$OUT/__baseline__.txt" \
    "$SPIKE/build/dsh-cli" "$SPIKE" scenario/upstream-suite-leg.js \
    --env "DSH_UPSTREAM_SPEC=upstream-tests/definitely-missing.spec.mjs" \
    > "$LOGDIR/__baseline__.log" 2>&1

worker() {
    spec="$1"
    name="$(basename "$spec")"
    stem="${name%.spec.mjs}"
    manifest="$OUT/$stem.txt"
    DSH_MODULE_MANIFEST="$manifest" \
        run_to 90 "$SPIKE/build/dsh-cli" "$SPIKE" scenario/upstream-suite-leg.js \
        --env "DSH_UPSTREAM_SPEC=upstream-tests/$name" \
        > "$LOGDIR/$stem.log" 2>&1
}
export -f worker run_to
export OUT LOGDIR SPIKE

find "$SPIKE/upstream-tests" -maxdepth 1 -name '*.spec.mjs' -print0 | sort -z | \
    xargs -0 -P "$PARAL" -I{} bash -c 'worker "$@"' _ {}

echo "sweep: $(find "$OUT" -maxdepth 1 -name '*.txt' 2>/dev/null | wc -l | tr -d ' ') manifests under $OUT"
