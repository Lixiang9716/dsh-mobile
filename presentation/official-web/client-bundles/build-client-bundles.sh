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
# and the css-module `[hash]` — lightningcss hashes the absolute virtual
# filename), so a random temp dir would change the bundle bytes on every run.
# It also means the bytes are bound to THIS PATH'S REALPATH: /tmp is
# /private/tmp on macOS, so a macOS build and the Linux CI build differ in
# exactly the files that embed it (measured: 40 of 116). This script therefore
# writes its own record to MANIFEST.sha256.computed and COMPARES it against the
# committed MANIFEST.sha256 with verify-manifest.mjs — it never renews the
# committed record, because a build that re-issues its own certificate is not a
# verification (D15). Refresh the record deliberately, after reviewing the diff:
#   cp MANIFEST.sha256.computed MANIFEST.sha256   (and update PROVENANCE.md)
set -euo pipefail

PIN="${1:-ddefc45fbc7f8e46dd73185e68295696d1297887}"  # dsh-v0.1.6-alpha.2
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="/tmp/dsh-harness-src"
# The embedded path is the REALPATH: on macOS /tmp is a symlink to /private/tmp,
# so the bytes a macOS build emits differ from the Linux CI build's in exactly
# the files that embed it. Pass the resolved path to the comparison so it names
# the class it is comparing against. Resolved before the clone, so the
# directory exists by the time `pwd -P` runs.
mkdir -p "$WORK"
WORK_REAL="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

echo "==> clone $UPSTREAM_URL @ $PIN into $WORK"
# Local-submodule-first, same as build-upstream.sh: the pinned submodule is
# the SAME commit, and a full GitHub clone is the transfer that dies
# mid-sideband on a flaky link (curl 92/18 early EOF, measured 2026-09-24).
SUBMODULE="$HERE/../../../third-party/deepseek-harness"
if git -C "$SUBMODULE" cat-file -e "$PIN" 2>/dev/null; then
  echo "==> local submodule carries the pin — cloning from it (no network)"
  git clone "$SUBMODULE" "$WORK"
else
  git clone "$UPSTREAM_URL" "$WORK"
fi
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

echo "==> write this build's record to MANIFEST.sha256.computed"
# LC_ALL=C pins the sort collation: a record generated under another locale
# lists the same digests in a different order and shasum -c (order-sensitive)
# then fails on the other platform.
( cd "$HERE/npm" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 ) \
    > "$HERE/MANIFEST.sha256.computed"

echo "==> compare it against the committed reference record"
( cd "$HERE/npm" && shasum -a 256 -c "$HERE/MANIFEST.sha256.computed" ) >/dev/null \
    && echo "this build's own record verifies clean"
if ! node "$HERE/verify-manifest.mjs" --tree "$HERE/npm" \
        --reference "$HERE/MANIFEST.sha256" --work "$WORK_REAL"; then
    echo "the rebuilt tree diverges from the committed reference OUTSIDE the" >&2
    echo "embedded-work-path class — a real byte change, not an environment" >&2
    echo "difference. Read the diff before re-recording anything:" >&2
    echo "    diff <(sort $HERE/MANIFEST.sha256) <(sort $HERE/MANIFEST.sha256.computed)" >&2
    exit 1
fi

echo "==> done"
echo "The committed MANIFEST.sha256 was NOT touched. If the comparison above"
echo "reported a divergence outside the work-path class it failed; otherwise the"
echo "reference record still describes this tree. To re-record it deliberately,"
echo "after reviewing the diff:"
echo "    cp $HERE/MANIFEST.sha256.computed $HERE/MANIFEST.sha256"
echo "and update PROVENANCE.md in the same change."
