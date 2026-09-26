#!/bin/sh
# vendor-official.sh — materialize the D9 official-web mount assets into the
# app's rawfile tree (hosts/harmony rawfile is COMMITTED, so the HAP is
# self-contained: the carrier serves the official dist + /plugins bundles
# straight from rawfile bytes, and the web-boot runtime half loads the
# vendored closure the same way).
#
# Sources (all untracked trees materialized + sha256-verified by their
# ensure scripts — the tracked provenance record):
#   test/e2e/ensure-official-dist.sh  → presentation/official-web/dist
#   test/e2e/ensure-client-bundles.sh → presentation/official-web/client-bundles/npm
#   runtime/spike/vendor/ensure-dsh.sh → runtime/spike/vendor/npm (the pinned
#     @deepseek-ai/dsh-client-modules wins for the bootstrap package, the
#     same precedence test/e2e/run-ios-official-web-mount.sh applies on iOS)
#
# Layout under entry/src/main/resources/rawfile/spike/:
#   officialweb/www/…                     ← the official dist (www: the repo
#                                            .gitignore excludes any dist/
#                                            dir, so the rawfile copy carries
#                                            a neutral name; bytes verbatim)
#   officialweb/plugins/npm/@deepseek-ai/… ← the staged client bundles
#   scenario/officialweb-web-live.js, upstream/…, vendor/npm/… ← the web-boot closure
#     (byte-identical to the runtime/spike canonicals — the m5 surprise
#     ledger: drift in these copies is silent)
#   + the W-SESS SPINE closure (harmony.session.live-read): the mobile profile
#     boot, its settings backend, the gateway llm transport, the session-live
#     scenario, the spine shims beyond the web-boot set, and the vendored
#     upstream spine packages (14 verbatim lib/ trees + package.json each)
#     with the pinned zod's classic closure — the same file set iOS embeds
#     via gen_bundle_header.py tree mode (172 tree files + the authored
#     spine files). #56-class drift guard: ci/check-bundle-files.mjs
#     cross-checks this list against Index.ets's BUNDLE_FILES.
#   + the llm.live-stream real-LLM leg closure (W-HARMONY5): scenario/llm-live-stream.js and
#     llm.js, byte-identical to runtime/spike (the leg runs the SAME scenario
#     code as iOS/Android/CLI over this host's real httpFetch).
#
# Every copied file is byte-verified (cmp) against its source; the closure
# files additionally carry a shasum check in ci/run-host-e2e.sh's build step.
# usage: hosts/harmony/ci/vendor-official.sh   exit 0 = rawfile fresh
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
RAW=hosts/harmony/entry/src/main/resources/rawfile/spike

# Modes (build/build.sh sync + the closures gate are the callers):
#   (default)        full CI materialization: ensure scripts + officialweb + closure
#   --closure-only   the spike closure only, from the local canonical trees —
#                    no network, no officialweb re-sync (the local re-stage)
#   --check          NO writes: byte-verify the committed closure only (the
#                    closures gate — a gate that heals what it checks is vacuous)
MODE=full
for arg in "$@"; do
    case "$arg" in
        --closure-only) MODE=closure ;;
        --suite-extras) MODE=suite ;;
        --check) MODE=check ;;
        *) echo "vendor-official: unknown argument '$arg'" >&2
           echo "usage: vendor-official.sh [--closure-only|--suite-extras|--check]" >&2
           exit 2 ;;
    esac
done


