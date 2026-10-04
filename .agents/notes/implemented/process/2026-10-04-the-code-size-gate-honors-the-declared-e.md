# Agent Note: the code-size gate honors the declared exclusions — the shared worktree's gate DAG goes green for every session, and the deferred card closes stamp

Status: implemented
Related: D11

## Problem

The code-size gate's file set is git's would-be-committed set
(`git ls-files --cached --others --exclude-standard`), which sweeps
worktree-local agent scratch. This repository runs parallel flywheel
sessions in one shared worktree; their `.zcode/` scratch (deep-indented
probe scripts, battery round drivers) is never committed but IS seen by the
gate — so from 2026-10-04 onward every session's scoped DAG went red on
another session's scratch (8/8 violations under `.zcode/`, zero in any
reviewed diff; CI's clean tree stayed green throughout). The blast radius
was bigger than one red gate: `gov task close` stamps its receipt from a
gate run over the same working tree, so NO session could close a task card
with a green receipt while any other session's scratch was present — the
round-1 and round-2 flywheel cards both landed with their closes explicitly
deferred (#352 recorded the surprise; the friction rode every round).

## Decision

One exclusion home, two consumers. `.gov/checks/exclude.json` — the
declared exclusion list the `check` gate's syntax judging already honors,
where every entry is a glob plus a reason and every applied exclusion
surfaces as a counted SKIP — gains the `.zcode/**` entry naming exactly
what the scratch is and why it is judged nowhere. `tools/check-size.py`
now reads that same file (`declared_exclusions`) and drops matching files
from its judgment set, printing the count and the globs applied
(`65 file(s) excluded by declared exclusion …`) — counted and loud, never
a silent skip. The gate's rejection proof is untouched: `self-test`'s
check-size rejection case still passes (56 tool + 14 project cases, all
green after the change), so the gate can still fail.

With the shared tree green again, both deferred cards (T-0179, T-0180)
closed with all-green receipts (26 gates) in this change's working tree.

## Alternatives considered

- Deleting or gitignoring the scratch: rejected — the scratch belongs to
  the OTHER live sessions (the tester half's evidence trail); removing or
  ignoring it is their call, and gitignore would also hide it from the
  `??` visibility every session uses to avoid stepping on each other.
- Scoping the gate to the committed diff only (drop `--others`): rejected —
  that reintroduces the exact blind spot #338 fixed (brand-new untracked
  files were invisible to the gate until `git add`, a late red that cost a
  rebuild cycle); the widened scope is right, it just needed a declared
  escape hatch for never-shipped scratch.
- A code-size-private exclude list (a new config file beside the gate):
  rejected — a second exclusion home would drift from the `check` gate's
  (the two consumers would disagree about what is judged); reading the
  existing `.gov/checks/exclude.json` keeps one declared contract with one
  reason per glob.
