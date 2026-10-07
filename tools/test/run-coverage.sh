#!/usr/bin/env sh
# tools/test/run-coverage.sh — real line coverage over the Node-testable
# surface, one command. usage: run-coverage.sh [--check]
#
# WHY: this repo's real behavior-coverage net is the upstream spec suite
# (681 specs against the QuickJS runtime + shims) plus the e2e evidence
# matrix — neither of which is line coverage, and neither of which can see
# Node-side presentation/driver logic. This script is the line-coverage leg
# for exactly the surfaces where vitest runs on Node and the code is ours:
# it runs each registered surface's vitest suite with the v8 provider and
# aggregates one table (surface / lines% / branches%) from the
# json-summary reports.
#
# POSIX sh on purpose: the gate argv invokes this through `sh` (gates.json),
# and govrail execs that argv without a shell — CI's /bin/sh is dash, where
# `set -o pipefail` and arrays are syntax errors. Every sh-invoked gate
# script in this repo is dash-safe; this one obeys the same constraint.
#
# Honest boundaries — surfaces deliberately NOT registered here, by name:
#   - test/upstream-suite  its vitest config runs the UPSTREAM harness's own
#     specs against the vendored closure (the same spec families the CLI
#     suite runs through the QuickJS-shaped harness). Coverage there would
#     measure pinned upstream code under Node semantics — not our line
#     coverage, and a different thing from the CLI suite's behavior proof.
#   - presentation/web-client*  plain browser JS: `import` of main.js fails
#     on Node (`document is not defined`), no test runner, no tests.
#   - runtime/dsh (QuickJS runtime + shims)  no Node-side line coverage
#     pretend: the shipped semantics are QuickJS's; the behavior net owns
#     them.
#
# --check: after running the suites, enforce the floors in
# tools/test/coverage-floors.json (exit 1 below floor). This is the exact
# argv of the `coverage-floor` gate in gates.json (warn-tier: the gate
# carries allowFailure, so a red floor is recorded without blocking).
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

# The registered surfaces: a surface is a directory holding a vitest config
# whose `coverage.include` names that surface's Node-testable product code.
# Reports land at <surface>/coverage/coverage-summary.json (json-summary
# reporter), which tools/check-coverage-floor.mjs reads. A plain,
# whitespace-separated list — dash-safe where arrays are not.
SURFACES="presentation/lynx-client"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
if [ "${1:-}" != "" ] && [ "$CHECK" -eq 0 ]; then
  echo "run-coverage: unknown argument: $1 (usage: run-coverage.sh [--check])" >&2
  exit 2
fi

for surface in $SURFACES; do
  if [ ! -x "$surface/node_modules/.bin/vitest" ]; then
    echo "run-coverage: installing dev deps for $surface"
    # cd-form on purpose: `npm --prefix <dir> install` with no lockfile
    # crashes on some npm majors ("Cannot read properties of null
    # (reading 'edgesOut')" — seen on the ubuntu runner, CI run
    # 36693625526); installing from inside the surface is the stable shape.
    # --legacy-peer-deps works around the npm 10 arborist #loadPeerSet
    # crash on vitest's peer set (same edgesOut error — reproduced locally
    # with npm@10.8.2 on a fresh copy; npm 11 unaffected, flag harmless).
    (cd "$surface" && npm install --no-audit --no-fund --legacy-peer-deps)
  fi
  echo "run-coverage: measuring $surface"
  (cd "$surface" && ./node_modules/.bin/vitest run --coverage)
done

if [ "$CHECK" -eq 1 ]; then
  node tools/check-coverage-floor.mjs --enforce
else
  node tools/check-coverage-floor.mjs
fi
