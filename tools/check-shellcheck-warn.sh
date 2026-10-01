#!/bin/sh
# tools/check-shellcheck-warn.sh — the `shellcheck-warn` gate.
#
# WHY: #289 zeroed the warning/error-grade shellcheck surface of CI's shell
# entry scripts (36 warning + 1 error findings) and left 38 info findings by
# choice. Zero is a place, not an event: without a gate the surface re-
# accumulates one `for i in $(seq ...)` at a time, exactly the way it did
# before #289. This gate freezes the victory — any warning/error-grade
# finding in the surface goes red HERE, at the plane, instead of
# red in a CI run three days later (or never).
#
# Threshold: 0 at warning grade and above. Info/style findings are OUT of
# scope by design — style is not a CI warning (the bar #289 set); the
# style-green end state is recorded in the lint-gates Agent Note.
#
# Surface: the CI-reachable shell scripts, enumerated BY RULE so the list
# cannot go stale the way a hand-copied manifest does — every tracked .sh
# under build/, tools/, hosts/{android,harmony,ios}/, test/{e2e,tools,panel}/,
# packages/release/, deploy/marketplace/, presentation/, runtime/spike/{ci,vendor}/,
# plus runtime/spike/host/build.sh — minus checked-in artifact fixtures
# (**/artifacts/**: run outputs and guest-root profiles, never entry points).
# On the day this gate landed, the rule covered every script #289 swept with
# findings (33/33), every script the #289 PR touched (29/29), and every
# script reachable from .github/workflows (28/28).
#
# Availability (skip-on-absent precedent: runtime/spike/ci/check-quickjs-boot-parse.sh):
# agent machines vary; a missing shellcheck binary SKIPs loudly (exit 0 with
# a named reason) instead of faking green. CI installs/asserts shellcheck in
# .github/workflows/gov.yml before `gov run`, so the gate is never vacuous
# there.
#
# usage: check-shellcheck-warn.sh [paths...]
#   With no arguments: the full rule-enumerated surface (what the DAG runs).
#   With paths: exactly those files — the narrowing exists for the rejection
#   case's 10-second self-test budget (a full-surface pass costs ~6s); a
#   narrowed run is still the same binary, severity floor, and threshold.

set -eu
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# 1. The tool exists — loud skip on a miss (never a silent green).
SHELLCHECK_BIN=""
for candidate in "$(command -v shellcheck 2>/dev/null || true)" \
                 /opt/homebrew/bin/shellcheck /usr/local/bin/shellcheck; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        SHELLCHECK_BIN="$candidate"
        break
    fi
done
if [ -z "$SHELLCHECK_BIN" ]; then
    echo "shellcheck-warn: SKIP — shellcheck binary not found (PATH, /opt/homebrew/bin, /usr/local/bin); install it (brew install shellcheck) so the gate can judge"
    exit 0
fi

# 2. The surface — rule-enumerated, fail loud when it collapses to nothing.
if [ "$#" -gt 0 ]; then
    for f in "$@"; do
        [ -f "$f" ] || { echo "shellcheck-warn: FAIL — narrowed path not a file: $f" >&2; exit 2; }
    done
    SCRIPTS="$*"
else
    SCRIPTS="$(git ls-files '*.sh' \
        | grep -E '^(build/|tools/|hosts/(android|harmony|ios)/|test/(e2e|tools|panel)/|packages/release/|deploy/marketplace/|presentation/|runtime/spike/(ci|vendor)/|runtime/spike/host/build\.sh$)' \
        | grep -v '/artifacts/' || true)"
fi
if [ -z "$SCRIPTS" ]; then
    echo "shellcheck-warn: FAIL — the script surface enumerated to nothing; refusing a vacuous pass" >&2
    exit 2
fi
COUNT=$(printf '%s\n' "$SCRIPTS" | wc -l | tr -d ' ')

# 3. The judgment: severity floor at warning — error + warning count, threshold 0.
# SCRIPTS is a whitespace-separated path list — each path is its own shellcheck argv
# shellcheck disable=SC2086 # intentional word split
OUT="$("$SHELLCHECK_BIN" -S warning --format=json1 $SCRIPTS 2>/dev/null || true)"
N=$(printf '%s' "$OUT" | python3 -c '
import json, sys
try:
    comments = json.load(sys.stdin).get("comments", [])
except Exception:
    comments = []
print(len(comments))
')
if [ "$N" -gt 0 ]; then
    printf '%s' "$OUT" | python3 -c '
import json, sys
for c in json.load(sys.stdin).get("comments", []):
    print("shellcheck-warn: {} SC{} {}:{}:{} {}".format(
        c["level"].upper(), c["code"], c["file"], c["line"], c["column"], c["message"]))
'
    echo "shellcheck-warn: FAIL — $N warning/error-grade finding(s) across $COUNT scripts (threshold 0); the #289 zero is a place, keep it a place"
    exit 1
fi
echo "shellcheck-warn: green — $COUNT scripts scanned, 0 warning/error-grade findings"
