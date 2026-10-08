# Agent Note: the live-tree case lock resolves win32 drive-letter git dirs

Status: implemented
Related: T-0078 (the per-worktree lock this fixes up), surprise sig `gov-task-close-runs`

## Problem

`gov task close` was unrunnable on a Windows linked worktree: all four
live-tree rejection cases (`case-asset-mirrors`, `case-bundle-files`,
`case-bundle-files-dotfile`, `case-staging-check`) failed before asserting
anything. The lock home resolves `git rev-parse --git-dir`, which on a win32
worktree prints a drive-letter absolute path (`D:/workspace/dsh-mobile/.git/worktrees/<name>`).
The scripts' `case "$GITDIR" in /*)` treats anything not starting with `/` as
relative, so the drive-letter path fell into `*)` and became
`<repo>/D:/workspace/...` — a path that can never exist. `mkdir "$LOCKDIR"`
failed on every acquire attempt: asset-mirrors burned its 5s deadline and
failed loud ("live-tree lock held >5s"), while the other three sat in the
acquire loop until govrail's 10s case budget SIGKILLed them (SIGKILL skips the
trap, so one kill also leaked an `Index.ets.case-tmp` backup into the tree).
With self-test red, every gate with `needs: [self-test]` SKIPped, and a close
receipt refuses SKIP outcomes — the card-close path was fully wedged on win32.

## Decision

The four case blocks gain one branch: `[A-Za-z]:[/\\]*) ;;` — a Windows
drive-letter absolute `GITDIR` is used as-is, exactly like the `/*` branch, so
the lock dir lands under the real per-worktree git dir
(`D:/workspace/dsh-mobile/.git/worktrees/<name>/dsh-gov-live-tree-case.lock`).
The lock protocol itself (mkdir atomic acquire, 2-minute stale steal, deadline
fail-loud, release-once discipline) is untouched, and POSIX behavior is
byte-identical — the new pattern cannot match a POSIX path. The plane was
re-sealed over the four scripts (`gov verify-plane --write`, recorded
UNATTENDED 2026-10-08). Measured after the fix, on the same win32 worktree:
`case-asset-mirrors.sh` run standalone passes (lock acquired, mutation
rejected, restored tree green), and the `self-test` gate's four earlier
failures stop being lock failures — the remaining ones were the worktree's
unmaterialized harmony rawfile closure and vendor tree, not this code path.

## Alternatives considered

- Bumping govrail's `REJECTION_TIMEOUT_S` (10s) or the cases' deadlines: lost —
  the deadline is not the defect; an unacquirable lock never succeeds at any
  deadline, and stretching it just slows the failure while govrail kills the
  case anyway.
- A global /tmp lock home when `GITDIR` looks unusual: lost — T-0078 moved the
  lock per-worktree precisely because a shared tmp lock made parallel fleet
  agents' mutation windows contend; falling back to it on win32 would resurfac
  agents' mutation windows contend; falling back to it on win32 would resurface
  that collision class.
- `cygpath -u` normalization of `GITDIR`: lost — it converts to `/d/...` form
  that fixes the glob but produces an MSYS path some Windows-native consumers
  of the lock path would choke on; the pattern branch keeps git's own spelling,
  which `mkdir`/`find`/`rmdir` in Git Bash all accept.
- Fixing govrail upstream: right long-term home for a shared-shape fix, but the
  glob lives in this repo's project-authored case scripts, not in govrail —
  recorded here as govrail field feedback instead.
