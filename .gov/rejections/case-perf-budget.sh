#!/usr/bin/env sh
# gate: perf-budget
# Rule-6 proof that the perf-budget comparison has teeth. Fully sandboxed:
# the budgets file is COPIED to a temp dir and the receipts live under a
# temp artifacts root (the checker's --budgets / --artifacts-root flags),
# so this case never opens a mutation window on the real tree — a SIGKILLed
# case leaves no residue by construction, and no live-tree lock is needed.
# Proves: margins pressed below the recorded baselines fail naming every
# metric, a missing receipt fails loud (rule 5, never a silent pass), and
# the real budgets pass the real receipts.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The base budgets are the REAL ones — reading them also proves they parse.
cp "$REPO/baselines/perf-baseline.json" "$TMP/budgets.json"

must_refuse_naming() { # $1 = the detail the red must name
  if node "$REPO/tools/check-perf-budget.mjs" \
       --budgets "$TMP/budgets.json" --artifacts-root "$ART_ROOT" >"$TMP/out" 2>&1
  then
    echo "case-perf-budget: FAIL — over-margin state passed" >&2
    exit 1
  fi
  grep -qF "$1" "$TMP/out" || {
    echo "case-perf-budget: red but does not name '$1'" >&2
    exit 1
  }
}
green() {
  node "$REPO/tools/check-perf-budget.mjs" \
       --budgets "$TMP/budgets.json" --artifacts-root "$ART_ROOT" >"$TMP/out" 2>&1 || {
    echo "case-perf-budget: FAIL — within-margin state rejected" >&2
    exit 1
  }
}

# The real committed receipts are the measurements under audit (the
# real-tree READ is the point: the gate audits committed evidence).
ART_ROOT="$REPO"

# 1. the falsification shape: every margin pressed BELOW its recorded
#    baseline → all metrics red, the first one named by name (the expected
#    detail is derived from the budgets file — the case must not hardcode
#    numbers the baselines file owns).
FIRST_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const [id,b]=Object.entries(j.metrics)[0];console.log(id+"|"+b.baseline+"|"+(b.baseline-1))' "$TMP/budgets.json")"
FIRST_METRIC="${FIRST_ID%%|*}"
FIRST_BASE="${FIRST_ID#*|}"; FIRST_BASE="${FIRST_BASE%%|*}"
FIRST_MARGIN="${FIRST_ID##*|}"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const m of Object.values(j.metrics)){m.warnAbove=m.baseline-1;}
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' \
  "$TMP/budgets.json"
must_refuse_naming "$FIRST_METRIC: measured $FIRST_BASE > margin $FIRST_MARGIN (baseline $FIRST_BASE)"
RED_COUNT="$(grep -c 'FAIL: ' "$TMP/out")"
EXPECTED_RED="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(j.metrics).length)' "$TMP/budgets.json")"
[ "$RED_COUNT" -eq "$EXPECTED_RED" ] || {
  echo "case-perf-budget: FAIL — expected all $EXPECTED_RED metrics red, got $RED_COUNT" >&2
  exit 1
}

# 2. a missing receipt fails loud (rule 5) — margins loosened, but the
#    receipts are gone from the sandbox artifacts root.
mkdir -p "$TMP/empty-tree/runtime/dsh/artifacts"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const m of Object.values(j.metrics)){m.warnAbove=m.baseline+1000000;}
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' \
  "$TMP/budgets.json"
ART_ROOT="$TMP/empty-tree" must_refuse_naming "no receipt at"
grep -q "no receipt at" "$TMP/out" || {
  echo "case-perf-budget: FAIL — missing-receipt red is not the fail-loud shape" >&2
  exit 1
}

# 3. the real budgets against the real receipts must pass.
ART_ROOT="$REPO"
green

echo "case-perf-budget: below-margin red (all metrics named), missing-receipt red (fail loud), real receipts green — sandboxed budgets, real tree untouched"
