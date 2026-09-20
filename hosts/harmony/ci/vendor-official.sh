#!/bin/sh
# vendor-official.sh — materialize the D9 official-web mount assets into the
# app's rawfile tree (hosts/harmony rawfile is COMMITTED, so the HAP is
# self-contained: the carrier serves the official dist + /plugins bundles
# straight from rawfile bytes, and the web-boot runtime half loads the
# vendored closure the same way).
#
# Sources (all untracked trees materialized + sha256-verified by their
# ensure scripts — the tracked provenance record):
#   tools/e2e/ensure-official-dist.sh  → presentation/official-web/dist
#   tools/e2e/ensure-client-bundles.sh → presentation/official-web/client-bundles/npm
#   runtime/spike/vendor/ensure-dsh.sh → runtime/spike/vendor/npm (the pinned
#     @deepseek-ai/dsh-client-modules wins for the bootstrap package, the
#     same precedence tools/e2e/run-ios-b1.sh applies on iOS)
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
#
# Every copied file is byte-verified (cmp) against its source; the closure
# files additionally carry a shasum check in ci/run-host-e2e.sh's build step.
# usage: hosts/harmony/ci/vendor-official.sh   exit 0 = rawfile fresh
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
RAW=hosts/harmony/entry/src/main/resources/rawfile/spike

echo "vendor-official: ensuring the source trees"
tools/e2e/ensure-official-dist.sh
tools/e2e/ensure-client-bundles.sh
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
echo "vendor-official: rawfile fresh (officialweb: $files files, closure: $(echo "$CLOSURE" | wc -l | tr -d ' ') files, byte-verified)"
