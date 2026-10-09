#!/bin/sh
# runtime/dsh/ci/run-session-preset-join-node.sh — the T-0209 empirical leg
# (scenario `session.preset-join`), the NODE face: boots the REAL mobile
# spine under plain node (the vendored closure resolved through the parity
# node_modules layout — no dsh-cli build), composes the REAL write surface,
# drives the page's own wire (session/create → session/prompt) against a
# loopback capture server, and asserts on the request the model actually
# receives: the presetJoin seat's session agent composes 'mobile' (the
# mobile persona section in the wired system prompt + the preset-only tool
# rows), the flagless seat stays on the empty global layer, and the join's
# per-session debug line (T-0209's observability half) lands in the unified
# sink. The driver's exit code IS the verdict; its stdout carries one
# P5_OK/P5_FAIL line per assertion plus the final P5_VERDICT document.
#
# Why node and not the CLI: the proof must run on every dev box the vendored
# closure materializes on (the CLI host links the iSH userland — macOS/Linux
# only), and the vendored packages themselves are node-first code (the
# upstream-suite vitest face runs them verbatim). The substitutions the
# driver makes (real-fetch httpFetch, the /vendor/ path adapter) are exactly
# the parity reference leg's own Node-side seams, narrowed to this boot.
#
# usage: run-session-preset-join-node.sh
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

# 1. vendored upstream closure: pinned + sha256-verified, then the node
#    resolution layout (vendor/node_modules under the packages' real npm
#    names — the same layout the parity reference leg and the raw
#    upstream-suite vitest face resolve through). The layout is fully
#    script-owned (its own header: a vendor re-fetch wipes it), so one
#    clean rebuild recovers a stale tree (e.g. an MSYS `ln` that copied
#    instead of linked and left the packages nested one level down).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh
if ! sh ci/parity-node-modules.sh >/dev/null 2>&1; then
    echo "session-preset-join: the node_modules layout failed to link — rebuilding it clean" >&2
    # The WHOLE layout is the script's own output (its header: a vendor
    # re-fetch wipes it) — every node_modules dir under vendor/, top-level
    # and per-consumer seats alike. A stale tree can carry copied dirs
    # where the links go (an MSYS `ln` that copied instead of linked), and
    # only a clean rebuild recovers it.
    find "$ROOT/runtime/dsh/vendor" -type d -name node_modules -exec rm -rf {} + 2>/dev/null || true
    sh ci/parity-node-modules.sh
fi

# 2. the driver IS the check (one assertion per P5_OK line, exit code the
#    gate — a gate that cannot fail is vacuous, and the driver's C leg
#    fails exactly when the join observability line is missing).
node "$ROOT/test/upstream-suite/session-preset-join.mjs"
