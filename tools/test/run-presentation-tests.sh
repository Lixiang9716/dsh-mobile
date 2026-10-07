#!/bin/sh
# run-presentation-tests.sh — the CI gates workflow's presentation step
# (.github/workflows/gov.yml): the two Node-testable presentation suites,
# sequentially, first failure fails the job naming the package:
#   1. presentation/lynx-client        (driver loop, wire envelope, mux — 71 tests)
#   2. test/web-client-v2-suite      (envelope, mux over real sockets, journal fold — 45 tests)
#
# The web-client-v2 suite lives OUTSIDE the product directory on purpose
# (presentation/web-client-v2 is whole-tree staged into the harmony HAP
# rawfile — vendor-official.sh webclient_files; see the Agent Note
# 2026-09-30-driver-presentation-node-faces-carry-real-coverage.md). The
# tree-count invariant is a REAL gate now (`webclient-staged-tree` in
# gates.json → tools/check-webclient-staged-tree.sh — it used to live only
# here, a CI-workflow step, which is how #288 passed a local `gov run`
# green while CI went red); this runner re-asserts it before AND after each
# suite by calling the same script, so the count has one home.
#
# Dependencies: each suite installs its own devDependencies when absent.
# Both suites carry COMMITTED lockfiles (gitignore-exempt like
# test/upstream-suite's): npm ci is the deterministic path — the
# lockfile-less npm install hit arborist's `edgesOut` null bug on the CI
# runner (observed live, run 36717057763). Registry honors
# npm_config_registry.
# usage: sh tools/test/run-presentation-tests.sh   exit 0 = both suites green
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# The shipped-set count lives in tools/check-webclient-staged-tree.sh (the
# gate's own home) — the runner does not carry a second copy.
run_suite() {
    suite_dir="$1"
    name="$2"
    echo "presentation-tests: $name"
    cd "$ROOT/$suite_dir"
    if [ ! -d node_modules ]; then
        echo "presentation-tests: $name — installing devDependencies (first run on this tree)"
        npm ci --no-audit --no-fund
    fi
    npm test
}
assert_product_tree() {
    sh "$ROOT/tools/check-webclient-staged-tree.sh"
}

assert_product_tree
run_suite "presentation/lynx-client" "lynx-client (driver loop / wire envelope / mux)"
assert_product_tree
run_suite "test/web-client-v2-suite" "web-client-v2 suite (envelope / mux / journal fold)"
assert_product_tree
echo "presentation-tests: PASS (lynx-client + web-client-v2 suites green; product tree intact)"
