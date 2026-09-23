#!/bin/sh
# stage-spine-closure.sh — the Android analogue of the iOS embedder's tree
# mode (W-SESS #62): copies the D9 W-SESS spine closure from the runtime
# spike bundle into the app assets, so the C host's loader bare map
# (`vendor/dsh/<pkg>@<ver>/lib/**`, `vendor/npm/...`) resolves the FULL
# upstream agent spine on-device. Idempotent; byte-identical to the
# runtime/spike pins (ensure-dsh.sh is the single source of the pin).
#
# Staged per the iOS embedder's lists (hosts/ios/Tools/gen_bundle_header.py):
#   - the 14 vendored spine packages: LICENSE + package.json + lib/**
#     (only docs/bin/.d.ts pruning differs — the same lean rule the
#     web-boot closure already follows in assets)
#   - the pinned zod's runtime closure (classic build's relative import
#     graph walked at the pin): index.js + v4/classic + v4/core + v4/locales
#   - the spine boot layer: upstream/boot.js, upstream/llm-transport.js,
#     upstream/settings-memory.js, and the shims beyond the web-boot set
#     (async-hooks, util, util/types, os, process, dsh-session-persistence)
#
# The staged trees are COMMITTED (the Android embed is assets, not C arrays);
# this script exists to make re-pins reproducible, and verifies byte-identity
# after copying (fail loud, rules.md rule 5).
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SPIKE=$ROOT/runtime/spike
ASSETS=$ROOT/hosts/android/app/src/main/assets/spike
VER=0.1.6-alpha.2

say() { echo "stage-spine-closure: $*"; }
die() { echo "::error::stage-spine-closure: $*" >&2; exit 1; }

