#!/usr/bin/env bash
# gate: bundle-files
# Proves the harmony BUNDLE_FILES ↔ rawfile cross-check rejects the
# #56/#57 drift class: a BUNDLE_FILES entry whose rawfile copy is missing
# (the direction that kills every fresh launch at copyRawFile before a
# single scenario line — silent E2E starvation). Runs the checker against
# the real tree with one rawfile file temporarily removed, asserts the red
# names the missing copy, restores, and proves the same run goes green.
#
# The mutation window holds the live-tree case lock: self-test runs project
# cases on a ThreadPoolExecutor (CONCURRENCY=4, no mutex), and this case's
# window (composer-web-live.js mv'd) turns case-staging-check's green leg
# red with a STALE row — the reverse holds too (its Index.ets row removal
# turns this green leg red). Serialize the windows; see the Agent Note
# 2026-09-29-the-staging-check-gate-closes-its-govern for the measured pair.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REL="scenario/composer-web-live.js"
RAW="$REPO/hosts/harmony/entry/src/main/resources/rawfile/dsh/$REL"
[ -f "$RAW" ] || {
  echo "case-bundle-files: FAIL — fixture file absent; materialize rawfile first (vendor-official.sh)" >&2
  exit 1
}

# --- the live-tree case lock (shared with case-staging-check.sh) ----------
# mkdir is the atomic primitive: portable where flock(1) is absent (macOS).
# Stale locks from a SIGKILLed case are stolen after 2 minutes (find -mmin);
# the deadline fails loud instead of hanging CI.
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
      echo "case-bundle-files: live-tree lock held >60s — failing loud" >&2
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

restore() { mv "$RAW.case-tmp" "$RAW" 2>/dev/null || true; }
trap 'release_tree_lock; restore' EXIT

acquire_tree_lock
mv "$RAW" "$RAW.case-tmp"
OUT="$(mktemp)"
if node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" > "$OUT" 2>&1; then
  echo "case-bundle-files: FAIL — a missing rawfile copy passed" >&2
  exit 1
fi
grep -q "missing from rawfile" "$OUT" || {
  echo "case-bundle-files: red but not about the missing rawfile copy" >&2
  exit 1
}
restore
if ! node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" >/dev/null 2>&1; then
  echo "case-bundle-files: FAIL — the restored tree still fails" >&2
  exit 1
fi
release_tree_lock
echo "case-bundle-files: missing rawfile copy rejected; restored tree green"
