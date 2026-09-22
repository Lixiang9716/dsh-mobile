#!/usr/bin/env bash
# tools/e2e/selftest.sh — proves the checker logic against the synthetic
# fixtures in testdata/ (rule 6: a gate that never fails is vacuous).
#
#   positive:  m2-gateway.positive.txt must PASS m2-gateway-binding.json AND
#              m2-gateway-audit.json (one file drives both, proving the two
#              extraction prefixes isolate their streams).
#   negative:  m2-gateway-binding.negative.txt must FAIL at expected index 4
#              (fs.denied code); m2-gateway-audit.negative.txt must FAIL at
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
  if node tools/e2e/check.mjs --manifest "$1" --log "$2" --out "$TMP/v.json" >/dev/null 2>&1; then
    echo "selftest: PASS  $(basename "$1") accepts $(basename "$2")"
  else
    echo "selftest: FAIL  $(basename "$1") should accept $(basename "$2")"; FAILURES=$((FAILURES + 1))
  fi
}

expect_fail_at() { # $1=manifest $2=log $3=expected first failure index
  if node tools/e2e/check.mjs --manifest "$1" --log "$2" --out "$TMP/v.json" >/dev/null 2>&1; then
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

expect_parse_error() { # $1=manifest $2=log — the verdict must fail WITH a parseError
  if node tools/e2e/check.mjs --manifest "$1" --log "$2" --out "$TMP/v.json" >/dev/null 2>&1; then
    echo "selftest: FAIL  $(basename "$1") should reject $(basename "$2")"; FAILURES=$((FAILURES + 1)); return 0
  fi
  local count
  count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("parseErrors", [])))' "$TMP/v.json")
  if [ "$count" -gt 0 ]; then
    echo "selftest: PASS  $(basename "$1") rejects $(basename "$2") with $count parseError(s) (as expected)"
  else
    echo "selftest: FAIL  $(basename "$1") rejects $(basename "$2") without a parseError"; FAILURES=$((FAILURES + 1))
  fi
}

BIND=tools/e2e/scenarios/m2-gateway-binding.json
AUDIT=tools/e2e/scenarios/m2-gateway-audit.json
TD=tools/e2e/testdata

expect_pass "$BIND" "$TD/m2-gateway.positive.txt"
expect_pass "$AUDIT" "$TD/m2-gateway.positive.txt"
expect_fail_at "$BIND" "$TD/m2-gateway-binding.negative.txt" 4
expect_fail_at "$AUDIT" "$TD/m2-gateway-audit.negative.txt" 2
# Regression guard: the flat-envelope change must not disturb the logger
# envelope — the slimmed m1 fixture (derived from the committed M1 capture,
# non-deterministic fields stripped) still passes its manifest.
expect_pass tools/e2e/scenarios/m1-spike-boot.json tools/e2e/testdata/m1-spike-boot.positive.txt
# Repeat expectations (the real-LLM legs' nondeterministic delta counts):
# one-or-more deltas at the repeated position pass; ZERO deltas fail AT the
# repeat expectation; a delta straying past stream.completed is extra.
REPEAT=tools/e2e/testdata/m2-llm-repeat.json
expect_pass "$REPEAT" "$TD/m2-llm-repeat.positive.txt"
expect_fail_at "$REPEAT" "$TD/m2-llm-repeat.negative-zero.txt" 1
expect_fail_at "$REPEAT" "$TD/m2-llm-repeat.negative-extra.txt" none
# order:"any" expectations (records whose position races other recorded
# events, e.g. the b4 journal attach among the page's concurrent RPC
# answers): a mid-burst record is claimed wherever it sits; a MISSING record
# fails at the any-row; a DUPLICATE leaves one as extra.
ANY=tools/e2e/testdata/order-any.json
expect_pass "$ANY" "$TD/order-any.positive.txt"
expect_fail_at "$ANY" "$TD/order-any.negative-missing.txt" -1
expect_fail_at "$ANY" "$TD/order-any.negative-extra.txt" 2
# Host-side notes (a drive declaring its launch env before the entry module
# runs): the canonical envelope under the reserved host.launch scenario id is
# FILTERED out of every scenario's stream, while free text after the prefix
# is a parse error against every scenario riding the capture — the exact
# shape that reddened both m1 verdicts on dev/ios (run 35756986102).
expect_pass tools/e2e/scenarios/m1-spike-boot.json "$TD/host-note.positive.txt"
expect_parse_error tools/e2e/scenarios/m1-spike-boot.json "$TD/host-note.negative-free-text.txt"

if [ "$FAILURES" -gt 0 ]; then
  echo "selftest: $FAILURES failure(s)"; exit 1
fi
echo "selftest: all checker assertions hold"
