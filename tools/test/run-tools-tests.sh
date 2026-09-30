#!/bin/sh
# run-tools-tests.sh — the CI gates workflow's tools-face step
# (.github/workflows/gov.yml): the repo's own gate-tool net (test/tools
# vitest face) — the staging verifier/generator pair's hermetic fixture
# tests, the code-size gate tests, and the publisher-token validator's
# counterexample net (tools/publisher-token.test.mjs, PR #285 review:
# the suite was manually-runnable only, so a future validator regression
# turned nothing red).
#
# Placement contract: this step runs AFTER `gov run` in the gates job, by
# which point the workflow has materialized the vendored closure
# (runtime/spike/vendor/ensure.sh + ensure-dsh.sh) and staged the harmony
# rawfile (vendor-official.sh --closure-only) — the gen-staging-manifests
# real-repo leg's documented precondition. Local runs need the same
# materialization (`sh runtime/spike/vendor/ensure-dsh.sh` and
# `sh build/build.sh sync harmony`) or that one leg fails loud.
#
# Dependencies: the suite installs its own devDependencies when absent.
# The face carries a COMMITTED lockfile (test/tools/package-lock.json):
# npm ci is the deterministic path; registry honors npm_config_registry.
# usage: sh tools/test/run-tools-tests.sh   exit 0 = the face is green
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT/test/tools"
if [ ! -d node_modules ]; then
    echo "tools-tests: installing devDependencies (first run on this tree)"
    npm ci --no-audit --no-fund
fi
npm test
echo "tools-tests: PASS (the gate-tool net, publisher-token counterexamples included)"
