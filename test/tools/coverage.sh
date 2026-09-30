#!/bin/sh
# coverage.sh — the tools-face coverage, as two real passes (each attribute
# a face the other cannot see; both run the full suite):
#
#   pass 1  vitest's own v8 provider — the IN-PROCESS face: the modules the
#           tests import directly (plugins-route.mjs, the fixture helper).
#   pass 2  c8 with a preset NODE_V8_COVERAGE — the CHILD-PROCESS face: the
#           staging tools run as spawned CLIs against the hermetic fixture
#           repos and the real checkout; vitest 4's provider never exposes
#           NODE_V8_COVERAGE (probed: unset inside tests), so the children
#           are invisible to pass 1 and vice versa the in-process imports
#           are invisible to pass 2 (vitest workers do not dump).
#
# usage: test/tools/coverage.sh     (from anywhere; reports to stdout)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
VITEST="$HERE/node_modules/.bin/vitest"
C8="$HERE/node_modules/.bin/c8"

echo "== pass 1: in-process face (vitest v8 provider) =="
cd "$HERE"
"$VITEST" run --coverage

echo
echo "== pass 2: child-process face (c8 over the spawned CLIs) =="
RAW=$(mktemp -d)
trap 'rm -rf "$RAW"' EXIT
cd "$REPO"
NODE_V8_COVERAGE="$RAW" "$C8" \
  --include 'tools/**' \
  --exclude 'tools/**/*.test.mjs' \
  --exclude 'tools/dev-web-carrier/dev-carrier.mjs' \
  --exclude 'tools/dev-web-carrier/next-mode.mjs' \
  --exclude 'tools/dev-web-carrier/compose-boot.mjs' \
  --exclude 'tools/dev-web-carrier/ws-lite.mjs' \
  --reporter text \
  "$VITEST" run -c "$HERE/vitest.config.mjs"
