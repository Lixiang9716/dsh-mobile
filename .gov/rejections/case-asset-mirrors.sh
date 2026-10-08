#!/usr/bin/env bash
# gate: asset-mirrors
# Proves the product-tree ↔ host-mirror comparator catches the #286-class
# drift it exists for: a product file (web-client-v2/web/js/timeline.js)
# whose harmony rawfile mirror goes stale. Vehicle: append a probe line to
# the mirror copy — the minimal real mutation, the same shape the #279→#288
# window shipped (the android twin rode the stager's `./`-prefix SKIP hole).
# Asserts the red names the stale file, restores byte-identically, and
# proves the same run goes green.
#
# The mutation window holds the live-tree case lock: case-bundle-files moves
# a rawfile sibling in its own window, and the two green legs would eat each
# other (the measured pair behind case-staging-check's lock, 2026-09-29).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIRROR="$REPO/hosts/harmony/entry/src/main/resources/rawfile/dsh/webclient/dsh-web-client-v2/web/js/timeline.js"
PRODUCT="$REPO/presentation/web-client-v2/web/js/timeline.js"
[ -f "$MIRROR" ] || { echo "case-asset-mirrors: FAIL — mirror timeline.js absent" >&2; exit 1; }
cmp -s "$PRODUCT" "$MIRROR" || { echo "case-asset-mirrors: FAIL — fixture mirror already drifted" >&2; exit 1; }

# --- the live-tree case lock (shared with case-bundle-files.sh) -----------
# Worktree-scoped: the mutated tree is THIS worktree's rawfile copy. A linked
# worktree's .git is a FILE, so the lock lives under the resolved git dir
# (the one per-worktree, always-writable, never-tracked home).
GITDIR="$(git -C "$REPO" rev-parse --git-dir 2>/dev/null || true)"
case "$GITDIR" in
  /*) ;;                       # already absolute
  [A-Za-z]:[/\\]*) ;;          # Windows drive-letter absolute (win32 worktree: git prints D:/...)
  "") GITDIR="${TMPDIR:-/tmp}" ;;  # no git — fall back to the shared tmp lock
  *) GITDIR="$REPO/$GITDIR" ;;
esac
LOCKDIR="$GITDIR/dsh-gov-live-tree-case.lock"
TREE_LOCK_HELD=0
acquire_tree_lock() {
  local deadline=$(( SECONDS + 5 ))   # the case budget is 10s — wait no longer
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rmdir "$LOCKDIR" 2>/dev/null || true   # stolen: a killed case left it
      continue
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "case-asset-mirrors: live-tree lock held >5s — failing loud" >&2
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

restore() { mv "$MIRROR.case-tmp" "$MIRROR" 2>/dev/null || true; }
OUT="$(mktemp)"
trap 'release_tree_lock; rm -f "$OUT"; restore' EXIT

acquire_tree_lock
# The .case-tmp backup is a NEW rawfile file the checker would reject — it
# may only exist INSIDE the lock window. Created before acquire, it sat in
# the tree for the whole blocked-acquire duration and turned every other
# live-tree case's green leg red (PR #294 review round 2: dotfile 2/2 red
# concurrent with this case).
cp "$MIRROR" "$MIRROR.case-tmp"
printf '\n// asset-mirror drift probe\n' >> "$MIRROR"

if node "$REPO/tools/check-asset-mirrors.mjs" --json > "$OUT" 2>&1; then
  echo "case-asset-mirrors: FAIL — a stale mirror file passed the comparator" >&2
  exit 1
fi
grep -q '"kind": "mirror-stale"' "$OUT" && grep -q 'web/js/timeline.js' "$OUT" || {
  echo "case-asset-mirrors: red but not about the stale timeline.js mirror" >&2
  exit 1
}

restore
if ! node "$REPO/tools/check-asset-mirrors.mjs" --json >/dev/null 2>&1; then
  echo "case-asset-mirrors: FAIL — the restored tree still fails" >&2
  exit 1
fi
release_tree_lock
echo "case-asset-mirrors: stale mirror rejected; restored tree green"
