# Agent Note: Upgrade the governance plane to govrail 0.45.0

Status: implemented
Related: D0

## Problem

The plane was initialized with govrail 0.29.4 and last migrated to the
0.37 command family with the tool pinned at 0.37.1. Eight minor versions
of template evolution accumulated since: the shipped hooks predate real
fixes (sha256 clone support in pre-push, `GOV_BIN` propagation so gate
commands that name `gov` resolve when the hook fell back to
`python3 -m gov`), the seal covers a rules.md whose pairing wording no
longer matches the shipped template, and the DAG lacks the gates 0.45
ships by default (`check`, `plane`) plus per-gate `timeoutMs` and
pre-commit `stages` wiring. CI meanwhile pinned 0.37.1, so local and CI
governance semantics could fork silently on every merge.

## Decision

The plane runs govrail 0.45.0 end to end: local tool via `uv tool
install --python 3.12 --force govrail`, CI pin bumped to 0.45.0,
manifest bumped, plane re-sealed. gates.json hand-merges the 0.45
template — `plane` (seal tamper-evidence) and `check` (syntax-class
static checks) join the DAG, pairing/conflict-markers carry
`stages: [pre-commit]`, every gate gets a `timeoutMs`, and the
decisions guard uses the canonical `gov decision verify` spelling.
pre-push/pre-commit hooks take the 0.45 templates wholesale (verified
pristine 0.29-era templates first, no local customization to lose).
`.gov/rules.md` and the five agent skills re-adopt the 0.45 templates
via `gov update --apply`'s adoption step; the CI workflow takes the
template's hardening (concurrency cancel, `timeout-minutes: 15`, push
filtered to main). `gov update --apply` then completed the choreography
end to end — adoptions, manifest bump, re-seal — because the hand-merge
in the parent commit steered its gates-merge step into the "nothing to
add" short-circuit; on an unmerged repo that step dies resolving the
shipped template repo-relatively (`<repo>/gov/templates/gates.json`,
`[Errno 2]`), and the mid-flight abort leaves a state the launder guard
refuses to re-enter. The CI pin was also pre-set by hand. Defects filed
upstream.

## Alternatives considered

- Staying on 0.37.1 and adopting piecemeal: rejected — manifest/version
  drift between local and CI is exactly what the pin exists to prevent,
  and every later migration only gets larger.
- Waiting for upstream to fix `gov update`, then running it clean:
  rejected — the path bug is fatal for every adopter repo (only the
  govrail source checkout works) with no announced fix; the manual
  choreography uses only sanctioned commands (`gov init --adopt`
  semantics via update's adoption step, `gov verify-plane --write` for
  the re-baseline) and is fully recorded in the ritual ledger.
- Hand-editing `.gov/` ledgers instead of running the adoption/re-seal
  tools: rejected — plane state is append-only and tool-managed by
  design (D0, rule against hand-editing `.gov/`).
