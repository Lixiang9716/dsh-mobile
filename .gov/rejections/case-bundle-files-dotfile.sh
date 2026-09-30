#!/usr/bin/env bash
# gate: bundle-files
# Proves the harmony BUNDLE_FILES cross-check rejects the HAP-packer class:
# a hidden file under rawfile/spike can NEVER ride the HAP (the packer drops
# dotfiles at packaging — the 2026-09-30 device-leg deaths at
# materializeBundle on the pi-ai providers manifest), so the checker must
# reject one whether listed or not. Drops a dotfile into the live rawfile
# tree, asserts the red names the packer fact, removes it, and proves the
# same run goes green.
#
# The mutation window holds the live-tree case lock (the shared discipline
# of case-bundle-files.sh — see its header for the measured collision pair).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DOT="$REPO/hosts/harmony/entry/src/main/resources/rawfile/spike/scenario/.case-dotfile.json"

LOCKDIR="${TMPDIR:-/tmp}/dsh-gov-live-tree-case.lock"
TREE_LOCK_HELD=0
acquire_tree_lock() {
  local deadline=$(( SECONDS + 60 ))
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rmdir "$LOCKDIR" 2>/dev/null || true   # stolen: a killed case left it
      continue
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "case-bundle-files-dotfile: live-tree lock held >60s — failing loud" >&2
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

cleanup() { rm -f "$DOT"; release_tree_lock; }
trap cleanup EXIT

acquire_tree_lock
echo '{}' > "$DOT"
OUT="$(mktemp)"
if node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" > "$OUT" 2>&1; then
  echo "case-bundle-files-dotfile: FAIL — a hidden rawfile file passed" >&2
  exit 1
fi
grep -q "packer drops dotfiles" "$OUT" || {
  echo "case-bundle-files-dotfile: red but not about the hidden file" >&2
  exit 1
}
rm -f "$DOT"
if ! node "$REPO/hosts/harmony/ci/check-bundle-files.mjs" >/dev/null 2>&1; then
  echo "case-bundle-files-dotfile: FAIL — the cleaned tree still fails" >&2
  exit 1
fi
release_tree_lock
echo "case-bundle-files-dotfile: hidden rawfile file rejected; cleaned tree green"
