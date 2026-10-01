#!/bin/sh
# tools/check-actionlint.sh — the `actionlint` gate.
#
# WHY: the workflow lint was a LOCAL ritual (`actionlint -shellcheck=shellcheck
# .github/workflows/*.yml`), run by whoever remembered — #289 found its last
# SC2034 that way. A convention only memory enforces is prose, not a gate
# (rules.md 1): every workflow in .github/workflows must lint clean, and the
# gate is where the next bad expression / unknown event / quoting bug in a
# `run:` block goes red, before CI burns a matrix on it.
#
# Surface: every .github/workflows/*.yml. When a shellcheck binary is also
# present, `run:` blocks are shell-linted too (actionlint's -shellcheck
# integration — the exact invocation #289 used); with shellcheck absent the
# pass covers actionlint's own checks and says so, loudly.
#
# Availability (skip-on-absent precedent: runtime/spike/ci/check-quickjs-boot-parse.sh):
# agent machines vary; a missing actionlint binary SKIPs loudly (exit 0 with
# a named reason) instead of faking green. CI installs the checksum-verified
# pinned release (v1.7.12) in .github/workflows/gov.yml before `gov run`, so
# the gate is never vacuous there.
#
# usage: check-actionlint.sh   (cwd-independent; exit 0 = all workflows clean)

set -eu
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# 1. The tool exists — loud skip on a miss (never a silent green).
ACTIONLINT_BIN=""
for candidate in "$(command -v actionlint 2>/dev/null || true)" \
                 /opt/homebrew/bin/actionlint /usr/local/bin/actionlint; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        ACTIONLINT_BIN="$candidate"
        break
    fi
done
if [ -z "$ACTIONLINT_BIN" ]; then
    echo "actionlint: SKIP — actionlint binary not found (PATH, /opt/homebrew/bin, /usr/local/bin); CI installs the pinned v1.7.12 release (gov.yml)"
    exit 0
fi

# 2. The surface — every workflow file, fail loud when it collapses to nothing.
WORKFLOWS=""
for f in .github/workflows/*.yml; do
    [ -f "$f" ] && WORKFLOWS="$WORKFLOWS $f"
done
if [ -z "$WORKFLOWS" ]; then
    echo "actionlint: FAIL — no .github/workflows/*.yml found; refusing a vacuous pass" >&2
    exit 2
fi
COUNT=$(printf '%s' "$WORKFLOWS" | wc -w | tr -d ' ')

# 3. The judgment — clean output, zero findings. shellcheck joins when present.
SHELLCHECK_FLAG=""
if command -v shellcheck >/dev/null 2>&1 || [ -x /opt/homebrew/bin/shellcheck ] || [ -x /usr/local/bin/shellcheck ]; then
    SHELLCHECK_FLAG="-shellcheck $(command -v shellcheck || echo /opt/homebrew/bin/shellcheck)"
    MODE="actionlint + shellcheck(run: blocks)"
else
    MODE="actionlint only (shellcheck absent — run: blocks not shell-linted here; the shellcheck-warn gate covers the entry scripts)"
fi

if ! OUT="$("$ACTIONLINT_BIN" -no-color $SHELLCHECK_FLAG $WORKFLOWS 2>&1)"; then
    printf '%s\n' "$OUT"
    echo "actionlint: FAIL — $COUNT workflows, findings above (threshold 0)"
    exit 1
fi
if [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    echo "actionlint: FAIL — $COUNT workflows, non-empty findings output above"
    exit 1
fi
echo "actionlint: green — $COUNT workflows linted ($MODE), zero findings"
