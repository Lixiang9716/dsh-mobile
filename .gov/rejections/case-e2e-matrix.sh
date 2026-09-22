#!/usr/bin/env bash
# gate: e2e-matrix
# The gate wires `sh test/e2e/matrix.sh --accept-known-gaps`, whose whole job
# is to stay green while every finding is an OWNED row of docs/e2e-matrix.md.
# A gate that only ever accepts is vacuous, so this case drives the real CLI
# over a fixture tree and requires it to REJECT in three directions: an
# unregistered finding, a register row whose finding is gone (the register
# must shrink with a closed gap), and a register that cannot be read (rule 5 —
# never a silent accept). The same fixture with a matching row must PASS, which
# is what proves the rejects come from the register and not from a fixture
# that fails for some unrelated reason.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ROOT="$TMP/tree"
EV="$ROOT/hosts/x/artifacts/run1"
REG="$ROOT/docs/e2e-matrix.md"
mkdir -p "$EV" "$ROOT/test/e2e/scenarios" "$ROOT/docs"

# One evidence unit that is well-formed in every respect except its verdict:
# a FAIL verdict is a finding, and the manifest is present so the finding is
# VERDICT_FAIL alone rather than a pile of unrelated deliverable complaints.
printf 'log\n' > "$EV/logs.txt"
printf 'entry\n' > "$EV/scenario.jsonl"
printf '{}\n' > "$EV/receipt.json"
printf '{ "scenario": "x.run", "expect": [{}] }\n' > "$ROOT/test/e2e/scenarios/x-run.json"
printf '{ "scenario": "x.run", "pass": false, "expected": 1, "logged": 1 }\n' > "$EV/verdict.json"

matrix() { sh "$REPO/test/e2e/matrix.sh" --root "$ROOT" --register "$REG" "$@"; }

reg_rows() { # reg_rows <row...> — a register whose table is exactly these rows
    {
        printf '# fixture register\n\n| code | file | owner | closes with |\n'
        printf '| --- | --- | --- | --- |\n'
        for row in "$@"; do printf '%s\n' "$row"; done
    } > "$REG"
}

# 1. An unregistered finding blocks. This is the rejection that makes the gate
#    worth running: a NEW regression must not ride in on the known-gaps flag.
reg_rows
if matrix --accept-known-gaps > "$TMP/unregistered.txt" 2>&1; then
    echo "case-e2e-matrix: FAIL — an unregistered VERDICT_FAIL was accepted" >&2
    cat "$TMP/unregistered.txt" >&2
    exit 1
fi
grep -q 'VERDICT_FAIL hosts/x/artifacts/run1/verdict.json' "$TMP/unregistered.txt" || {
    echo "case-e2e-matrix: the unregistered finding was not named" >&2
    cat "$TMP/unregistered.txt" >&2
    exit 1
}

# 2. The same finding, owned by a register row, passes — otherwise the reject
#    above would only prove the fixture is broken, not the register's teeth.
reg_rows '| VERDICT_FAIL | hosts/x/artifacts/run1/verdict.json | fixture owner | nothing at all |'
matrix --accept-known-gaps > "$TMP/registered.txt" 2>&1 || {
    echo "case-e2e-matrix: FAIL — a registered, owned gap was rejected" >&2
    cat "$TMP/registered.txt" >&2
    exit 1
}

# 3. A row whose finding is gone blocks (stale register): the gap closed, so
#    accepting it again would be accepting nothing.
rm "$EV/verdict.json"
if matrix --accept-known-gaps > "$TMP/stale.txt" 2>&1; then
    echo "case-e2e-matrix: FAIL — a stale register row was accepted" >&2
    cat "$TMP/stale.txt" >&2
    exit 1
fi
grep -q 'STALE_KNOWN_GAP' "$TMP/stale.txt" || {
    echo "case-e2e-matrix: the stale row was not reported as STALE_KNOWN_GAP" >&2
    cat "$TMP/stale.txt" >&2
    exit 1
}

# 4. A register with no table blocks: an unreadable register cannot mean
#    "no gaps" (rule 5, fail loud).
printf '# fixture register with no table\n' > "$REG"
printf '{ "scenario": "x.run", "pass": false, "expected": 1, "logged": 1 }\n' > "$EV/verdict.json"
if matrix --accept-known-gaps > "$TMP/no_table.txt" 2>&1; then
    echo "case-e2e-matrix: FAIL — a register with no table was treated as empty" >&2
    cat "$TMP/no_table.txt" >&2
    exit 1
fi
grep -q 'REGISTER_MISSING' "$TMP/no_table.txt" || {
    echo "case-e2e-matrix: the unreadable register was not reported as REGISTER_MISSING" >&2
    cat "$TMP/no_table.txt" >&2
    exit 1
}

echo "case-e2e-matrix: the gate rejects unregistered findings, stale rows and unreadable registers"
