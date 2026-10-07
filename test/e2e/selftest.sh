#!/usr/bin/env bash
# test/e2e/selftest.sh — proves the checker logic against the synthetic
# fixtures in testdata/ (rule 6: a gate that never fails is vacuous).
#
#   positive:  gateway.positive.txt must PASS gateway-binding.json AND
#              gateway-audit.json (one file drives both, proving the two
#              extraction prefixes isolate their streams).
#   negative:  gateway-binding.negative.txt must FAIL at expected index 4
#              (fs.denied code); gateway-audit.negative.txt must FAIL at
#              expected index 2 (fsRead denied/denied).
#
# usage: selftest.sh   (exit 0 = all assertions hold)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILURES=0

expect_pass() { # $1=manifest $2=log
  if node test/e2e/check.mjs --manifest "$1" --log "$2" --out "$TMP/v.json" >/dev/null 2>&1; then
    echo "selftest: PASS  $(basename "$1") accepts $(basename "$2")"
  else
    echo "selftest: FAIL  $(basename "$1") should accept $(basename "$2")"; FAILURES=$((FAILURES + 1))
  fi
}

expect_fail_at() { # $1=manifest $2=log $3=expected first failure index
  if node test/e2e/check.mjs --manifest "$1" --log "$2" --out "$TMP/v.json" >/dev/null 2>&1; then
    echo "selftest: FAIL  $(basename "$1") should reject $(basename "$2")"; FAILURES=$((FAILURES + 1)); return 0
  fi
  local idx
  idx=$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); f=v.get("failures") or [{}]; print(f[0].get("index", "none"))' "$TMP/v.json")
  if [ "$idx" = "$3" ]; then
    echo "selftest: PASS  $(basename "$1") rejects $(basename "$2") at index $idx (as expected)"
  else
    echo "selftest: FAIL  $(basename "$1") rejects $(basename "$2") at index $idx, expected $3"; FAILURES=$((FAILURES + 1))
  fi
}

BIND=test/e2e/scenarios/gateway-binding.json
AUDIT=test/e2e/scenarios/gateway-audit.json
TD=test/e2e/testdata

expect_pass "$BIND" "$TD/gateway.positive.txt"
expect_pass "$AUDIT" "$TD/gateway.positive.txt"
expect_fail_at "$BIND" "$TD/gateway-binding.negative.txt" 4
expect_fail_at "$AUDIT" "$TD/gateway-audit.negative.txt" 2
# Regression guard: the flat-envelope change must not disturb the logger
# envelope — the slimmed m1 fixture (derived from the committed M1 capture,
# non-deterministic fields stripped) still passes its manifest.
expect_pass test/e2e/scenarios/boot-verification.json test/e2e/testdata/boot-verification.positive.txt
# Repeat expectations (the real-LLM legs' nondeterministic delta counts):
# one-or-more deltas at the repeated position pass; ZERO deltas fail AT the
# repeat expectation; a delta straying past stream.completed is extra.
REPEAT=test/e2e/testdata/llm-live-stream-repeat.json
expect_pass "$REPEAT" "$TD/llm-live-stream-repeat.positive.txt"
expect_fail_at "$REPEAT" "$TD/llm-live-stream-repeat.negative-zero.txt" 1
expect_fail_at "$REPEAT" "$TD/llm-live-stream-repeat.negative-extra.txt" none
# order:"any" expectations (records whose position races other recorded
# events, e.g. the b4 journal attach among the page's concurrent RPC
# answers): a mid-burst record is claimed wherever it sits; a MISSING record
# fails at the any-row; a DUPLICATE leaves one as extra.
ANY=test/e2e/testdata/order-any.json
expect_pass "$ANY" "$TD/order-any.positive.txt"
expect_fail_at "$ANY" "$TD/order-any.negative-missing.txt" -1
expect_fail_at "$ANY" "$TD/order-any.negative-extra.txt" 2

# Layout-truth probe (ui.occlusion, test/e2e/ui-probe.mjs): GEOMETRY enters
# the same assertion currency — the probe emits its record onto the probe
# stream and the SAME checker judges it. The synthetic fixtures reproduce
# the #179 class (a native bar painted over the web surface: log-verified
# drives cannot see it, touches at the dead coordinates never arrive):
#   uiautomator face — the clean (post-fix) tree passes; the action-bar
#   occlusion dump fails AT the probe row, and the failure record NAMES the
#   occluder (that list is the diagnosis); the WDA face round-trips both.
#   A dump without a WebView and an unparsable dump are loud probe errors
#   (exit 2) — a probe that silently scanned nothing is a vacuous pass.
PROBE="node test/e2e/ui-probe.mjs"
UIOC=test/e2e/scenarios/ui-occlusion.json

$PROBE --dump "$TD/ui-probe-clean.uiautomator.xml" --scenario ui.occlusion \
    --append "$TMP/uia-clean.log" >/dev/null
expect_pass "$UIOC" "$TMP/uia-clean.log"

$PROBE --dump "$TD/ui-probe-occlusion.uiautomator.xml" --scenario ui.occlusion \
    --append "$TMP/uia-occ.log" >/dev/null
expect_fail_at "$UIOC" "$TMP/uia-occ.log" 0
grep -q 'DSH Dsh Host' "$TMP/v.json" ||
  { echo "selftest: FAIL  occlusion verdict does not name the occluder"; FAILURES=$((FAILURES + 1)); }

$PROBE --dump "$TD/ui-probe-clean.wda.json" --scenario ui.occlusion \
    --append "$TMP/wda-clean.log" >/dev/null
expect_pass "$UIOC" "$TMP/wda-clean.log"

$PROBE --dump "$TD/ui-probe-occlusion.wda.json" --scenario ui.occlusion \
    --append "$TMP/wda-occ.log" >/dev/null
expect_fail_at "$UIOC" "$TMP/wda-occ.log" 0

$PROBE --dump "$TD/ui-probe-no-webhost.uiautomator.xml" --scenario ui.occlusion \
    --append "$TMP/none.log" >/dev/null 2>&1 &&
  { echo "selftest: FAIL  a dump without a web host must fail loud"; FAILURES=$((FAILURES + 1)); } ||
  echo "selftest: PASS  a dump without a web host fails loud (exit 2)"
printf '<hierarchy><node class="android.webkit.WebView" bounds="[0,0' > "$TMP/broken.xml"
$PROBE --dump "$TMP/broken.xml" --scenario ui.occlusion >/dev/null 2>&1 &&
  { echo "selftest: FAIL  an unparsable dump must fail loud"; FAILURES=$((FAILURES + 1)); } ||
  echo "selftest: PASS  an unparsable dump fails loud (exit 2)"

if [ "$FAILURES" -gt 0 ]; then
  echo "selftest: $FAILURES failure(s)"; exit 1
fi
echo "selftest: all checker assertions hold"
