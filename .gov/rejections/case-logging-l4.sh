#!/usr/bin/env bash
# gate: logging
# Proves L4 sees the violation the 2026-09-21 audit found: the canonical TS
# logger carries the `__DSH_RELEASE__` branch while the OPERATIVE logger
# (runtime/spike/logger.js — the one embedded into all three hosts) has no
# branch at all and no build config defines the flag. The old L4 checked only
# that the STRING appeared under runtime/logger/, so this exact tree passed
# green; now it must go red on L4b and L4c.
#
# Positive control in the same case: the identical tree WITH the operative
# branch and the plumbing markers must pass — a check that is always red
# proves nothing either.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fixture() { # $1 = dir, $2 = operative-branch (yes/no), $3 = plumbing (yes/no)
  local dir="$1" branch="$2" plumbing="$3"
  mkdir -p "$dir/runtime/logger" "$dir/runtime/spike/host" \
           "$dir/hosts/ios/DSHSpike.xcodeproj" "$dir/hosts/android/app" \
           "$dir/hosts/harmony/entry"
  cd "$dir"
  git init -q .
  # The canonical logger always carries the branch — that is the audit state.
  cat > runtime/logger/index.ts <<'TS'
// dsh:logging-exempt (this IS a logger fixture)
declare const __DSH_RELEASE__: boolean;
export function createLogger(module: string): object {
  if (typeof __DSH_RELEASE__ !== 'undefined' && __DSH_RELEASE__) {
    return {};
  }
  return {};
}
TS
  if [ "$branch" = yes ]; then
    cat > runtime/spike/logger.js <<'JS'
// dsh:logging-exempt (this IS a logger fixture)
export function createLogger(module) {
  if (globalThis.__DSH_RELEASE__ === true) {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }
  return { debug() {}, info() {}, warn() {}, error() {} };
}
JS
  else
    cat > runtime/spike/logger.js <<'JS'
// dsh:logging-exempt (this IS a logger fixture)
export function createLogger(module) {
  return { debug() {}, info() {}, warn() {}, error() {} };
}
JS
  fi
  if [ "$plumbing" = yes ]; then
    echo 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = DSH_RELEASE;' \
      > hosts/ios/DSHSpike.xcodeproj/project.pbxproj
    echo 'externalNativeBuild { cmake { cFlags += "-DDSH_RELEASE=1" } }' \
      > hosts/android/app/build.gradle.kts
    echo '"DSH_RELEASE": true' > hosts/harmony/entry/build-profile.json5
    echo '-DDSH_RELEASE=1' > runtime/spike/host/build.sh
  else
    : > hosts/ios/DSHSpike.xcodeproj/project.pbxproj
    : > hosts/android/app/build.gradle.kts
    : > hosts/harmony/entry/build-profile.json5
    : > runtime/spike/host/build.sh
  fi
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm fixture
  cd - >/dev/null
}

# 1. The audit tree: canonical branch only, operative logger unconditional,
#    no build config defining the flag.
fixture "$TMP/audit" no no
cd "$TMP/audit"
if python3 "$REPO/tools/check-logging.py" > out.txt 2>&1; then
  echo "case-logging-l4: FAIL — the cosmetic release strip passed green" >&2
  cat out.txt >&2
  exit 1
fi
grep -q "L4b does not honor" out.txt || {
  echo "case-logging-l4: L4b (operative logger) not flagged" >&2; cat out.txt >&2; exit 1; }
grep -q "L4c" out.txt || {
  echo "case-logging-l4: L4c (no build config defines the flag) not flagged" >&2
  cat out.txt >&2; exit 1; }
cd - >/dev/null

# 2. Positive control: same tree, real branch + real plumbing → green.
fixture "$TMP/wired" yes yes
cd "$TMP/wired"
if ! python3 "$REPO/tools/check-logging.py" > out2.txt 2>&1; then
  echo "case-logging-l4: FAIL — a correctly wired tree was rejected" >&2
  cat out2.txt >&2
  exit 1
fi
cd - >/dev/null

echo "case-logging-l4: cosmetic release strip rejected (L4b + L4c); wired tree accepted"
