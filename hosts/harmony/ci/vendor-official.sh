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
#     same precedence test/e2e/run-ios-b1.sh applies on iOS)
#
# Layout under entry/src/main/resources/rawfile/spike/:
#   officialweb/www/…                     ← the official dist (www: the repo
#                                            .gitignore excludes any dist/
#                                            dir, so the rawfile copy carries
#                                            a neutral name; bytes verbatim)
#   officialweb/plugins/npm/@deepseek-ai/… ← the staged client bundles
#   scenario/b1-web-live.js, upstream/…, vendor/npm/… ← the web-boot closure
#     (byte-identical to the runtime/spike canonicals — the m5 surprise
#     ledger: drift in these copies is silent)
#   + the W-SESS SPINE closure (b-harmony.session.live): the mobile profile
#     boot, its settings backend, the gateway llm transport, the session-live
#     scenario, the spine shims beyond the web-boot set, and the vendored
#     upstream spine packages (14 verbatim lib/ trees + package.json each)
#     with the pinned zod's classic closure — the same file set iOS embeds
#     via gen_bundle_header.py tree mode (172 tree files + the authored
#     spine files). #56-class drift guard: ci/check-bundle-files.mjs
#     cross-checks this list against Index.ets's BUNDLE_FILES.
#   + the m2.llm real-LLM leg closure (W-HARMONY5): scenario/m2-llm.js and
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

echo "vendor-official: ensuring the source trees"
test/e2e/ensure-official-dist.sh
test/e2e/ensure-client-bundles.sh
runtime/spike/vendor/ensure-dsh.sh > /dev/null

PIN=dsh-client-modules@0.1.6-alpha.2
VENDORED="runtime/spike/vendor/npm/@deepseek-ai/$PIN"
[ -f "$VENDORED/lib/client.js" ] || {
    echo "::error::vendored bootstrap package missing ($VENDORED)" >&2
    exit 1
}

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

# The web-boot closure (b1-web-live drive): the adapter, its shims, and the
# vendored npm libs the client-modules composition imports — the exact
# bundle-root relative paths the C loader's bare map resolves.
CLOSURE="scenario/b1-web-live.js
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
vendor/npm/@deepseek-ai/$PIN/lib/client.js"

# The W-SESS spine closure (b-harmony.session.live): OUR authored spine
# files first, then the vendored upstream trees — generated from the
# materialized vendor checkout (suffix filter .js/.mjs/.json, sorted, the
# same rule as hosts/ios/Tools/gen_bundle_header.py collect_tree_files).
SPINE_OURS="scenario/harmony-session-live.js
scenario/harmony-write-live.js
upstream/boot.js
upstream/settings-memory.js
upstream/llm-transport.js
upstream/web-write.js
upstream/web-write-settings.js
upstream/web-write-streams.js
upstream/shims/async-hooks.js
upstream/shims/util.js
upstream/shims/util-types.js
upstream/shims/os.js
upstream/shims/process.js
upstream/shims/dsh-session-persistence.js"
SPINE_PKG_DSH="agent agent-loop brand llm sandbox scope session session-projection settings system-prompt timeout tools typert-protocol util-values"
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
scenario/m2-llm.js"
for rel in $CLOSURE; do
    mkdir -p "$RAW/$(dirname "$rel")"
    cp "runtime/spike/$rel" "$RAW/$rel"
done

echo "vendor-official: byte-verifying the closure copies"
for rel in $CLOSURE; do
    cmp -s "runtime/spike/$rel" "$RAW/$rel" || {
        echo "::error::rawfile closure drift: $rel (re-run vendor-official.sh)" >&2
        exit 1
    }
done

files=$(find "$RAW/officialweb" -type f | wc -l | tr -d ' ')
closure_count=$(printf '%s\n' "$CLOSURE" | grep -c .)
echo "vendor-official: rawfile fresh (officialweb: $files files, closure: $closure_count files, byte-verified)"
node hosts/harmony/ci/check-bundle-files.mjs
