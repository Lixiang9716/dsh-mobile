#!/bin/sh
# build/check-closures.sh — the closures gate: every committed host copy of
# the canonical runtime/spike closure is byte-identical to its source, or a
# named file fails the gate.
#
# Why this is a gate and not a convention (rule 1, gates over prose): each
# host embeds a COPY of the canonical closure (Android assets/, HarmonyOS
# rawfile/, the iOS generated C arrays) because the platform build systems
# consume committed bytes; the copies are made by the per-host stagers, and
# drift in them is SILENT — CI re-stages before building, so a stale
# committed copy builds green while lying to every reader of the tree (the
# m5 surprise ledger, measured again on 2026-09-23: five harmony rawfile
# files and two three-way files sat drifted on main with dev/harmonyos
# green). This check makes the committed state itself a claim that can fail.
#
# Per host:
#   android  hosts/android/ci/stage-spine-closure.sh --check
#   harmony  hosts/harmony/ci/vendor-official.sh --check
#   ios      regenerate the bundle header (deterministic — no timestamps)
#            into the tree and demand `git diff --quiet` on it; restore.
#
# The iOS leg WRITES then restores: the generator's output IS the committed
# copy, so byte-verifying means regenerating. Deterministic bytes in, exact
# restore out — the tree is untouched on both pass and fail.
#
# usage: build/check-closures.sh   exit 0 = every closure fresh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

FAIL=0

echo "closures: android (assets vs runtime/spike pins)"
hosts/android/ci/stage-spine-closure.sh --check || FAIL=1

echo ""
echo "closures: harmony (rawfile vs runtime/spike pins)"
hosts/harmony/ci/vendor-official.sh --check || FAIL=1

echo ""
echo "closures: ios (regenerate the bundle header, expect no diff)"
IOS_GEN="hosts/ios/App/Generated"
if command -v python3 >/dev/null 2>&1 && [ -d "$IOS_GEN" ]; then
    BEFORE=$(git status --porcelain -- "$IOS_GEN" hosts/ios/DSHSpike.xcodeproj)
    python3 hosts/ios/Tools/gen_bundle_header.py >/dev/null 2>&1 || {
        echo "::error::closures: gen_bundle_header.py failed on a clean tree" >&2
        FAIL=1
    }
    if git diff --quiet -- "$IOS_GEN"; then
        echo "closures: ios bundle header fresh (regenerated, no diff)"
    else
        echo "::error::closures: ios generated bundle drifted from runtime/spike — re-run hosts/ios/gen.sh and commit the regenerated bundle" >&2
        git diff --stat -- "$IOS_GEN" >&2 || true
        git diff -- "$IOS_GEN" | sed -n '1,80p' >&2
        git checkout -- "$IOS_GEN" 2>/dev/null || true
        FAIL=1
    fi
    # Leave the tree exactly as found, including any pre-existing dirt.
    [ -z "$BEFORE" ] || { echo "closures: note — $IOS_GEN was already dirty before the check; state restored" >&2; }
else
    echo "closures: SKIP ios (python3 or the generated tree absent — checked in CI where dev/ios builds)" >&2
fi

echo ""
if [ "$FAIL" = "0" ]; then
    echo "closures: all committed copies byte-identical to the canonical closure"
else
    echo "::error::closures: drift found — re-stage with build/build.sh sync <platform>" >&2
    exit 1
fi
