# Agent Note: gate tools see untracked sources: the working-tree phase stops being a blind spot

Status: implemented

Related: govrail issue #338

## Problem

Both hand-wired product gates enumerated their scope with plain
`git ls-files`, so a source file that had never been `git add`-ed was
invisible to them. The working-tree phase of development — precisely the
phase where the code is least likely to be right — got a green gate that
had never looked at the new file, and the violation appeared only after
the file was tracked (a late red that cost a rebuild and a re-verify
cycle; `gov run` on a dirty worktree reported 12/12 green while five
real INDENT violations sat in an untracked Swift file, and the pre-push
scoped DAG then failed). The gap hit every language, including
tree-sitter-backed ones: a brand-new `.ts`/`.py` file was equally
invisible, so the most error-prone files were the least likely to have
been checked by the time they were pushed.

## Decision

`tools/check-size.py` and `tools/check-logging.py` enumerate
`git ls-files --cached --others --exclude-standard` — git's own "what
would be committed" listing — so tracked and untracked in-scope files
are judged together. Both summaries name the widened scope instead of
implying it: `K untracked` appears beside the file count when any
member of the judged set is not yet tracked. The vendor exclusion and
the `.ets` scope rule are unchanged (they apply to the walk, not to how
the walk is enumerated). Verified with the issue's own repro: a new,
never-added `.kt` file with a 7-deep indented line is named
(`INDENT(indent-fallback) … 1 untracked`) and a new untracked `.ts`
with a bare `console.log` is flagged by the logging gate.

## Alternatives considered

- **Keep the silent skip and only note the untracked count** (the
  issue's second option) — rejected: the count would name a file the
  gate still refuses to judge, and the false green is the actual
  defect; the honest fix is to judge it.
- **`git add -N` (intent-to-add) before running** — rejected: the gates
  would mutate the index as a side effect of a read-only check, and an
  agent's later `git commit -a` would then carry files nobody staged on
  purpose.
- **Walk the filesystem instead of asking git** — rejected: the gates'
  scope contract is "what this repo would commit", and a filesystem
  walk re-introduces the ignore-file problem git already solves
  (`--exclude-standard`).
- **Fold this into the `code-size` gate only** — rejected: the blind
  spot was identical in the logging gate, and a fix in one tool leaves
  the other silently reading a smaller world.