if [ "$MODE" = "suite" ]; then
    # The upstream-suite HAP extras: the transpiled corpus + the test
    # closure packages (untracked, generated per tag) staged into rawfile so
    # the suite leg's materializer serves them beside the pinned bundle.
    # NOT part of the standard flow — the BUNDLE_FILES drift check judges
    # the tracked tree only, and this mode runs only in the suite CI job.
    CORPUS="runtime/spike/upstream-tests"
    [ -f "$CORPUS/manifest.json" ] || {
        echo "::error::vendor-official: transpiled corpus missing — run test/upstream-suite/transpile.mjs first" >&2
        exit 1
    }
    mkdir -p "$RAW/upstream-tests" "$RAW/vendor/dsh"
    : > "$RAW/upstream-tests/__files.txt"
    (cd "$CORPUS" && find . -name '*.spec.mjs' -o -name 'manifest.json') | sed 's|^\./||' | while IFS= read -r f; do
        cp "$CORPUS/$f" "$RAW/upstream-tests/$f"
        echo "upstream-tests/$f" >> "$RAW/upstream-tests/__files.txt"
    done
    for pkg_dir in runtime/spike/vendor/dsh/*@0.1.6-alpha.2; do
        pkg="$(basename "$pkg_dir")"
        [ -d "$pkg_dir/lib" ] || continue
        if [ ! -d "$RAW/vendor/dsh/$pkg/lib" ]; then
            mkdir -p "$RAW/vendor/dsh/$pkg"
            (cd "$pkg_dir" && find lib -type f ! -name '*.d.ts') | while IFS= read -r f; do
                mkdir -p "$RAW/vendor/dsh/$pkg/$(dirname "$f")"
                cp "$pkg_dir/$f" "$RAW/vendor/dsh/$pkg/$f"
                echo "vendor/dsh/$pkg/$f" >> "$RAW/upstream-tests/__files.txt"
                cp "$pkg_dir/package.json" "$RAW/vendor/dsh/$pkg/package.json" 2>/dev/null || true
            done
        else
            (cd "$pkg_dir" && find lib -type f ! -name '*.d.ts') | while IFS= read -r f; do
                [ -f "$RAW/vendor/dsh/$pkg/$f" ] || { cp "$pkg_dir/$f" "$RAW/vendor/dsh/$pkg/$f"; echo "vendor/dsh/$pkg/$f" >> "$RAW/upstream-tests/__files.txt"; }
            done
        fi
    done
    # package.json rows for freshly staged packages (the loader may read them)
    for pkg_dir in runtime/spike/vendor/dsh/*@0.1.6-alpha.2; do
        pkg="$(basename "$pkg_dir")"
        if [ -f "$RAW/vendor/dsh/$pkg/package.json" ] && ! grep -q "^vendor/dsh/$pkg/package.json$" "$RAW/upstream-tests/__files.txt"; then
            echo "vendor/dsh/$pkg/package.json" >> "$RAW/upstream-tests/__files.txt"
        fi
    done
    echo "vendor-official: suite extras staged ($(wc -l < "$RAW/upstream-tests/__files.txt" | tr -d ' ') files listed)"
    exit 0
fi

if [ "$MODE" != "full" ]; then
    # The closure's vendor sources are the local materialized pin trees —
    # untracked by design (D6), so name the remedy when they are absent.
    [ -d runtime/spike/vendor/dsh ] || {
        echo "::error::vendor-official: runtime/spike/vendor/dsh missing — run runtime/spike/vendor/ensure-dsh.sh first" >&2
        exit 1
    }
fi
if [ "$MODE" = "full" ]; then
    echo "vendor-official: ensuring the source trees"
    test/e2e/ensure-official-dist.sh
    test/e2e/ensure-client-bundles.sh
    runtime/spike/vendor/ensure-dsh.sh > /dev/null
fi

PIN=dsh-client-modules@0.1.6-alpha.2
VENDORED="runtime/spike/vendor/npm/@deepseek-ai/$PIN"
[ -f "$VENDORED/lib/client.js" ] || {
    echo "::error::vendored bootstrap package missing ($VENDORED)" >&2
    exit 1
}

if [ "$MODE" = "full" ]; then
    echo "vendor-official: syncing rawfile (officialweb/www + officialweb/plugins + closure)"
    rm -rf "$RAW/officialweb"
    mkdir -p "$RAW/officialweb/plugins/npm/@deepseek-ai"
    cp -R presentation/official-web/dist "$RAW/officialweb/www"
    cp -R presentation/official-web/client-bundles/npm/@deepseek-ai/. \
        "$RAW/officialweb/plugins/npm/@deepseek-ai/"
    # The pinned vendored tarball wins for the bootstrap package (D6 pin record;
    # lib/client.js is byte-identical to the workspace build — PROVENANCE).
    rm -rf "$RAW/officialweb/plugins/npm/@deepseek-ai/$PIN"
    cp -R "$VENDORED" "$RAW/officialweb/plugins/npm/@deepseek-ai/"
fi

# The web-boot closure (officialweb-web-live drive): the adapter, its shims, and the
# vendored npm libs the client-modules composition imports — the exact
# bundle-root relative paths the C loader's bare map resolves.
CLOSURE="scenario/officialweb-web-live.js
scenario/composer-web-live.js
upstream/web-boot.js
upstream/web-shims.js
upstream/shims/buffer.js
upstream/shims/url.js
upstream/shims/fs.js
upstream/shims/crypto.js
upstream/shims/node-module.js
upstream/shims/path.js
vendor/npm/cordis@4.0.2/lib/index.js
vendor/npm/cosmokit@1.8.3/lib/index.js
vendor/npm/schemastery@3.18.2/lib/index.mjs
vendor/npm/@deepseek-ai/$PIN/lib/index.js
vendor/npm/@deepseek-ai/$PIN/lib/client.js
vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs
vendor/npm/@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2/lib/index.js
vendor/npm/diff@9.0.0/libesm/convert/dmp.js
vendor/npm/diff@9.0.0/libesm/convert/xml.js
vendor/npm/diff@9.0.0/libesm/diff/array.js
vendor/npm/diff@9.0.0/libesm/diff/base.js
vendor/npm/diff@9.0.0/libesm/diff/character.js
vendor/npm/diff@9.0.0/libesm/diff/css.js
vendor/npm/diff@9.0.0/libesm/diff/json.js
vendor/npm/diff@9.0.0/libesm/diff/line.js
vendor/npm/diff@9.0.0/libesm/diff/sentence.js
vendor/npm/diff@9.0.0/libesm/diff/word.js
vendor/npm/diff@9.0.0/libesm/index.js
vendor/npm/diff@9.0.0/libesm/package.json
vendor/npm/diff@9.0.0/libesm/patch/apply.js
vendor/npm/diff@9.0.0/libesm/patch/create.js
vendor/npm/diff@9.0.0/libesm/patch/line-endings.js
vendor/npm/diff@9.0.0/libesm/patch/parse.js
vendor/npm/diff@9.0.0/libesm/patch/reverse.js
vendor/npm/diff@9.0.0/libesm/types.js
vendor/npm/diff@9.0.0/libesm/util/array.js
vendor/npm/diff@9.0.0/libesm/util/distance-iterator.js
vendor/npm/diff@9.0.0/libesm/util/params.js
vendor/npm/diff@9.0.0/libesm/util/string.js
vendor/npm/yaml@2.9.0/browser/dist/compose/compose-collection.js
vendor/npm/yaml@2.9.0/browser/dist/compose/compose-doc.js
vendor/npm/yaml@2.9.0/browser/dist/compose/compose-node.js
vendor/npm/yaml@2.9.0/browser/dist/compose/compose-scalar.js
vendor/npm/yaml@2.9.0/browser/dist/compose/composer.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-map.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-scalar.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-seq.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-end.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-flow-collection.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-flow-scalar.js
vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-props.js
vendor/npm/yaml@2.9.0/browser/dist/compose/util-contains-newline.js
vendor/npm/yaml@2.9.0/browser/dist/compose/util-empty-scalar-position.js
vendor/npm/yaml@2.9.0/browser/dist/compose/util-flow-indent-check.js
vendor/npm/yaml@2.9.0/browser/dist/compose/util-map-includes.js
vendor/npm/yaml@2.9.0/browser/dist/doc/Document.js
vendor/npm/yaml@2.9.0/browser/dist/doc/anchors.js
vendor/npm/yaml@2.9.0/browser/dist/doc/applyReviver.js
vendor/npm/yaml@2.9.0/browser/dist/doc/createNode.js
vendor/npm/yaml@2.9.0/browser/dist/doc/directives.js
vendor/npm/yaml@2.9.0/browser/dist/errors.js
vendor/npm/yaml@2.9.0/browser/dist/index.js
vendor/npm/yaml@2.9.0/browser/dist/log.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/Alias.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/Collection.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/Node.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/Pair.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/Scalar.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/YAMLMap.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/YAMLSeq.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/addPairToJSMap.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/identity.js
vendor/npm/yaml@2.9.0/browser/dist/nodes/toJS.js
vendor/npm/yaml@2.9.0/browser/dist/parse/cst-scalar.js
vendor/npm/yaml@2.9.0/browser/dist/parse/cst-stringify.js
vendor/npm/yaml@2.9.0/browser/dist/parse/cst-visit.js
vendor/npm/yaml@2.9.0/browser/dist/parse/cst.js
vendor/npm/yaml@2.9.0/browser/dist/parse/lexer.js
vendor/npm/yaml@2.9.0/browser/dist/parse/line-counter.js
vendor/npm/yaml@2.9.0/browser/dist/parse/parser.js
vendor/npm/yaml@2.9.0/browser/dist/public-api.js
vendor/npm/yaml@2.9.0/browser/dist/schema/Schema.js
vendor/npm/yaml@2.9.0/browser/dist/schema/common/map.js
vendor/npm/yaml@2.9.0/browser/dist/schema/common/null.js
vendor/npm/yaml@2.9.0/browser/dist/schema/common/seq.js
vendor/npm/yaml@2.9.0/browser/dist/schema/common/string.js
vendor/npm/yaml@2.9.0/browser/dist/schema/core/bool.js
vendor/npm/yaml@2.9.0/browser/dist/schema/core/float.js
vendor/npm/yaml@2.9.0/browser/dist/schema/core/int.js
vendor/npm/yaml@2.9.0/browser/dist/schema/core/schema.js
vendor/npm/yaml@2.9.0/browser/dist/schema/json/schema.js
vendor/npm/yaml@2.9.0/browser/dist/schema/tags.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/binary.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/bool.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/float.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/int.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/merge.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/omap.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/pairs.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/schema.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/set.js
vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/timestamp.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/foldFlowLines.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringify.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyCollection.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyComment.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyDocument.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyNumber.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyPair.js
vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyString.js
vendor/npm/yaml@2.9.0/browser/dist/util.js
vendor/npm/yaml@2.9.0/browser/dist/visit.js
vendor/npm/yaml@2.9.0/browser/index.js
vendor/npm/yaml@2.9.0/browser/package.json
$(cd runtime/spike && find vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2 \
    vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2 \
    vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2 \
    \( -name '*.js' -o -name '*.json' \) -type f | LC_ALL=C sort)"

# The W-SESS spine closure (harmony.session.live-read): OUR authored spine
# files first, then the vendored upstream trees — generated from the
# materialized vendor checkout (suffix filter .js/.mjs/.json, sorted, the
# same rule as hosts/ios/Tools/gen_bundle_header.py collect_tree_files).
SPINE_OURS="scenario/boot-verification.js
scenario/harmony-session-live-read.js
scenario/harmony-composer-live-write.js
upstream/boot.js
upstream/settings-memory.js
upstream/llm-transport.js
upstream/web-write.js
upstream/web-write-settings.js
upstream/web-write-streams.js
upstream/web-write-coverage.js
upstream/web-write-llm.js
upstream/preset-mobile-rows.js
upstream/web-write-files.js
upstream/web-write-picker.js
upstream/web-write-workspace.js
upstream/web-write-catalog.js
upstream/shims/async-hooks.js
upstream/shims/util.js
upstream/shims/fs-promises.js
upstream/shims/events.js
upstream/shims/util-types.js
upstream/shims/os.js
upstream/shims/process.js
upstream/shims/dsh-session-persistence.js
upstream/shims/expect-async-chain.js
upstream/shims/vi-wait.js
upstream/shims/globals.js
upstream/shims/npm-bridges.js
scenario/upstream-suite-leg.js
vendor/dsh/session-persistence@0.1.6-alpha.2/lib/index.js
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/agent.cordis.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/preset.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/skills/cordis-plugin-development/SKILL.md
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/skills/editing-cordis-compositions/SKILL.md
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/minimal/agent.cordis.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/minimal/preset.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/agent.cordis.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/preset.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/agent.cordis.yml
vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/preset.yml
vendor/dsh/session-persistence@0.1.6-alpha.2/package.json"
SPINE_PKG_DSH="agent agent-instructions agent-loop agent-presets atomic-write attachment brand chunked-list command-compact command-feedback command-goal commands compaction compaction-basic compaction-tool-result-pruner credentials fs fs-local goal home-paths jobs llm output-retention persona plan-mode sandbox scope session session-persistence session-projection settings skill skill-filesystem subagent system-prompt terminal timeout token-meter tool-ask-user tool-bash tool-fs tool-goal tool-jobs tool-present tool-pwsh tool-ralph tool-skill tool-str-replace-editor tool-subagent tool-subagent-control tool-todo tool-workflow tools typert-protocol user-questions util-time util-values workflow"
SPINE_OURS="$SPINE_OURS
vendor/npm/cordis@4.0.2/package.json
vendor/npm/cosmokit@1.8.3/package.json
vendor/npm/schemastery@3.18.2/package.json
vendor/npm/@deepseek-ai/$PIN/package.json
$(cd runtime/spike && find vendor/dsh/agent@0.1.6-alpha.2 \
    vendor/dsh/agent-loop@0.1.6-alpha.2 \
    vendor/dsh/brand@0.1.6-alpha.2 \
    vendor/dsh/llm@0.1.6-alpha.2 \
    vendor/dsh/sandbox@0.1.6-alpha.2 \
    vendor/dsh/scope@0.1.6-alpha.2 \
    vendor/dsh/session@0.1.6-alpha.2 \
    vendor/dsh/session-projection@0.1.6-alpha.2 \
    vendor/dsh/settings@0.1.6-alpha.2 \
    vendor/dsh/system-prompt@0.1.6-alpha.2 \
    vendor/dsh/timeout@0.1.6-alpha.2 \
    vendor/dsh/tools@0.1.6-alpha.2 \
    vendor/dsh/typert-protocol@0.1.6-alpha.2 \
    vendor/dsh/util-values@0.1.6-alpha.2 \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.json' \) -type f | LC_ALL=C sort)
vendor/npm/zod@4.4.3/index.js
vendor/npm/zod@4.4.3/v4/classic/checks.js
vendor/npm/zod@4.4.3/v4/classic/coerce.js
vendor/npm/zod@4.4.3/v4/classic/compat.js
vendor/npm/zod@4.4.3/v4/classic/errors.js
vendor/npm/zod@4.4.3/v4/classic/external.js
vendor/npm/zod@4.4.3/v4/classic/from-json-schema.js
vendor/npm/zod@4.4.3/v4/classic/iso.js
vendor/npm/zod@4.4.3/v4/classic/parse.js
vendor/npm/zod@4.4.3/v4/classic/schemas.js
vendor/npm/zod@4.4.3/v4/core/api.js
vendor/npm/zod@4.4.3/v4/core/checks.js
vendor/npm/zod@4.4.3/v4/core/core.js
vendor/npm/zod@4.4.3/v4/core/doc.js
vendor/npm/zod@4.4.3/v4/core/errors.js
vendor/npm/zod@4.4.3/v4/core/index.js
vendor/npm/zod@4.4.3/v4/core/json-schema-generator.js
vendor/npm/zod@4.4.3/v4/core/json-schema-processors.js
vendor/npm/zod@4.4.3/v4/core/json-schema.js
vendor/npm/zod@4.4.3/v4/core/parse.js
vendor/npm/zod@4.4.3/v4/core/regexes.js
vendor/npm/zod@4.4.3/v4/core/registries.js
vendor/npm/zod@4.4.3/v4/core/schemas.js
vendor/npm/zod@4.4.3/v4/core/to-json-schema.js
vendor/npm/zod@4.4.3/v4/core/util.js
vendor/npm/zod@4.4.3/v4/core/versions.js
vendor/npm/zod@4.4.3/v4/locales/ar.js
vendor/npm/zod@4.4.3/v4/locales/az.js
vendor/npm/zod@4.4.3/v4/locales/be.js
vendor/npm/zod@4.4.3/v4/locales/bg.js
vendor/npm/zod@4.4.3/v4/locales/ca.js
vendor/npm/zod@4.4.3/v4/locales/cs.js
vendor/npm/zod@4.4.3/v4/locales/da.js
vendor/npm/zod@4.4.3/v4/locales/de.js
vendor/npm/zod@4.4.3/v4/locales/el.js
vendor/npm/zod@4.4.3/v4/locales/en.js
vendor/npm/zod@4.4.3/v4/locales/eo.js
vendor/npm/zod@4.4.3/v4/locales/es.js
vendor/npm/zod@4.4.3/v4/locales/fa.js
vendor/npm/zod@4.4.3/v4/locales/fi.js
vendor/npm/zod@4.4.3/v4/locales/fr-CA.js
vendor/npm/zod@4.4.3/v4/locales/fr.js
vendor/npm/zod@4.4.3/v4/locales/he.js
vendor/npm/zod@4.4.3/v4/locales/hr.js
vendor/npm/zod@4.4.3/v4/locales/hu.js
vendor/npm/zod@4.4.3/v4/locales/hy.js
vendor/npm/zod@4.4.3/v4/locales/id.js
vendor/npm/zod@4.4.3/v4/locales/index.js
vendor/npm/zod@4.4.3/v4/locales/is.js
vendor/npm/zod@4.4.3/v4/locales/it.js
vendor/npm/zod@4.4.3/v4/locales/ja.js
vendor/npm/zod@4.4.3/v4/locales/ka.js
vendor/npm/zod@4.4.3/v4/locales/kh.js
vendor/npm/zod@4.4.3/v4/locales/km.js
vendor/npm/zod@4.4.3/v4/locales/ko.js
vendor/npm/zod@4.4.3/v4/locales/lt.js
vendor/npm/zod@4.4.3/v4/locales/mk.js
vendor/npm/zod@4.4.3/v4/locales/ms.js
vendor/npm/zod@4.4.3/v4/locales/nl.js
vendor/npm/zod@4.4.3/v4/locales/no.js
vendor/npm/zod@4.4.3/v4/locales/ota.js
vendor/npm/zod@4.4.3/v4/locales/pl.js
vendor/npm/zod@4.4.3/v4/locales/ps.js
vendor/npm/zod@4.4.3/v4/locales/pt.js
vendor/npm/zod@4.4.3/v4/locales/ro.js
vendor/npm/zod@4.4.3/v4/locales/ru.js
vendor/npm/zod@4.4.3/v4/locales/sl.js
vendor/npm/zod@4.4.3/v4/locales/sv.js
vendor/npm/zod@4.4.3/v4/locales/ta.js
vendor/npm/zod@4.4.3/v4/locales/th.js
vendor/npm/zod@4.4.3/v4/locales/tr.js
vendor/npm/zod@4.4.3/v4/locales/ua.js
vendor/npm/zod@4.4.3/v4/locales/uk.js
vendor/npm/zod@4.4.3/v4/locales/ur.js
vendor/npm/zod@4.4.3/v4/locales/uz.js
vendor/npm/zod@4.4.3/v4/locales/vi.js
vendor/npm/zod@4.4.3/v4/locales/yo.js
vendor/npm/zod@4.4.3/v4/locales/zh-CN.js
vendor/npm/zod@4.4.3/v4/locales/zh-TW.js"
CLOSURE="$CLOSURE
$SPINE_OURS
llm.js
scenario/llm-live-stream.js"
if [ "$MODE" != "check" ]; then
    for rel in $CLOSURE; do
        mkdir -p "$RAW/$(dirname "$rel")"
        cp "runtime/spike/$rel" "$RAW/$rel"
    done
fi

# The self-hosted web clients (presentation/web-client-{next,whale}):
# whole-tree copies into rawfile/spike/webclient/dsh-web-client-*, the same
# sync+check discipline as the closure — the older v0 webclient/
# dsh-web-client hand-commit predates this script's coverage and stays as-is.
WEBCLIENT_DIRS="next whale"
webclient_files() {
    (cd "presentation/web-client-$1" && find . -type f) |
        while IFS= read -r rel; do echo "webclient/dsh-web-client-$1/${rel#./}"; done
}
if [ "$MODE" != "check" ]; then
    for dir in $WEBCLIENT_DIRS; do
        webclient_files "$dir" | while IFS= read -r rel; do
            mkdir -p "$RAW/$(dirname "$rel")"
            cp "presentation/web-client-$dir/${rel#webclient/dsh-web-client-$dir/}" "$RAW/$rel"
        done
    done
fi

echo "vendor-official: byte-verifying the closure copies"
DRIFT=$(mktemp)
SKIPS_FILE=$(mktemp)
trap 'rm -f "$DRIFT" "$SKIPS_FILE"' EXIT
# In --check mode the comparison judges only the files the repo TRACKS: parts
# of the vendored closure (the zod runtime files, .gitignore) are deliberately
# untracked and materialized by THIS script at build time — a fresh checkout
# legitimately lacks them. Untracked-but-closure files surface as a counted
# SKIP, never as drift and never invisibly. The skip marker lands in a file
# because the verify loops run in subshell pipes — a counter there never
# reaches this shell (the android twin's own lesson).
TRACKED=""
if [ "$MODE" = "check" ]; then
    # git prints repo-relative paths and $RAW is repo-relative — same base,
    # compared as-is (the android twin had an absolute/relative mismatch
    # that silently skipped everything; this is why the probes exist).
    TRACKED=$(git ls-files "$RAW")
fi
for rel in $CLOSURE; do
    if [ "$MODE" = "check" ] && [ -n "$TRACKED" ] &&
       ! printf '%s\n' "$TRACKED" | grep -qxF "$RAW/$rel"; then
        echo skip >> "$SKIPS_FILE"
        continue
    fi
    cmp -s "runtime/spike/$rel" "$RAW/$rel" || echo "$rel" >> "$DRIFT"
done
# The web-client trees byte-verify against their presentation/ source (the
# tracked-check rule above applies: untracked staged files SKIP, never drift).
for dir in $WEBCLIENT_DIRS; do
    webclient_files "$dir" | while IFS= read -r rel; do
        if [ "$MODE" = "check" ] && [ -n "$TRACKED" ] &&
           ! printf '%s\n' "$TRACKED" | grep -qxF "$RAW/$rel"; then
            echo skip >> "$SKIPS_FILE"
            continue
        fi
        src="presentation/web-client-$dir/${rel#webclient/dsh-web-client-$dir/}"
        cmp -s "$src" "$RAW/$rel" || echo "$rel" >> "$DRIFT"
    done
done
if [ -s "$DRIFT" ]; then
    while IFS= read -r rel; do echo "::error::rawfile closure drift: $rel"; done < "$DRIFT"
    echo "::error::rawfile closure drifted (re-run build/build.sh sync harmony, or vendor-official.sh)" >&2
    exit 1
fi

if [ "$MODE" = "check" ]; then
    SKIPS=$(wc -l < "$SKIPS_FILE" | tr -d ' ')
    echo "vendor-official: closure verified in place (check mode, no writes, $SKIPS untracked-but-closure file(s) skipped — materialized at build time)"
    exit 0
fi
files=$(find "$RAW/officialweb" -type f | wc -l | tr -d ' ')
closure_count=$(printf '%s\n' "$CLOSURE" | grep -c .)
echo "vendor-official: rawfile fresh (officialweb: $files files, closure: $closure_count files, byte-verified)"
node hosts/harmony/ci/check-bundle-files.mjs
