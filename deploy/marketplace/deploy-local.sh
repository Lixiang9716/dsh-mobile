#!/usr/bin/env bash
# deploy.sh — publish the marketplace v0 site to the owner's server (the
# "one-click standby": today it fails loud until the owner fills the target).
#
# What it does (in order):
#   1. rsync site/packages/ → $DEPLOY_PATH/packages/ (additive only: versioned
#      tgz files are immutable, an existing file is NEVER overwritten or
#      deleted — installed bases may still reference old versions);
#   2. upload index.json to a temp name in the SAME directory and `mv` it over
#      index.json — rename(2) is atomic within one filesystem, so a client
#      never observes a half-written catalog.
#
# The signing key never touches this script or the server: trust lives in the
# index's ed25519 signature (contract/proposals/2026-10-01-plugin-marketplace.md,
# rule 2), the server is untrusted hosting. Regenerate + re-sign with
# generate-index.mjs BEFORE deploying a changed catalog.
#
# Usage:
#   DEPLOY_HOST=<host> ./deploy.sh [--dry-run]
# Environment:
#   DEPLOY_HOST    required — ssh target host (or host alias from ~/.ssh/config)
#   DEPLOY_USER    optional — ssh user           (default: root)
#   DEPLOY_PORT    optional — ssh port           (default: 22)
#   DEPLOY_PATH    optional — webroot on server  (default: /srv/www/dsh-marketplace)
#   DEPLOY_IDENTITY optional — ssh -i identity file
#   DEPLOY_PROXY   optional — ssh ProxyCommand, e.g. the owner's Clash route:
#                  'nc -x 127.0.0.1:7890 %h %p'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="${SCRIPT_DIR}/site"
INDEX="${SITE_DIR}/index.json"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

fail() { echo "deploy: $*" >&2; exit 1; }

[ -n "${DEPLOY_HOST:-}" ] || fail "DEPLOY_HOST is not set — this is the one-click standby state: ask the server owner for ① host + SSH key ② security group 80/443 ③ a domain (see README.md)"
[ -f "${INDEX}" ] || fail "${INDEX} missing — run generate-index.mjs --build first (a site without a signed catalog is not a marketplace)"

DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_PATH="${DEPLOY_PATH:-/srv/www/dsh-marketplace}"

SSH_OPTS=(-p "${DEPLOY_PORT}" -o BatchMode=yes -o ConnectTimeout=10)
[ -n "${DEPLOY_IDENTITY:-}" ] && SSH_OPTS+=(-i "${DEPLOY_IDENTITY}")
[ -n "${DEPLOY_PROXY:-}" ] && SSH_OPTS+=(-o ProxyCommand="${DEPLOY_PROXY}")

# rsync's -e receives ONE string that rsync hands to a shell — the shell
# re-splits it, so the ProxyCommand VALUE must arrive pre-quoted or ssh
# re-parses it (`ProxyCommand=nc -x 127.0.0.1:7890 …` loses everything after
# `nc -x`; review #284, leg 2). Kept as a string on purpose; the array form
# above is for direct argv (ssh), this one is for the -e string.
case "${DEPLOY_PROXY:-}" in *"'"*) fail "DEPLOY_PROXY must not contain single quotes (it is embedded in rsync's -e string)";; esac
RSYNC_RSH="ssh -p ${DEPLOY_PORT} -o BatchMode=yes -o ConnectTimeout=10"
[ -n "${DEPLOY_IDENTITY:-}" ] && RSYNC_RSH="${RSYNC_RSH} -i ${DEPLOY_IDENTITY}"
[ -n "${DEPLOY_PROXY:-}" ] && RSYNC_RSH="${RSYNC_RSH} -o ProxyCommand='${DEPLOY_PROXY}'"

DRY=()
[ "${DRY_RUN}" = "1" ] && DRY=(--dry-run)

TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

echo "== preparing remote webroot ${TARGET}:${DEPLOY_PATH} ==" >&2
# DEPLOY_PATH is deploy config: it expands on the CLIENT side by design (the
# remote has no such variable); the inner single quotes guard the remote side.
  # shellcheck disable=SC2029 # client-side expansion is the contract here
  ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p '${DEPLOY_PATH}/packages'"

# 1) packages: additive, never clobber (no --delete on purpose — see header).
rsync -av -e "${RSYNC_RSH[*]}" "${DRY[@]}" --ignore-existing \
  "${SITE_DIR}/packages/" "${TARGET}:${DEPLOY_PATH}/packages/"

# 2) index: upload aside, then ONE atomic rename. (The dash keeps `$$` from
# greedily swallowing the following command substitution.)
TMP_NAME=".index.json.tmp.$$-$(date +%s)"
rsync -av -e "${RSYNC_RSH[*]}" "${DRY[@]}" "${INDEX}" "${TARGET}:${DEPLOY_PATH}/${TMP_NAME}"
if [ "${DRY_RUN}" = "1" ]; then
  echo "== dry run: would now mv ${TMP_NAME} → index.json =="
else
  # shellcheck disable=SC2029 # client-side expansion is the contract here
  ssh "${SSH_OPTS[@]}" "${TARGET}" "mv '${DEPLOY_PATH}/${TMP_NAME}' '${DEPLOY_PATH}/index.json'"
  echo "deployed: ${TARGET}:${DEPLOY_PATH} (packages additive, index swapped atomically)"
  echo "verify:   curl -fsSL https://<your-domain>/index.json | head -5"
fi
