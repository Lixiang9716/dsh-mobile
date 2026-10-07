#!/bin/sh
# runtime/dsh/ci/run-security-byok-leak.sh — the CLI proof run for the
# adversarial leg `security.byok-leak` (docs/security-threat-model.md,
# surface "BYOK credential flow"): a canary credential is driven through
# the keychain save, the relaunch route resolution, one REAL turn over the
# gateway httpFetch transport, and the 401 auth-failure face — then the
# runner audits the RAW captured log (stdout + stderr) for BOTH secret
# values (the canary and the wrong-key probe).
#
# The audit has a MATCHER SELF-CHECK (rule 6: a gate that cannot fire is
# not evidence): the same grep that audits the log is first proven to catch
# a seeded line containing the canary, on a scratch copy. A matcher that
# cannot match is an audit that cannot catch — this rung proves the teeth.
#
# The #280 key-audit discipline (run-onboarding-e2e.sh step 5), extended
# with the self-check and the second secret value.
#
# usage: run-security-byok-leak.sh [--art-dir DIR] [--skip-build]
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-security-byok-leak"
CANARY="byok-canary-9f2c7e1a4d6b8f30"
WRONG_KEY="byok-wrong-probe-5d81c3e7a9f04b62"
MOCK_WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh
sh vendor/ensure-ish.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-cli ] || sh host/build.sh

# 3. the mock LLM server: one scripted success, then the scripted 401.
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-byok.XXXXXX)"
DSH_MOCK_SEQUENCE="success auth_error" DSH_MOCK_LLM_KEY="$CANARY" node ci/mock-llm-server.mjs \
    > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    rm -f "$MOCK_LOG"
}
trap cleanup EXIT INT TERM
polled=0
until grep -s '^MOCK_BASE_URL=' "$MOCK_LOG" > /dev/null; do
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        echo "byok-leak: FAIL — the mock LLM server died before announcing" >&2
        exit 1
    fi
    if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "byok-leak: FAIL — no MOCK_BASE_URL announce within ${MOCK_WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
    polled=$((polled + 1))
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "mock llm server: $MOCK_URL" >&2

# 4. run the scenario and verify one-to-one.
mkdir -p "$ART_DIR"
LOG="$ART_DIR/logs.txt"
rm -f "$LOG"
RC=0
(cd . && ./build/dsh-cli . scenario/security-byok-leak.js --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_BYOK_CANARY=$CANARY" \
    --env "DSH_BYOK_WRONG=$WRONG_KEY" > "$LOG" 2>&1) || RC=$?
grep '^dsh.runtime.log:' "$LOG" > "$ART_DIR/scenario.jsonl" || true
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/security-byok-leak.json" \
    --log "$LOG" --out "$ART_DIR/verdict.json"
if [ "$RC" -ne 0 ]; then
    echo "   FAIL: the host exited $RC (crash, or the scenario reported failure — see $LOG)" >&2
    exit 1
fi

# 5. the MATCHER SELF-CHECK: the audit grep must be PROVEN to fire.
SCRATCH="$(mktemp /tmp/dsh-byok-audit-selfcheck.XXXXXX)"
printf 'seeded line with %s inside\n' "$CANARY" > "$SCRATCH"
if ! grep -F -q -e "$CANARY" "$SCRATCH"; then
    rm -f "$SCRATCH"
    echo "byok-leak: FAIL — the audit matcher cannot catch its own seeded leak" >&2
    exit 1
fi
rm -f "$SCRATCH"
echo "   self-check: the audit matcher fires on a seeded leak"

# 6. the KEY AUDIT: neither secret value may appear anywhere in the raw
#    capture (stdout + stderr + every debug line — the whole stream).
if grep -F -e "$CANARY" -e "$WRONG_KEY" "$LOG" >/dev/null; then
    echo "byok-leak: FAIL — a credential value leaked into the log (HIGH finding)" >&2
    exit 1
fi
echo "   audit: canary + wrong-key probe absent from the raw log"

cat > "$ART_DIR/receipt.json" <<EOF
{
 "host": "macOS $(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
 "phase": "security adversarial leg 4/4 — the BYOK credential's leak surface under a canary audit (docs/security-threat-model.md)",
 "launchConfiguration": "./build/dsh-cli . scenario/security-byok-leak.js --http --env DSH_BYOK_CANARY=<canary, not reproduced here>",
 "scenarios": [
  {
   "id": "security.byok-leak",
   "checker": "test/e2e/scenarios/security-byok-leak.json",
   "result": "pass",
   "note": "the canary rode the frozen keychain (0600 dev-host file), the in-memory route resolution, and the Authorization header of one REAL transport turn; the 401 error face asserted key-free IN RUNTIME; the relaunch resolution emitted kind/provider only"
  }
 ],
 "audit": "the raw log (stdout + stderr, every debug line) carries NEITHER secret value; the audit matcher was first proven to fire on a seeded line (the receipt's own self-check rung, this run)",
 "notes": "The keychain face's persistence here is the CLI dev host's 0600 file under the smoke tmpdir (the BYOK note's disclosed dev-host storage); the values are cleared at scenario end. Screenshot capture is host/OS-side and has no runtime surface — the leak faces a plugin code can reach (logs, errors, route facts) are the ones this leg audits."
}
EOF

echo "run-security-byok-leak: PASS — evidence in $ART_DIR"