# --check: NO writes — run only the byte-identity proof against the committed
# assets (the closures gate; a gate that heals what it checks is vacuous).
MODE=stage
[ "${1:-}" = "--check" ] && MODE=check
[ $# -eq 0 ] || [ "$MODE" = "check" ] || die "unknown argument '$1' (only --check)"

[ -d "$SPIKE/vendor/dsh/session@$VER/lib" ] ||
    die "runtime vendor closure missing — run runtime/spike/vendor/ensure-dsh.sh"

# Verify-phase variables, defined before the staging guard so --check mode
# (staging skipped) still has them.
ZOD_SRC=$SPIKE/vendor/npm/zod@4.4.3
ZOD_DST=$ASSETS/vendor/npm/zod@4.4.3

if [ "$MODE" != "check" ]; then

# One vendored spine package: LICENSE + package.json + lib/** minus .d.ts,
# plus presets/** when the package carries it (agent-presets — the seeded
# tree the presets service walks; without it the 预设 roster is empty).
stage_pkg() {
    src=$1
    dst=$2
    mkdir -p "$dst"
    for f in LICENSE package.json; do
        [ -f "$src/$f" ] && cp "$src/$f" "$dst/$f"
    done
    (cd "$src" && find lib -type f ! -name '*.d.ts') | while IFS= read -r rel; do
        mkdir -p "$dst/$(dirname "$rel")"
        cp "$src/$rel" "$dst/$rel"
    done
    if [ -d "$src/presets" ]; then
        (cd "$src" && find presets -type f) | while IFS= read -r rel; do
            mkdir -p "$dst/$(dirname "$rel")"
            cp "$src/$rel" "$dst/$rel"
        done
    fi
}

# The iOS embedder's TREES list: the verbatim spine packages (D9), the
# Agent 预设 closure (2026-09-22 settings-surfaces leg), and the FILE-TOOLS
# row (vendored fs-local backend + upstream file tools), plus the SKILL row
# (the agent-flow E2E's vendored skill family).
for pkg in agent agent-loop brand llm sandbox scope session \
           session-projection settings system-prompt timeout tools \
           typert-protocol util-values agent-presets atomic-write \
           home-paths fs attachment fs-local tool-fs \
           tool-str-replace-editor tool-todo \
           skill skill-filesystem tool-skill; do
    say "staging vendor/dsh/$pkg@$VER"
    stage_pkg "$SPIKE/vendor/dsh/$pkg@$VER" "$ASSETS/vendor/dsh/$pkg@$VER"
done

# The npm `diff` bridge target (upstream/shims/npm-bridges.js re-exports its
# libesm/index.js behind the bare specifier vendored tool-fs imports).
# The Agent presets closure's npm faces (boot.js imports them statically:
# the cordis Loader service + the include walker + js-yaml's ESM dist).
say "staging presets-closure npm packages"
mkdir -p "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib"
cp "$SPIKE/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js" \
   "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js"
mkdir -p "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib"
cp "$SPIKE/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js" \
   "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js"
mkdir -p "$ASSETS/vendor/npm/js-yaml@4.1.0/dist"
cp "$SPIKE/vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs" \
   "$ASSETS/vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs"

say "staging vendor/npm/diff@9.0.0 (libesm)"
mkdir -p "$ASSETS/vendor/npm/diff@9.0.0/libesm"
(cd "$SPIKE/vendor/npm/diff@9.0.0/libesm" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/diff@9.0.0/libesm/$(dirname "$rel")"
        cp "$SPIKE/vendor/npm/diff@9.0.0/libesm/$rel" "$ASSETS/vendor/npm/diff@9.0.0/libesm/$rel"
    done

# The SKILL row's npm face: upstream/shims/npm-bridges.js re-exports the
# yaml browser/ ESM tree behind the bare specifier skill-filesystem imports
# (the package's "node" face is CJS, which the loader cannot serve).
say "staging vendor/npm/yaml@2.9.0 (browser ESM face)"
(cd "$SPIKE/vendor/npm/yaml@2.9.0/browser" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/yaml@2.9.0/browser/$(dirname "$rel")"
        cp "$SPIKE/vendor/npm/yaml@2.9.0/browser/$rel" "$ASSETS/vendor/npm/yaml@2.9.0/browser/$rel"
    done

# The pinned zod's runtime closure (the iOS embedder's ZOD_FILES list).
say "staging vendor/npm/zod@4.4.3 (classic runtime closure)"
mkdir -p "$ZOD_DST/v4/classic" "$ZOD_DST/v4/core" "$ZOD_DST/v4/locales"
cp "$ZOD_SRC/index.js" "$ZOD_DST/index.js"
cp "$ZOD_SRC"/v4/classic/*.js "$ZOD_DST/v4/classic/"
cp "$ZOD_SRC"/v4/core/*.js "$ZOD_DST/v4/core/"
cp "$ZOD_SRC"/v4/locales/*.js "$ZOD_DST/v4/locales/"

# The spine boot layer: EVERY upstream adapter + shim, mirrored wholesale —
# per-file lists went stale twice (2026-09-22: a committed fs.js shim predat-
# ing the FILE-TOOLS row's realpath/mountWorkspace, and gateway.js predating
# wasmRun, both invisible until a fresh install booted the spine). The
# directory mirror makes drift impossible by construction; the drift check
# below compares every file.
say "staging upstream boot layer (whole-dir mirror)"
mkdir -p "$ASSETS/upstream/shims"
find "$SPIKE/upstream" -maxdepth 1 -name '*.js' -type f | while IFS= read -r src; do
    cp "$src" "$ASSETS/upstream/$(basename "$src")"
done
find "$SPIKE/upstream/shims" -name '*.js' -type f | while IFS= read -r src; do
    cp "$src" "$ASSETS/upstream/shims/$(basename "$src")"
done
for f in gateway.js logger.js registry.js; do
    cmp -s "$SPIKE/$f" "$ASSETS/$f" || cp "$SPIKE/$f" "$ASSETS/$f"
done

# The spike-root runtime files the boot graph imports (gateway.js grows
# with the contract: the shell plugins import wasmRun/ishRun from it).
for f in gateway.js logger.js registry.js; do
    cmp -s "$SPIKE/$f" "$ASSETS/$f" || cp "$SPIKE/$f" "$ASSETS/$f"
done

# The system-plugins the boot's static graph imports (the two shell tools;
# the three older plugins are committed in assets directly and refreshed
# here too — byte-identical to runtime/spike, the single source).
# The TEST closure: every additional vendored package the upstream suites
# import (same tag; materialized by vendor/ensure-dsh-tests.sh). Untracked
# in assets by the same accepted pattern as the Gradle-materialized staged
# files — the check mode judges tracked files only.
for pkg_dir in "$SPIKE"/vendor/dsh/*@0.1.6-alpha.2; do
    pkg="$(basename "$pkg_dir")"
    [ -d "$pkg_dir/lib" ] || continue
    if [ ! -d "$ASSETS/vendor/dsh/$pkg/lib" ]; then
        mkdir -p "$ASSETS/vendor/dsh/$pkg"
        # .d.ts deliberately stays out (the curated runtime staging's own
        # convention — the lite grammars do not judge vendored typings).
        (cd "$pkg_dir" && find lib -type f ! -name '*.d.ts') | while IFS= read -r f; do
            mkdir -p "$ASSETS/vendor/dsh/$pkg/$(dirname "$f")"
            cp "$pkg_dir/$f" "$ASSETS/vendor/dsh/$pkg/$f"
        done
        cp "$pkg_dir/package.json" "$ASSETS/vendor/dsh/$pkg/package.json" 2>/dev/null || true
    fi
done
say "staged the test closure ($(ls "$ASSETS/vendor/dsh" | wc -l | tr -d ' ') packages total)"

say "staging system-plugins"
for p in dsh-fs dsh-shell-wasm dsh-shell-ish dsh-subprocess-quickjs dsh-ui; do
    mkdir -p "$ASSETS/system-plugins/$p"
    for f in manifest.json index.js; do
        cmp -s "$SPIKE/system-plugins/$p/$f" "$ASSETS/system-plugins/$p/$f" ||
            cp "$SPIKE/system-plugins/$p/$f" "$ASSETS/system-plugins/$p/$f"
    done
done

# The scenarios ride the same copy (assets stay byte-identical to the
# runtime bundle, like every other staged scenario). The upstream-suite
# driver + harness MUST be in this list: copyAssetDir re-merges assets over
# filesDir on EVERY launch, so an APK-stale harness silently clobbers any
# runner-pushed copy — the APK asset is the only source that sticks.
# The agent-flow scenario rides the same list (the vendored skill family it
# drives is staged above).
for s in android-session-live-read.js android-composer-live-write.js \
         upstream-suite-leg.js upstream-test-harness.js agent-flow.js; do
    if [ -f "$SPIKE/scenario/$s" ]; then
        cp "$SPIKE/scenario/$s" "$ASSETS/scenario/$s"
    fi
done

fi # MODE != check — staging skipped above in check mode

# In --check mode the comparison judges only the files the repo TRACKS: the
# spine/zod vendor subtrees are deliberately untracked (.gitignore — the
# Gradle stageSpineClosure task materializes them at build time, the same
# reproducible copy this script performs), and a fresh checkout legitimately
# lacks them. Untracked-but-staged files surface as a counted SKIP, never as
# drift and never invisibly (.gov's exclusion pattern).
TRACKED=""
SKIPS_FILE=""
if [ "$MODE" = "check" ]; then
    # git prints repo-relative paths; the comparisons below are absolute —
    # normalize once, or nothing ever matches (a vacuous check).
    TRACKED=$(git ls-files "$ASSETS" | sed "s|^|$ROOT/|")
    SKIPS_FILE=$(mktemp)
fi
is_tracked() { printf '%s\n' "$TRACKED" | grep -qxF "$ASSETS/$1"; }
note_skip() { [ -n "$SKIPS_FILE" ] && echo x >> "$SKIPS_FILE"; return 0; }

# Byte-identity proof over everything this script stages (rule 6: the
# copy is evidence only when a check can fail). Drift markers collect in a
# temp file because the pipeline `while` loops run in subshells — a `fail=1`
# there never reaches this shell (the vacuous verify this replaces).
DRIFT=$(mktemp)
trap 'rm -f "$DRIFT" "$SKIPS_FILE"' EXIT
note_drift() { echo "$1" >> "$DRIFT"; }
for pkg in agent agent-loop brand llm sandbox scope session \
           session-projection settings system-prompt timeout tools \
           typert-protocol util-values agent-presets atomic-write \
           home-paths fs attachment fs-local tool-fs \
           tool-str-replace-editor tool-todo \
           skill skill-filesystem tool-skill; do
    (cd "$SPIKE/vendor/dsh/$pkg@$VER" && find lib -type f ! -name '*.d.ts'; echo LICENSE; echo package.json) |
    while IFS= read -r rel; do
        [ -f "$SPIKE/vendor/dsh/$pkg@$VER/$rel" ] || continue
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/dsh/$pkg@$VER/$rel"; then note_skip; continue; fi
        cmp -s "$SPIKE/vendor/dsh/$pkg@$VER/$rel" "$ASSETS/vendor/dsh/$pkg@$VER/$rel" ||
            note_drift "vendor/dsh/$pkg@$VER/$rel"
    done
done
(cd "$SPIKE/vendor/npm/diff@9.0.0/libesm" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/diff@9.0.0/libesm/$rel"; then note_skip; continue; fi
        cmp -s "$SPIKE/vendor/npm/diff@9.0.0/libesm/$rel" "$ASSETS/vendor/npm/diff@9.0.0/libesm/$rel" ||
            note_drift "npm/diff@9.0.0/libesm/$rel"
    done
(cd "$SPIKE/vendor/npm/yaml@2.9.0/browser" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/yaml@2.9.0/browser/$rel"; then note_skip; continue; fi
        cmp -s "$SPIKE/vendor/npm/yaml@2.9.0/browser/$rel" "$ASSETS/vendor/npm/yaml@2.9.0/browser/$rel" ||
            note_drift "npm/yaml@2.9.0/browser/$rel"
    done
(cd "$ZOD_SRC" && find v4/classic v4/core v4/locales -name '*.js'; echo index.js) |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/zod@4.4.3/$rel"; then note_skip; continue; fi
        cmp -s "$ZOD_SRC/$rel" "$ZOD_DST/$rel" || note_drift "zod/$rel"
    done
(cd "$SPIKE/upstream" && find . -maxdepth 1 -name '*.js' -type f) |
    while IFS= read -r rel; do
        cmp -s "$SPIKE/upstream/$rel" "$ASSETS/upstream/$rel" || note_drift "upstream/$rel"
    done
(cd "$SPIKE/upstream/shims" && find . -name '*.js' -type f) |
    while IFS= read -r rel; do
        cmp -s "$SPIKE/upstream/shims/$rel" "$ASSETS/upstream/shims/$rel" || note_drift "shims/$rel"
    done
for f in gateway.js logger.js registry.js; do
    cmp -s "$SPIKE/$f" "$ASSETS/$f" || note_drift "$f"
done
# The staged scenarios (tracked asset copies — the suite driver among them:
# a stale APK copy would shadow every runtime-side fix, the exact defect the
# 2026-09-23 round-two chase hit).
for s in android-session-live-read.js android-composer-live-write.js \
         upstream-suite-leg.js upstream-test-harness.js agent-flow.js; do
    if [ "$MODE" = "check" ] && ! is_tracked "scenario/$s"; then note_skip; continue; fi
    cmp -s "$SPIKE/scenario/$s" "$ASSETS/scenario/$s" || note_drift "scenario/$s"
done
if [ -s "$DRIFT" ]; then
    while IFS= read -r rel; do echo "::error::stage drift: $rel"; done < "$DRIFT"
    die "staged assets drifted from the runtime pins (re-run build/build.sh sync android, or this script without --check)"
fi
if [ "$MODE" = "check" ]; then
    SKIPS=$(wc -l < "$SKIPS_FILE" | tr -d ' ')
    say "assets verified in place (check mode, no writes, $SKIPS untracked-but-staged file(s) skipped — materialized by the Gradle build)"
else
    say "staged + verified byte-identical to the runtime pins"
fi
