#!/bin/sh
# run-presentation-tests.sh — the CI gates workflow's presentation step
# (.github/workflows/gov.yml): the two Node-testable presentation suites,
# sequentially, first failure fails the job naming the package:
#   1. presentation/lynx-client        (driver loop, wire envelope, mux — 71 tests)
#   2. test/web-client-next-suite      (envelope, mux over real sockets, journal fold — 45 tests)
#
# The web-client-next suite lives OUTSIDE the product directory on purpose
# (presentation/web-client-next is whole-tree staged into the harmony HAP
# rawfile — vendor-official.sh webclient_files; see the Agent Note
# 2026-09-30-driver-presentation-node-faces-carry-real-coverage.md). This
# runner re-asserts that invariant on every run: the product tree must hold
# exactly its shipped files before AND after each suite.
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

PRODUCT_FILES=14
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
    count=$(find "$ROOT/presentation/web-client-next" -type f | wc -l | tr -d ' ')
    if [ "$count" -ne "$PRODUCT_FILES" ]; then
        echo "presentation-tests: FAIL — presentation/web-client-next holds $count files, expected exactly $PRODUCT_FILES; test tooling artifacts leaked into the whole-tree-staged HAP directory" >&2
        exit 1
    fi
}

assert_product_tree
run_suite "presentation/lynx-client" "lynx-client (driver loop / wire envelope / mux)"
assert_product_tree
run_suite "test/web-client-next-suite" "web-client-next suite (envelope / mux / journal fold)"
assert_product_tree
echo "presentation-tests: PASS (lynx-client + web-client-next suites green; product tree intact)"
