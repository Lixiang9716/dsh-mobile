#!/bin/sh
# runtime/dsh/ci/check-quickjs-boot-parse.sh — the `quickjs-boot-parse` gate.
#
# WHY: node --check passing is not "QuickJS can parse". The 2026-09-29 shim
# splits (fs.js -> fs-seeded.js, buffer.js -> buffer-codecs.js) landed
# node-clean and QuickJS-fatal — a class of error only the real engine
# exposes. This gate compiles the break surface on purpose: a throwaway
# scenario importing the two split roots, booted under the vendored
# quickjs-ng through the desktop CLI, requiring exit 0 — so the next
# node-clean/QuickJS-fatal edit goes red here, at the gate, instead of red
# in a scenario nobody ran. The stub is deleted on every exit path; closure
# stagers enumerate scenarios from explicit pin lists, so the transient file
# cannot trip closures/bundle-files.
#
# ARCH GUARD: the CLI's link embeds the iSH static libs — AArch64 assembly
# an x86_64 assembler cannot build. Non-arm64 machines skip here; the
# gov.yml arm64 job (ubuntu-24.04-arm) + arm64 dev machines carry the proof.
if [ "$(uname -m)" != "arm64" ]; then
    echo "quickjs-boot-parse: SKIP — $(uname -m) cannot assemble the iSH AArch64 objects; the gov.yml arm64 job proves the boot graph"
    exit 0
fi

# Budget: sub-second with the prebuilt CLI (measured 0.04s); on a miss the
# CLI is built first (host/build.sh — the same rule run-*-e2e.sh uses; a cold
# CI build is the one path that can exceed the steady-state budget).
#
# usage: check-quickjs-boot-parse.sh   (cwd-independent; exit 0 = boot graph compiles)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

# 1. The engine exists — build on miss (rule 5: a missing engine is a loud
#    build, never a silent skip).
if [ ! -x build/dsh-cli ]; then
    # host/build.sh links the iSH static libs, whose vendor tree is
    # materialized by ensure-ish.sh — NOT by ensure.sh/ensure-dsh.sh (the
    # gov.yml materialize step), so a cold CI runner needs it here first
    # (the 2026-09-29 CI run: 'vendored iSH-arm64 sources not found').
    if [ ! -d vendor/ish ] || [ -z "$(find vendor/ish -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]; then
        echo "quickjs-boot-parse: ish vendor tree absent — materializing (vendor/ensure-ish.sh)"
        sh vendor/ensure-ish.sh
    fi
    echo "quickjs-boot-parse: build/dsh-cli missing — building (host/build.sh)"
    sh host/build.sh
fi

# 2. The stub scenario: imports the two split roots under the real loader.
#    Logging goes through the unified logger (rule L3) so the gate's log
#    stream stays shaped; the imports are the point — they pull fs ->
#    fs-seeded -> buffer -> buffer-codecs and the bridges, exactly the
#    surface a shim split touches.
STUB="scenario/ci-quickjs-parse-probe.js"
cleanup() { rm -f "$STUB"; }
trap cleanup EXIT INT TERM
cat > "$STUB" <<'STUB_EOF'
// Throwaway stub of the quickjs-boot-parse gate — created and deleted by
// runtime/dsh/ci/check-quickjs-boot-parse.sh, never committed.
import { createLogger } from '../logger.js';
import * as fs from 'upstream/shims/fs.js';
import { DshBuffer } from 'upstream/shims/buffer.js';

const log = createLogger('ci.quickjs-parse-probe');
log.debug('quickjs parse probe: boot graph resolved', {
  fs: typeof fs,
  DshBuffer: typeof DshBuffer,
});
globalThis.__dshComplete(true, 'quickjs parse probe: boot graph compiled');
STUB_EOF

# 3. Boot it: exit 0 only when the whole graph compiles AND evaluates under
#    the vendored engine.
./build/dsh-cli . "$STUB"
