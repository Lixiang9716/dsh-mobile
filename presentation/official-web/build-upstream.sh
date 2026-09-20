#!/usr/bin/env bash
# Reproducible build of the OFFICIAL upstream web app dist (D9/D3).
#
# Produces exactly the bytes committed under presentation/official-web/dist:
# clone upstream → checkout the recorded pin → install with the pinned
# package manager → build the prerequisite workspace faces (upstream's own
# scripts, in upstream's own order) → `vite build` for apps/web → copy the
# published allowlist → regenerate MANIFEST.sha256.
#
# Upstream repos are read-only inputs: nothing is modified, nothing upstream
# is committed back. Pins and digests are recorded in PROVENANCE.md.
#
# Usage:  ./build-upstream.sh [<upstream-commit>]   (default: the PROVENANCE pin)
set -euo pipefail

PIN="${1:-ddefc45fbc7f8e46dd73185e68295696d1297887}"  # dsh-v0.1.6-alpha.2
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d /tmp/dsh-official-web-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "==> clone $UPSTREAM_URL @ $PIN into $WORK"
git clone "$UPSTREAM_URL" "$WORK/deepseek-harness"
git -C "$WORK/deepseek-harness" checkout --quiet "$PIN"

cd "$WORK/deepseek-harness"

echo "==> pin sanity: package.json version must be 0.1.6-alpha.2"
version="$(node -p "require('./package.json').version")"
[ "$version" = "0.1.6-alpha.2" ] || { echo "FATAL: unexpected version $version at $PIN" >&2; exit 1; }

echo "==> install (pnpm per the repo packageManager field; skip browser downloads)"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
corepack pnpm install --frozen-lockfile

echo "==> prerequisite: experimental webworker runtime (imported by apps/web preview.ts)"
corepack pnpm --filter @deepseek-ai/dsh-experimental-webworker-runtime exec tsdown

echo "==> upstream build:lib:host (tsc host face + tsdown; emits the typert augmentations the client face type-checks against)"
corepack pnpm run build:lib:host

echo "==> upstream build:lib:client (tsc client face + tsdown: builds @deepseek-ai/dsh-client-web et al.)"
corepack pnpm run build:lib:client

echo "==> upstream build:web (vite build for @deepseek-ai/dsh-web-frontend)"
corepack pnpm run build:web

echo "==> copy published allowlist into $HERE/dist (upstream files: dist minus *.map, preview.html, preview/)"
rm -rf "$HERE/dist" && mkdir -p "$HERE/dist"
(cd apps/web/dist && find . -type f \
  ! -name '*.map' ! -path './preview/*' ! -name 'preview.html' -print0 \
  | tar --null -cf - -T -) | (cd "$HERE/dist" && tar -xf -)

echo "==> regenerate MANIFEST.sha256"
# LC_ALL=C pins the sort collation: a manifest generated under another
# locale lists the same digests in a different order and shasum -c
# (order-sensitive) then fails on the other platform.
( cd "$HERE/dist" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 ) > "$HERE/MANIFEST.sha256"

echo "==> done"
( cd "$HERE/dist" && shasum -a 256 -c ../MANIFEST.sha256 ) >/dev/null && echo "manifest verifies clean"
shasum -a 256 "$HERE/MANIFEST.sha256"
echo "Review the diff, update PROVENANCE.md digests, and commit."
