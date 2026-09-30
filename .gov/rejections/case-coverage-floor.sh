#!/usr/bin/env sh
# gate: coverage-floor
# Rule-6 proof that the coverage-floor comparison has teeth. Fully
# sandboxed: the floors registry is COPIED to a temp dir and the forged
# measurement summaries live under a temp measurements root (the checker's
# --floors / --measurements-root flags), so this case never opens a
# mutation window on the real tree — a SIGKILLed case leaves no residue by
# construction, and no live-tree lock is needed. Proves: floors at 100%
# fail --enforce naming the surface, the identical state stays advisory
# without --enforce (the warn-tier contract), the real floors bite a low
# measurement, and an above-floor state passes.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SURFACE="presentation/lynx-client"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The base registry is the REAL one — reading it also proves it parses.
cp "$REPO/tools/test/coverage-floors.json" "$TMP/floors.json"
MEASURE_ROOT="$TMP/tree"
SUMMARY_DIR="$MEASURE_ROOT/$SURFACE/coverage/coverage-summary.json"

forge_summary() { # $1 = lines pct, $2 = branches pct
  mkdir -p "$(dirname "$SUMMARY_DIR")"
  printf '{"total":{"lines":{"pct":%s},"branches":{"pct":%s}}}' "$1" "$2" \
    > "$SUMMARY_DIR"
}
bump_floors_to() { # $1 lines, $2 branches
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const s of Object.values(j.surfaces)){s.lines=Number(process.argv[2]);s.branches=Number(process.argv[3]);}
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' \
    "$TMP/floors.json" "$1" "$2"
}
enforce_red() { # the gate must refuse, naming the surface
  if node "$REPO/tools/check-coverage-floor.mjs" --enforce \
       --floors "$TMP/floors.json" --measurements-root "$MEASURE_ROOT" >"$TMP/out" 2>&1
  then
    echo "case-coverage-floor: FAIL — below-floor surface passed --enforce" >&2
    exit 1
  fi
  grep -q "$SURFACE" "$TMP/out" || {
    echo "case-coverage-floor: red but does not name $SURFACE" >&2
    exit 1
  }
}
warn_green() { # the same state must stay advisory without --enforce
  node "$REPO/tools/check-coverage-floor.mjs" \
       --floors "$TMP/floors.json" --measurements-root "$MEASURE_ROOT" >"$TMP/out" 2>&1 || {
    echo "case-coverage-floor: FAIL — plain mode blocked (warn-tier broken)" >&2
    exit 1
  }
  grep -q "warn-tier" "$TMP/out" || {
    echo "case-coverage-floor: plain mode not advisory" >&2
    exit 1
  }
}
green() {
  node "$REPO/tools/check-coverage-floor.mjs" --enforce \
       --floors "$TMP/floors.json" --measurements-root "$MEASURE_ROOT" >"$TMP/out" 2>&1 || {
    echo "case-coverage-floor: FAIL — above-floor surface rejected" >&2
    exit 1
  }
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

echo "case-coverage-floor: below-floor red (floor=100 and real floors), warn-tier advisory, above-floor green — sandbox only, real tree untouched"
