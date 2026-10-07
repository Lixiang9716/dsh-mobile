#!/bin/sh
# stage-spine-closure.sh — the Android analogue of the iOS embedder's tree
# mode (W-SESS #62): copies the D9 W-SESS spine closure from the runtime
# dsh bundle into the app assets, so the C host's loader bare map
# (`vendor/dsh/<pkg>@<ver>/lib/**`, `vendor/npm/...`) resolves the FULL
# upstream agent spine on-device. Idempotent; byte-identical to the
# runtime/dsh pins (ensure-dsh.sh is the single source of the pin).
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
DSH=$ROOT/runtime/dsh
ASSETS=$ROOT/hosts/android/app/src/main/assets/dsh
VER=0.1.6-alpha.2

say() { echo "stage-spine-closure: $*"; }
die() { echo "::error::stage-spine-closure: $*" >&2; exit 1; }

# --check: NO writes — run only the byte-identity proof against the committed
# assets (the closures gate; a gate that heals what it checks is vacuous).
MODE=stage
[ "${1:-}" = "--check" ] && MODE=check
[ $# -eq 0 ] || [ "$MODE" = "check" ] || die "unknown argument '$1' (only --check)"

[ -d "$DSH/vendor/dsh/session@$VER/lib" ] ||
    die "runtime vendor closure missing — run runtime/dsh/vendor/ensure-dsh.sh"

# Verify-phase variables, defined before the staging guard so --check mode
# (staging skipped) still has them.
ZOD_SRC=$DSH/vendor/npm/zod@4.4.3
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
    stage_pkg "$DSH/vendor/dsh/$pkg@$VER" "$ASSETS/vendor/dsh/$pkg@$VER"
done

# The MOBILE PRESET'S SHELL SURFACE — the iOS embedder's npm-face block
# (gen_bundle_header.py): these four preset rows pin on the NPM face only
# (the mirror serves no vendor/dsh tree for them), but every preset-health
# marker seeder walks vendor/dsh dirs ONLY (AgentPresetsSeed.kt here, the
# iOS drive, harmony's OfficialServe) — so the bytes stage AT the vendor/
# dsh/<pkg>@<ver> rel path and the seeder reads their package.json name.
# Without them every preset naming the row reads broken: the #324 release
# seat showed the Standard/PTC/Creator cards as 加载失败 on exactly the
# missing `present` row (tool-ralph/tool-pwsh are disabled rows today —
# health-skipped — and tool-bash's rows are !!js-gated; they ride so the
# three hosts stage the same surface and a mount leg finds the bytes).
# Hand-called per package like the other npm-face blocks: the stager keeps
# its six for-in lists (the shape gen-staging-manifests.mjs models).
stage_npm_face_at_dsh_path() {
    pkg=$1
    say "staging vendor/dsh/$pkg@$VER (npm-face bytes at the dsh rel path)"
    src="$DSH/vendor/npm/@deepseek-ai/dsh-$pkg@$VER"
    dst="$ASSETS/vendor/dsh/$pkg@$VER"
    [ -d "$src" ] || die "the dsh-$pkg npm pin is absent — runtime/dsh/vendor/ensure-dsh.sh materializes it"
    mkdir -p "$dst"
    for f in LICENSE package.json; do
        [ -f "$src/$f" ] && cp "$src/$f" "$dst/$f"
    done
    (cd "$src" && find lib -type f ! -name '*.d.ts') | while IFS= read -r rel; do
        mkdir -p "$dst/$(dirname "$rel")"
        cp "$src/$rel" "$dst/$rel"
    done
}
stage_npm_face_at_dsh_path tool-present
stage_npm_face_at_dsh_path tool-ralph
stage_npm_face_at_dsh_path tool-bash
stage_npm_face_at_dsh_path tool-pwsh
# The Creator composition's plugin-management row (the mobile-absent patch
# leaves it enabled since the T-0170 round): its marker seeds from the
# vendor/dsh rel path like every npm face above.
stage_npm_face_at_dsh_path plugin-manager

# The WEB plane's npm closure (the tool-web row, #335 B5): the dsh-web seam +
# the search-only tool + the turndown/domino/@joplin HTML->markdown chain the
# tool's static graph links (the per-file domino set mirrors the shims' cjs
# loader map; each face materializes from the pinned NPM_PACKAGES rows).
stage_npm_face_at_dsh_path tool-web
# the dsh-web seam: the npm face's dir name (dsh-web@) IS the canonical rel
# name — a direct stage (the helper would mint the web@ mismatch-name)
mkdir -p "$ASSETS/vendor/dsh/dsh-web@0.1.6-alpha.2/lib"
cp "$DSH/vendor/npm/@deepseek-ai/dsh-web@0.1.6-alpha.2/package.json" "$ASSETS/vendor/dsh/dsh-web@0.1.6-alpha.2/package.json"
cp "$DSH/vendor/npm/@deepseek-ai/dsh-web@0.1.6-alpha.2/lib/index.js" "$ASSETS/vendor/dsh/dsh-web@0.1.6-alpha.2/lib/index.js"
mkdir -p "$ASSETS/vendor/npm/turndown@7.2.4/lib" \
         "$ASSETS/vendor/npm/@mixmark-io/domino@2.2.0/lib" \
         "$ASSETS/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib"
cp "$DSH/vendor/npm/turndown@7.2.4/lib/turndown.es.js" "$ASSETS/vendor/npm/turndown@7.2.4/lib/turndown.es.js"
(cd "$DSH/vendor/npm/@mixmark-io/domino@2.2.0" && find lib -type f) | while IFS= read -r rel; do
    mkdir -p "$ASSETS/vendor/npm/@mixmark-io/domino@2.2.0/$(dirname "$rel")"
    cp "$DSH/vendor/npm/@mixmark-io/domino@2.2.0/$rel" "$ASSETS/vendor/npm/@mixmark-io/domino@2.2.0/$rel"
done
cp "$DSH/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js" \
   "$ASSETS/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js"

# The npm `diff` bridge target (upstream/shims/npm-bridges.js re-exports its
# libesm/index.js behind the bare specifier vendored tool-fs imports).
# The Agent presets closure's npm faces (boot.js imports them statically:
# the cordis Loader service + the include walker + js-yaml's ESM dist).
# The INTERACTIVE rows' npm-scope packages (commands/goals/fileReferences):
# command-feedback imports dsh-anonymous-user-id at module load, and the
# coverage rows mount dsh-goal + the file-reference pair — the same four
# the iOS embedder carries (gen_bundle_header.py's coverage block); without
# them every commands:true boot fails on the first import (caught by the
# v2web drive 2026-09-26: "no vendored dsh package serves it").
say "staging presets-closure npm packages"
mkdir -p "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib"
cp "$DSH/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js" \
   "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js"
mkdir -p "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib"
cp "$DSH/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js" \
   "$ASSETS/vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js"
mkdir -p "$ASSETS/vendor/npm/js-yaml@4.1.0/dist"
cp "$DSH/vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs" \
   "$ASSETS/vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs"
for pkg in dsh-anonymous-user-id dsh-goal dsh-file-reference dsh-file-reference-local dsh-llm-retry; do
    say "staging vendor/npm/@deepseek-ai/$pkg@$VER (lib)"
    (cd "$DSH/vendor/npm/@deepseek-ai/$pkg@$VER" && find lib -type f ! -name '*.d.ts') |
        while IFS= read -r rel; do
            mkdir -p "$ASSETS/vendor/npm/@deepseek-ai/$pkg@$VER/$(dirname "$rel")"
            cp "$DSH/vendor/npm/@deepseek-ai/$pkg@$VER/$rel" \
               "$ASSETS/vendor/npm/@deepseek-ai/$pkg@$VER/$rel"
        done
done

# The OFFICE row's zip engine (2026-09-27): npm-bridges re-exports the
# fflate ESM face behind bare 'fflate' for the dsh-office plugin.
say "staging vendor/npm/fflate@0.8.2 (esm)"
mkdir -p "$ASSETS/vendor/npm/fflate@0.8.2/esm"
(cd "$DSH/vendor/npm/fflate@0.8.2/esm" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/fflate@0.8.2/esm/$(dirname "$rel")"
        cp "$DSH/vendor/npm/fflate@0.8.2/esm/$rel" "$ASSETS/vendor/npm/fflate@0.8.2/esm/$rel"
    done

say "staging vendor/npm/diff@9.0.0 (libesm)"
mkdir -p "$ASSETS/vendor/npm/diff@9.0.0/libesm"
(cd "$DSH/vendor/npm/diff@9.0.0/libesm" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/diff@9.0.0/libesm/$(dirname "$rel")"
        cp "$DSH/vendor/npm/diff@9.0.0/libesm/$rel" "$ASSETS/vendor/npm/diff@9.0.0/libesm/$rel"
    done

# The SKILL row's npm face: upstream/shims/npm-bridges.js re-exports the
# yaml browser/ ESM tree behind the bare specifier skill-filesystem imports
# (the package's "node" face is CJS, which the loader cannot serve).
say "staging vendor/npm/yaml@2.9.0 (browser ESM face)"
(cd "$DSH/vendor/npm/yaml@2.9.0/browser" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/yaml@2.9.0/browser/$(dirname "$rel")"
        cp "$DSH/vendor/npm/yaml@2.9.0/browser/$rel" "$ASSETS/vendor/npm/yaml@2.9.0/browser/$rel"
    done

# The sharp face's vendored engines (the D-c row, 2026-09-29): the adapter
# package (upstream/shims/sharp/, riding the subdir-aware mirror above)
# requires these pin files by absolute staged path — pngjs's pixel stages,
# jpeg-js's codec, and the fflate CJS face its zlib calls ride.
say "staging vendor/npm/pngjs@5.0.0 (lib pixel stages)"
mkdir -p "$ASSETS/vendor/npm/pngjs@5.0.0/lib"
(cd "$DSH/vendor/npm/pngjs@5.0.0/lib" && find . -type f -name '*.js') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/pngjs@5.0.0/lib/$(dirname "$rel")"
        cp "$DSH/vendor/npm/pngjs@5.0.0/lib/$rel" "$ASSETS/vendor/npm/pngjs@5.0.0/lib/$rel"
    done
say "staging vendor/npm/jpeg-js@0.4.4 (codec)"
mkdir -p "$ASSETS/vendor/npm/jpeg-js@0.4.4/lib"
cp "$DSH/vendor/npm/jpeg-js@0.4.4/index.js" "$ASSETS/vendor/npm/jpeg-js@0.4.4/index.js"
(cd "$DSH/vendor/npm/jpeg-js@0.4.4/lib" && find . -type f -name '*.js') |
    while IFS= read -r rel; do
        cp "$DSH/vendor/npm/jpeg-js@0.4.4/lib/$rel" "$ASSETS/vendor/npm/jpeg-js@0.4.4/lib/$rel"
    done
say "staging vendor/npm/fflate@0.8.2 (lib CJS face)"
mkdir -p "$ASSETS/vendor/npm/fflate@0.8.2/lib"
cp "$DSH/vendor/npm/fflate@0.8.2/lib/index.cjs" "$ASSETS/vendor/npm/fflate@0.8.2/lib/index.cjs"

# The crypto shims' npm face (2026-09-29): shims/crypto.js statically
# imports @noble/hashes/{sha2,hmac,legacy}.js and the host's STATIC bare
# map resolves @noble/hashes/<sub> into this pin — the whole .js set rides
# (the anti-drift rule; the in-app parity leg died on exactly this gap).
say "staging vendor/npm/@noble/hashes@2.3.0 (js)"
if [ ! -d "$DSH/vendor/npm/@noble/hashes@2.3.0" ]; then
    echo "::error::stage-spine-closure: the @noble/hashes pin is absent — runtime/dsh/vendor/ensure.sh materializes it" >&2
    exit 1
fi
mkdir -p "$ASSETS/vendor/npm/@noble/hashes@2.3.0"
(cd "$DSH/vendor/npm/@noble/hashes@2.3.0" && find . -type f -name '*.js') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/@noble/hashes@2.3.0/$(dirname "$rel")"
        cp "$DSH/vendor/npm/@noble/hashes@2.3.0/$rel" "$ASSETS/vendor/npm/@noble/hashes@2.3.0/$rel"
    done

# The pi-ai bridge target (2026-09-29): the providers barrel's
# data/.manifest.json require needs the data face, the provider rows need
# their files — the whole pin rides (the parity m4 mount died on exactly
# this gap: bridge rows present, bytes absent in-app).
say "staging vendor/npm/@earendil-works/pi-ai@0.85.1 (js+json)"
if [ ! -d "$DSH/vendor/npm/@earendil-works/pi-ai@0.85.1" ]; then
    echo "::error::stage-spine-closure: the pi-ai pin is absent — runtime/dsh/vendor/ensure.sh materializes it" >&2
    exit 1
fi
mkdir -p "$ASSETS/vendor/npm/@earendil-works/pi-ai@0.85.1"
(cd "$DSH/vendor/npm/@earendil-works/pi-ai@0.85.1" && find . -type f \( -name '*.js' -o -name '*.json' \) ! -name '.*') |
    while IFS= read -r rel; do
        mkdir -p "$ASSETS/vendor/npm/@earendil-works/pi-ai@0.85.1/$(dirname "$rel")"
        cp "$DSH/vendor/npm/@earendil-works/pi-ai@0.85.1/$rel" "$ASSETS/vendor/npm/@earendil-works/pi-ai@0.85.1/$rel"
    done
# The providers barrel's data/.manifest.json cannot ride the APK (aapt drops
# hidden files, same as the HAP packer — the harmony twin of this fix,
# 2026-09-30): its bytes ride under the NON-hidden alias the
# npm-bridges-pi-ai.js seam falls back to.
mkdir -p "$ASSETS/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data"
cp "$DSH/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/.manifest.json" \
    "$ASSETS/vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/manifest.json"

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
find "$DSH/upstream" -maxdepth 1 -name '*.js' -type f | while IFS= read -r src; do
    cp "$src" "$ASSETS/upstream/$(basename "$src")"
done
# Subdir-aware mirror (the sharp face's adapter package lives at
# upstream/shims/sharp/): the relative path rides intact, and the adapter's
# package.json (the cjs-loader entry probe reads it) stages beside the code.
find "$DSH/upstream/shims" -name '*.js' -type f | while IFS= read -r src; do
    rel="${src#"$DSH"/upstream/shims/}"
    mkdir -p "$ASSETS/upstream/shims/$(dirname "$rel")"
    cp "$src" "$ASSETS/upstream/shims/$rel"
done
mkdir -p "$ASSETS/upstream/shims/sharp"
cp "$DSH/upstream/shims/sharp/package.json" "$ASSETS/upstream/shims/sharp/package.json"
for f in gateway.js logger.js transport-tokens.mjs registry.js workspace-registry.js ed25519.js marketplace-resolver.js canonical-json.js install-fetch.js receipt-journal.js; do
    cmp -s "$DSH/$f" "$ASSETS/$f" || cp "$DSH/$f" "$ASSETS/$f"
done

# The dsh-root runtime files the boot graph imports (gateway.js grows
# with the contract: the shell plugins import wasmRun/ishRun from it;
# ed25519.js + marketplace-resolver.js ride the marketplace seam).
for f in gateway.js logger.js transport-tokens.mjs registry.js workspace-registry.js ed25519.js marketplace-resolver.js canonical-json.js install-fetch.js receipt-journal.js; do
    cmp -s "$DSH/$f" "$ASSETS/$f" || cp "$DSH/$f" "$ASSETS/$f"
done

# The caller manifest (id dsh.runtime.scenario) is the gateway's permission
# record: a stale copy silently denies primitives the canonical manifest
# grants, so it rides the same byte-identity sync as the runtime files.
cmp -s "$DSH/manifest.json" "$ASSETS/manifest.json" || cp "$DSH/manifest.json" "$ASSETS/manifest.json"

# The system-plugins the boot's static graph imports (the two shell tools;
# the three older plugins are committed in assets directly and refreshed
# here too — byte-identical to runtime/dsh, the single source).
# The TEST closure: every additional vendored package the upstream suites
# import (same tag; materialized by vendor/ensure-dsh-tests.sh). Untracked
# in assets by the same accepted pattern as the Gradle-materialized staged
# files — the check mode judges tracked files only.
for pkg_dir in "$DSH"/vendor/dsh/*@0.1.6-alpha.2; do
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
say "staged the test closure ($(find "$ASSETS/vendor/dsh" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ') packages total)"

say "staging system-plugins (whole directories — a plugin joins by existing)"
for src in "$DSH"/system-plugins/*/; do
    p=$(basename "$src")
    mkdir -p "$ASSETS/system-plugins/$p"
    (cd "$src" && find . -type f) |
        while IFS= read -r rel; do
            mkdir -p "$ASSETS/system-plugins/$p/$(dirname "$rel")"
            cmp -s "$src$rel" "$ASSETS/system-plugins/$p/$rel" ||
                cp "$src$rel" "$ASSETS/system-plugins/$p/$rel"
        done
done

# The self-hosted web clients (presentation/web-client-v2 on the official
# /api+mux plane, presentation/web-client-compact on the v0 /ws plane):
# whole-tree mirrors into assets/dsh/webclient-{next,compact}, the same
# sync+check discipline as the upstream layer — the iOS embedder stages the
# same two trees through gen_bundle_header.py WEBCLIENT_TREES, and the v0
# webclient's older hand-committed copy (assets/dsh/webclient) predates
# this discipline and stays as-is.
for client in v2 compact; do
    say "staging presentation/web-client-$client → assets/dsh/webclient-$client"
    (cd "$ROOT/presentation/web-client-$client" && find . -type f) |
        while IFS= read -r rel; do
            mkdir -p "$ASSETS/webclient-$client/$(dirname "$rel")"
            cp "$ROOT/presentation/web-client-$client/$rel" "$ASSETS/webclient-$client/$rel"
        done
done

# The scenarios ride the same copy (assets stay byte-identical to the
# runtime bundle, like every other staged scenario). The upstream-suite
# driver + harness MUST be in this list: copyAssetDir re-merges assets over
# filesDir on EVERY launch, so an APK-stale harness silently clobbers any
# runner-pushed copy — the APK asset is the only source that sticks.
# The agent-flow scenario rides the same list (the vendored skill family it
# drives is staged above); the mic-plane scenario too (the capability
# plane's microphone leg, v1.10.0 candidate — an unlisted scenario would
# silently freeze on a fresh install, the embed-list trap).
for s in boot-verification.js gateway-bridge-smoke.js session-mock-llm.js \
         android-capability-binding.js \
         android-session-live-read.js android-composer-live-write.js \
         composer-web-live.js write-surface-options.js manager-legs-probe.js \
         probe-respond-await.js scenario-verdict.js api-handler-respond.js \
         device-plane.js camera-plane.js ble-plane.js mic-plane.js \
         upstream-suite-leg.js upstream-suite-flatmap.js upstream-suite-type-world.js \
         upstream-test-harness.js upstream-harness-matchers.js upstream-harness-vi.js \
         upstream-fake-timers.js agent-presets-probe-seed.js agent-flow.js; do
    if [ -f "$DSH/scenario/$s" ]; then
        cp "$DSH/scenario/$s" "$ASSETS/scenario/$s"
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
# grep -c reads the whole pipe (grep -q's early exit SIGPIPEs the printf
# mid-write — 'write error: Broken pipe' spewed on every check run, #192).
is_tracked() { printf '%s\n' "$TRACKED" | grep -cxF "$ASSETS/$1" >/dev/null; }
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
    (cd "$DSH/vendor/dsh/$pkg@$VER" && find lib -type f ! -name '*.d.ts'; echo LICENSE; echo package.json) |
    while IFS= read -r rel; do
        [ -f "$DSH/vendor/dsh/$pkg@$VER/$rel" ] || continue
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/dsh/$pkg@$VER/$rel"; then note_skip; continue; fi
        cmp -s "$DSH/vendor/dsh/$pkg@$VER/$rel" "$ASSETS/vendor/dsh/$pkg@$VER/$rel" ||
            note_drift "vendor/dsh/$pkg@$VER/$rel"
    done
done
# The shell-surface npm faces staged at the dsh rel paths (the block above):
# byte-identity against their own pin — the npm face IS the pin these bytes
# ride (the dsh face has no tree for them). Twin of the stage helper, called
# per package the same way.
verify_npm_face_at_dsh_path() {
    pkg=$1
    (cd "$DSH/vendor/npm/@deepseek-ai/dsh-$pkg@$VER" && find lib -type f ! -name '*.d.ts'; echo LICENSE; echo package.json) |
    while IFS= read -r rel; do
        [ -f "$DSH/vendor/npm/@deepseek-ai/dsh-$pkg@$VER/$rel" ] || continue
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/dsh/$pkg@$VER/$rel"; then note_skip; continue; fi
        cmp -s "$DSH/vendor/npm/@deepseek-ai/dsh-$pkg@$VER/$rel" "$ASSETS/vendor/dsh/$pkg@$VER/$rel" ||
            note_drift "vendor/dsh/$pkg@$VER/$rel"
    done
}
verify_npm_face_at_dsh_path tool-present
verify_npm_face_at_dsh_path tool-ralph
verify_npm_face_at_dsh_path tool-bash
verify_npm_face_at_dsh_path tool-pwsh
# The manager row's face (staged since the workspace-registry tier) and the
# WEB plane's tool face (the #335 B5 block above): same twin discipline — a
# staged face the check never cmps is a drift the closures gate is blind to.
verify_npm_face_at_dsh_path plugin-manager
verify_npm_face_at_dsh_path tool-web
# The WEB plane's direct-stage twins (the dsh-web seam + the HTML→markdown
# chain the tool's static graph links): byte-identity against their pins.
for f in package.json lib/index.js; do
    if [ "$MODE" = "check" ] && ! is_tracked "vendor/dsh/dsh-web@$VER/$f"; then note_skip; continue; fi
    cmp -s "$DSH/vendor/npm/@deepseek-ai/dsh-web@$VER/$f" "$ASSETS/vendor/dsh/dsh-web@$VER/$f" ||
        note_drift "vendor/dsh/dsh-web@$VER/$f"
done
if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/turndown@7.2.4/lib/turndown.es.js"; then note_skip
else cmp -s "$DSH/vendor/npm/turndown@7.2.4/lib/turndown.es.js" "$ASSETS/vendor/npm/turndown@7.2.4/lib/turndown.es.js" ||
    note_drift "vendor/npm/turndown@7.2.4/lib/turndown.es.js"
fi
(cd "$DSH/vendor/npm/@mixmark-io/domino@2.2.0" && find lib -type f) |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/@mixmark-io/domino@2.2.0/$rel"; then note_skip; continue; fi
        cmp -s "$DSH/vendor/npm/@mixmark-io/domino@2.2.0/$rel" "$ASSETS/vendor/npm/@mixmark-io/domino@2.2.0/$rel" ||
            note_drift "vendor/npm/@mixmark-io/domino@2.2.0/$rel"
    done
if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js"; then note_skip
else cmp -s "$DSH/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js" \
        "$ASSETS/vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js" ||
    note_drift "vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js"
fi
(cd "$DSH/vendor/npm/diff@9.0.0/libesm" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/diff@9.0.0/libesm/$rel"; then note_skip; continue; fi
        cmp -s "$DSH/vendor/npm/diff@9.0.0/libesm/$rel" "$ASSETS/vendor/npm/diff@9.0.0/libesm/$rel" ||
            note_drift "npm/diff@9.0.0/libesm/$rel"
    done
(cd "$DSH/vendor/npm/yaml@2.9.0/browser" && find . -type f ! -name '*.d.ts') |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/yaml@2.9.0/browser/$rel"; then note_skip; continue; fi
        cmp -s "$DSH/vendor/npm/yaml@2.9.0/browser/$rel" "$ASSETS/vendor/npm/yaml@2.9.0/browser/$rel" ||
            note_drift "npm/yaml@2.9.0/browser/$rel"
    done
for pkg in dsh-anonymous-user-id dsh-goal dsh-file-reference dsh-file-reference-local dsh-llm-retry; do
    (cd "$DSH/vendor/npm/@deepseek-ai/$pkg@$VER" && find lib -type f ! -name '*.d.ts') |
        while IFS= read -r rel; do
            path="vendor/npm/@deepseek-ai/$pkg@$VER/$rel"
            if [ "$MODE" = "check" ] && ! is_tracked "$path"; then note_skip; continue; fi
            cmp -s "$DSH/$path" "$ASSETS/$path" || note_drift "$path"
        done
done
(cd "$ZOD_SRC" && find v4/classic v4/core v4/locales -name '*.js'; echo index.js) |
    while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && ! is_tracked "vendor/npm/zod@4.4.3/$rel"; then note_skip; continue; fi
        cmp -s "$ZOD_SRC/$rel" "$ZOD_DST/$rel" || note_drift "zod/$rel"
    done
(cd "$DSH/upstream" && find . -maxdepth 1 -name '*.js' -type f) |
    while IFS= read -r rel; do
        cmp -s "$DSH/upstream/$rel" "$ASSETS/upstream/$rel" || note_drift "upstream/$rel"
    done
(cd "$DSH/upstream/shims" && find . -name '*.js' -type f) |
    while IFS= read -r rel; do
        cmp -s "$DSH/upstream/shims/$rel" "$ASSETS/upstream/shims/$rel" || note_drift "shims/$rel"
    done
cmp -s "$DSH/upstream/shims/sharp/package.json" "$ASSETS/upstream/shims/sharp/package.json" ||
    note_drift "shims/sharp/package.json"
for f in gateway.js logger.js transport-tokens.mjs registry.js workspace-registry.js ed25519.js marketplace-resolver.js canonical-json.js install-fetch.js receipt-journal.js; do
    cmp -s "$DSH/$f" "$ASSETS/$f" || note_drift "$f"
done
# The staged web-client trees (tracked asset copies, judged both ways the
# script already covers: present files must match the presentation/ source).
# The `./` strip is load-bearing: find emits ./-prefixed paths, and a ./ in
# the is_tracked needle matches nothing — every row became a counted SKIP
# and the whole webclient byte-verify was vacuous in check mode (the #286
# timeline.js mirror drift rode exactly this hole past two PRs, measured
# 2026-10-01: an injected mirror drift exited 0).
for client in v2 compact; do
    (cd "$ROOT/presentation/web-client-$client" && find . -type f) |
        while IFS= read -r rel; do
            rel=${rel#./}
            if [ "$MODE" = "check" ] && ! is_tracked "webclient-$client/$rel"; then note_skip; continue; fi
            cmp -s "$ROOT/presentation/web-client-$client/$rel" "$ASSETS/webclient-$client/$rel" ||
                note_drift "webclient-$client/$rel"
        done
done
# The staged scenarios (tracked asset copies — the suite driver among them:
# a stale APK copy would shadow every runtime-side fix, the exact defect the
# 2026-09-23 round-two chase hit).
for s in boot-verification.js gateway-bridge-smoke.js session-mock-llm.js \
         android-capability-binding.js \
         android-session-live-read.js android-composer-live-write.js \
         composer-web-live.js write-surface-options.js manager-legs-probe.js \
         probe-respond-await.js scenario-verdict.js api-handler-respond.js \
         device-plane.js camera-plane.js ble-plane.js mic-plane.js \
         upstream-suite-leg.js upstream-suite-flatmap.js upstream-suite-type-world.js \
         upstream-test-harness.js upstream-harness-matchers.js upstream-harness-vi.js \
         upstream-fake-timers.js agent-presets-probe-seed.js agent-flow.js; do
    if [ "$MODE" = "check" ] && ! is_tracked "scenario/$s"; then note_skip; continue; fi
    cmp -s "$DSH/scenario/$s" "$ASSETS/scenario/$s" || note_drift "scenario/$s"
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
