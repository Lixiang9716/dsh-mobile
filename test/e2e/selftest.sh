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

if [ "$FAILURES" -gt 0 ]; then
  echo "selftest: $FAILURES failure(s)"; exit 1
fi
echo "selftest: all checker assertions hold"
