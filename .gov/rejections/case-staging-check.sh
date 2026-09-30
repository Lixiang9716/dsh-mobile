#!/usr/bin/env bash
# gate: staging-check
# Proves the staging-manifest verifier catches the disease it exists for
# (the 2026-09 fresh-install death): a file the import graph REACHES that
# the hand manifest no longer stages. Vehicle: the upstream/boot.js row in
# harmony's Index.ets BUNDLE_FILES — a boot entry every reached file hangs
# from, so dropping its single row is the minimal real gap. Runs the checker
# against the real tree with the row removed, asserts the red names the file
# as a GAP on a blocking host, restores byte-identically, and proves the
# same run goes green.
#
# The mutation window holds the live-tree case lock: self-test runs project
# cases on a ThreadPoolExecutor (CONCURRENCY=4, no mutex), and this case's
# window (Index.ets row gone) turns case-bundle-files' green leg red — the
# reverse holds too (its composer-web-live.js mv turns this green leg red
# with a STALE row). Serialize the windows; see the Agent Note
# 2026-09-29-the-staging-check-gate-closes-its-govern for the measured pair.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IDX="$REPO/hosts/harmony/entry/src/main/ets/pages/Index.ets"
[ -f "$IDX" ] || { echo "case-staging-check: FAIL — Index.ets absent" >&2; exit 1; }
grep -q "^\s*'upstream/boot\.js',$" "$IDX" || {
  echo "case-staging-check: FAIL — fixture row 'upstream/boot.js' absent from BUNDLE_FILES" >&2
  exit 1
}

# --- the live-tree case lock (shared with case-bundle-files.sh) -----------
# Repo-scoped: the mutated tree (Index.ets) is THIS worktree's, so the
# serialization window is per-worktree too — a global /tmp lock made
# parallel fleet agents' cases contend (and the 10s case budget SIGKILL
# leaks the lock, cascading timeouts; measured 2026-09-30, T-0078).
# Worktree-scoped: the mutated tree (Index.ets) is THIS worktree's, so the
# serialization window is per-worktree too — a global /tmp lock made parallel
# fleet agents' cases contend (and the 10s case budget SIGKILL leaks the
# lock, cascading timeouts; measured 2026-09-30, T-0078). The per-worktree
# git dir is the one per-worktree, always-writable, never-tracked home (a
# linked worktree's .git is a FILE — measured: mkdir .git/... fails fast and
# the acquire loop burned its whole deadline).
GITDIR="$(git -C "$REPO" rev-parse --git-dir 2>/dev/null || true)"
case "$GITDIR" in
  /*) ;;                       # already absolute
  "") GITDIR="$TMPDIR" ;;      # no git — fall back to the shared tmp lock
  *) GITDIR="$REPO/$GITDIR" ;;
esac
LOCKDIR="$GITDIR/dsh-gov-live-tree-case.lock"
TREE_LOCK_HELD=0
acquire_tree_lock() {
  local deadline=$(( SECONDS + 60 ))
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rmdir "$LOCKDIR" 2>/dev/null || true   # stolen: a killed case left it
      continue
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "case-staging-check: live-tree lock held >60s — failing loud" >&2
      return 1
    fi
    sleep 0.05
  done
  TREE_LOCK_HELD=1
}
release_tree_lock() {
  [ "$TREE_LOCK_HELD" -eq 1 ] || return 0   # never rmdir a lock we don't hold
  rmdir "$LOCKDIR" 2>/dev/null || true
  TREE_LOCK_HELD=0
}
# --------------------------------------------------------------------------

cp "$IDX" "$IDX.case-tmp"
restore() { mv "$IDX.case-tmp" "$IDX" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'release_tree_lock; rm -f "$OUT"; restore' EXIT

acquire_tree_lock
grep -v "^\s*'upstream/boot\.js',$" "$IDX" > "$IDX.case-tmp.2" && mv "$IDX.case-tmp.2" "$IDX"

if node "$REPO/tools/check-staging.mjs" --json --block harmony,android,ios > "$OUT" 2>&1; then
  echo "case-staging-check: FAIL — a boot entry missing from BUNDLE_FILES passed the gate" >&2
  exit 1
fi
# --json mode: the gap surfaces as a structured row of the harmony result,
# not the human "GAP … NOT staged" line — assert on the payload itself.
grep -q '"file": "upstream/boot.js"' "$OUT" || {
  echo "case-staging-check: red but not about the unstaged boot entry" >&2
  exit 1
}

restore
if ! node "$REPO/tools/check-staging.mjs" --json --block harmony,android,ios >/dev/null 2>&1; then
  echo "case-staging-check: FAIL — the restored tree still fails" >&2
  exit 1
fi
release_tree_lock
echo "case-staging-check: unstaged boot entry rejected; restored tree green"
