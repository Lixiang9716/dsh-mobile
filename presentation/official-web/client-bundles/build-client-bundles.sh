#!/usr/bin/env bash
# Reproducible build of the APPLICATION-TIER client bundles (D9 W-SHELL).
#
# Produces exactly the bytes committed under
# presentation/official-web/client-bundles/npm: clone upstream → checkout the
# recorded pin → install with the pinned package manager → build the host and
# client faces (upstream's own scripts, in upstream's own order) → derive the
# browser roster from the web-app patch layer's `dsh.client` closure
# (roster.mjs) → copy the per-package staging allowlist → regenerate
# MANIFEST.sha256.
#
# What gets staged per roster package, and why:
#   - package.json   — the `dsh.client` declaration + `exports["./client"]`
#                      the vendored client-modules node half scans;
#   - lib/client.js  — the published lazy-CJS factory bundle.
# Package-local chunks (`client.<n>.js`, recorded per package in
# ROSTER.json) and source maps are excluded: chunks are off the boot path
# (lazy require.async; pdf.js alone is ~7 MB) and maps fall back to identity
# maps — the same allowlist choices as the dist vendoring, each a named gap
# rather than a fake.
#
# Upstream repos are read-only inputs: nothing is modified, nothing upstream
# is committed back. Pins and digests are recorded in PROVENANCE.md.
#
# usage: ./build-client-bundles.sh [<upstream-commit>]   (default: the pin)
#
# The work dir is a FIXED path (not mktemp): the upstream build embeds the
# absolute source path in its outputs (`//#region dsh-css:<abs-path>` comments
# and the css-module class-name hashes derive from it), so a random temp dir
# would change the bundle bytes on every run and MANIFEST.sha256 could never
# verify a rebuild. The committed bytes were produced at this exact path.
set -euo pipefail

PIN="${1:-ddefc45fbc7f8e46dd73185e68295696d1297887}"  # dsh-v0.1.6-alpha.2
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="/tmp/dsh-harness-src"
trap 'rm -rf "$WORK"' EXIT

echo "==> clone $UPSTREAM_URL @ $PIN into $WORK"
git clone "$UPSTREAM_URL" "$WORK"
git -C "$WORK" checkout --quiet "$PIN"

cd "$WORK"

echo "==> pin sanity: package.json version must be 0.1.6-alpha.2"
version="$(node -p "require('./package.json').version")"
[ "$version" = "0.1.6-alpha.2" ] || { echo "FATAL: unexpected version $version at $PIN" >&2; exit 1; }

echo "==> install (pnpm per the repo packageManager field; skip browser downloads)"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
corepack pnpm install --frozen-lockfile

echo "==> upstream build:lib:host (the client face type-checks against the host face's typert augmentations)"
corepack pnpm run build:lib:host

echo "==> upstream build:lib:client (tsdown --env.DSH_BUILD_FACE client: emits each package's lib/client.js factory bundle)"
corepack pnpm run build:lib:client

echo "==> derive the browser roster from the web-app patch layer (dsh.client closure)"
node "$HERE/roster.mjs" "$WORK" "$HERE/ROSTER.json.tmp"

echo "==> copy the staged allowlist into $HERE/npm"
rm -rf "$HERE/npm" && mkdir -p "$HERE/npm"
node - "$HERE/ROSTER.json.tmp" "$HERE/npm" <<'COPY'
const { readFileSync, mkdirSync, copyFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const roster = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const destRoot = process.argv[3];
for (const entry of roster.entries) {
  // Layout mirrors the E2E staging tree (Documents/web-plugins/npm/...): the
  // runner copies this directory verbatim into the app container.
  const dest = join(destRoot, `${entry.name}@${entry.version}`);
  for (const file of entry.files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    copyFileSync(join(entry.dir, file), join(dest, file));
  }
}
COPY

echo "==> copy the roster record (reproducibility evidence)"
mv "$HERE/ROSTER.json.tmp" "$HERE/ROSTER.json"

echo "==> regenerate MANIFEST.sha256"
# LC_ALL=C pins the sort collation: a manifest generated under another
# locale lists the same digests in a different order and shasum -c
# (order-sensitive) then fails on the other platform.
( cd "$HERE/npm" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 ) > "$HERE/MANIFEST.sha256"

echo "==> done"
( cd "$HERE/npm" && shasum -a 256 -c "$HERE/MANIFEST.sha256" ) >/dev/null && echo "manifest verifies clean"
shasum -a 256 "$HERE/MANIFEST.sha256"
echo "Review the diff, update PROVENANCE.md digests, and commit."
