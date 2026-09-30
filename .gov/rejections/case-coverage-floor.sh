#!/usr/bin/env bash
# gate: coverage-floor
# Rule-6 proof that the coverage-floor comparison has teeth: a surface
# below its floor FAILS --enforce with the surface named (exit 1), the
# identical state stays advisory without --enforce (exit 0, the warn-tier
# contract), and a state above its floors passes. Self-contained: forges
# the per-surface summary report and bumps the floors, never runs vitest.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
FLOORS="$REPO/tools/test/coverage-floors.json"
SURFACE="presentation/lynx-client"
SUMMARY="$REPO/$SURFACE/coverage/coverage-summary.json"

FLOORS_ORIG="$(mktemp)"
SUMMARY_ORIG="$(mktemp)"
OUT="$(mktemp)"
HAD_SUMMARY=0
[ -f "$SUMMARY" ] && HAD_SUMMARY=1
cp "$FLOORS" "$FLOORS_ORIG"
[ "$HAD_SUMMARY" -eq 1 ] && cp "$SUMMARY" "$SUMMARY_ORIG"

RESTORED=0
restore() {
  [ "$RESTORED" -eq 1 ] && return 0
  cp "$FLOORS_ORIG" "$FLOORS"
  if [ "$HAD_SUMMARY" -eq 1 ]; then cp "$SUMMARY_ORIG" "$SUMMARY"; else rm -f "$SUMMARY"; fi
  rm -f "$FLOORS_ORIG" "$SUMMARY_ORIG" "$OUT"
  RESTORED=1
}
trap restore EXIT

forge_summary() { # $1 = lines pct, $2 = branches pct
  node -e 'const fs=require("fs");const p=process.argv[1];
fs.mkdirSync(require("path").dirname(p),{recursive:true});
fs.writeFileSync(p,JSON.stringify({total:{lines:{pct:Number(process.argv[2])},branches:{pct:Number(process.argv[3])}}}))' \
    "$SUMMARY" "$1" "$2"
}
bump_floors_to() { # $1 lines, $2 branches
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const s of Object.values(j.surfaces)){s.lines=Number(process.argv[2]);s.branches=Number(process.argv[3]);}
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' \
    "$FLOORS" "$1" "$2"
}
enforce_red() { # the gate must refuse, naming the surface
  if node "$REPO/tools/check-coverage-floor.mjs" --enforce >"$OUT" 2>&1; then
    echo "case-coverage-floor: FAIL — below-floor surface passed --enforce" >&2; exit 1
  fi
  grep -q "$SURFACE" "$OUT" || { echo "case-coverage-floor: red but does not name $SURFACE" >&2; exit 1; }
}
warn_green() { # the same state must stay advisory without --enforce
  node "$REPO/tools/check-coverage-floor.mjs" >"$OUT" 2>&1 || {
    echo "case-coverage-floor: FAIL — plain mode blocked (warn-tier broken)" >&2; exit 1; }
  grep -q "warn-tier" "$OUT" || { echo "case-coverage-floor: plain mode not advisory" >&2; exit 1; }
}
green() {
  node "$REPO/tools/check-coverage-floor.mjs" --enforce >"$OUT" 2>&1 || {
    echo "case-coverage-floor: FAIL — above-floor surface rejected" >&2; exit 1; }
}

# 1. the falsification shape: floors at 100% → even the measured baseline red
forge_summary 84.2 66.5
bump_floors_to 100 100
enforce_red
warn_green

# 2. the real floors bite too: 79.2/61.5 vs measured 10/5 must be red
bump_floors_to 79.2 61.5
forge_summary 10 5
enforce_red

# 3. above its floors, the same checker passes
forge_summary 84.2 66.5
green

restore
echo "case-coverage-floor: below-floor red (floor=100 and real floors), warn-tier advisory, above-floor green — floors restored"
