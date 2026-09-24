#!/bin/bash
# runtime/spike/ci/run-upstream-suite-sweep.sh — the FULL upstream dsh-tests
# sweep, both legs: every transpiled spec runs under the QuickJS CLI
# (scenario upstream.suite) AND under plain Node (the differential
# reference). Output: a TSV report + totals under tmp/ (gitignored — this is
# a diagnostic, NOT committed evidence: the matrix's receipts only come from
# green runner runs, and the sweep deliberately reports failures it cannot
# own, e.g. the desktop-bundler-chunk and native-seam spec families).
#
# The transpiled specs come from test/upstream-suite/transpile.mjs over the
# vendored dsh-tests tree (ensure-dsh-tests.sh); see the upstream-suite note
# (2026-09-25, bug-fix class) for the sweep's first full run and what it
# bought.
#
# usage: runtime/spike/ci/run-upstream-suite-sweep.sh [--paral N]
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SPIKE="$ROOT/runtime/spike"
REPORT="$ROOT/tmp/upstream-suite-report.tsv"
TOTALS="$ROOT/tmp/upstream-suite-report-totals.txt"
LOGDIR="$ROOT/tmp/upstream-suite-logs"
FRAGS="$LOGDIR/fragments"
PARAL=4
while [ $# -gt 0 ]; do
    case "$1" in
        --paral) PARAL="$2"; shift 2 ;;
        *) echo "usage: $0 [--paral N]" >&2; exit 2 ;;
    esac
done
mkdir -p "$LOGDIR" "$FRAGS"

# macOS has no timeout(1): run_to <seconds> <cmd...> via perl alarm.
run_to() { perl -e 'alarm shift; exec @ARGV' "$@"; }

worker() {
    spec="$1"
    name="$(basename "$spec")"
    stem="${name%.spec.mjs}"
    qjs_log="$LOGDIR/$stem.qjs.log"
    node_log="$LOGDIR/$stem.node.log"
    frag="$FRAGS/$stem.tsv"

    qjs_summary="$(cd "$SPIKE" && run_to 90 ./build/dsh-spike-cli . \
        scenario/upstream-suite-leg.js \
        --env "DSH_UPSTREAM_SPEC=upstream-tests/$name" > "$qjs_log" 2>&1 \
        && grep -o '"event":"suite/summary".*' "$qjs_log" | tail -1)"
    [ -z "${qjs_summary:-}" ] && qjs_summary='TIMEOUT-OR-ERROR'

    node_summary="$(run_to 90 node "$ROOT/test/upstream-suite/smoke.mjs" "$name" \
        > "$node_log" 2>&1 \
        && grep -o 'harness smoke: {.*}' "$node_log" | head -1)"
    [ -z "${node_summary:-}" ] && node_summary='TIMEOUT-OR-ERROR'

    qjs_failed="$(printf '%s' "$qjs_summary" | sed -n 's/.*"failed":\([0-9]*\).*/\1/p')"
    node_failed="$(printf '%s' "$node_summary" | sed -n 's/.*"failed":\([0-9]*\).*/\1/p')"
    agree='—'
    [ -n "$qjs_failed" ] && [ "$qjs_failed" = "$node_failed" ] && agree='yes'
    [ -n "$qjs_failed" ] && [ -n "$node_failed" ] && [ "$qjs_failed" != "$node_failed" ] && agree='NO'

    printf '%s\t%s\t%s\t%s\n' "$stem" "$qjs_summary" "$node_summary" "$agree" > "$frag"
}
export -f worker run_to
export ROOT SPIKE LOGDIR FRAGS

# The specs must exist: vendor the pinned dsh-tests tree + transpile when
# the tree is empty (the same materialization run-ios-upstream-suite.sh does).
[ -f "$SPIKE/upstream-tests/core__agent-loop__tests__loop.spec.mjs" ] || {
    sh "$SPIKE/vendor/ensure-dsh-tests.sh"
    (cd "$ROOT/test/upstream-suite" && npm install --no-audit --no-fund >/dev/null 2>&1 \
        && node transpile.mjs >/dev/null)
}

ls "$SPIKE/upstream-tests/"*.spec.mjs | sort | \
    xargs -P "$PARAL" -I{} bash -c 'worker "$@"' _ {}

{
    printf 'spec\tqjs\tnode\tagree\n'
    cat "$FRAGS"/*.tsv | sort
} > "$REPORT"

qjs_pass=$(tail -n +2 "$REPORT" | grep -c '"failed":0' || true)
disagree=$(tail -n +2 "$REPORT" | awk -F'\t' '$4=="NO"' | wc -l | tr -d ' ')
total=$(tail -n +2 "$REPORT" | wc -l | tr -d ' ')
{
    echo "specs: $total"
    echo "qjs specs with a green summary: $qjs_pass (see the note for the"
    echo "  three-way classification: green / partial / module-gap —"
    echo "  module-gap rows carry no summary by construction)"
    echo "failed-count disagreements (qjs vs node): $disagree"
    echo "report: $REPORT"
} > "$TOTALS"
echo "sweep: DONE — $TOTALS"
cat "$TOTALS"
