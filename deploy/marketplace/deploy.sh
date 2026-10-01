#!/bin/sh
# deploy/marketplace/deploy.sh — publish the marketplace unit (index.json +
# the per-plugin package files) to the marketplace host.
#
# The catalog is data, not a service (contract proposal 2026-10-01): this
# script rsyncs a directory of static files. It runs ONLY from a real
# (non-dry-run) publish; a dry run never reaches it.
#
# usage: deploy.sh <dist-dir>
#
# Credentials — GHA secrets, never repository files:
#   MARKETPLACE_DEPLOY_HOST      ssh destination (user@host or ssh alias) [required]
#   MARKETPLACE_DEPLOY_PATH      absolute target directory on the host     [required]
#   MARKETPLACE_DEPLOY_SSH_KEY   private key material; when set it is used
#                                for this connection only (0600 temp file) [optional]
#   MARKETPLACE_DEPLOY_PORT      ssh port                                  [default: 22]
#
# Fail-loud contract (rules.md 5): every missing input aborts naming itself —
# including "which secret to add" — and an unreachable server aborts with the
# ssh diagnostics plus the same pointer. The workflow step turns red with the
# reason on the run log; nothing is half-deployed (rsync --checksum pushes a
# consistent set, and the post-upload digest check fails the step if the
# remote index does not match the local bytes).
set -eu

fail() {
    echo "deploy.sh: $1" >&2
    exit 1
}

[ "${1:-}" != "" ] || fail "usage: deploy.sh <dist-dir>"
DIST=$1
[ -d "$DIST" ] || fail "dist directory not found: $DIST (did the package step run?)"
[ -f "$DIST/index.json" ] || fail "no index.json in $DIST — refusing to deploy an incomplete catalog"

TGZ_COUNT=$(find "$DIST" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
[ "$TGZ_COUNT" -gt 0 ] || fail "no .tgz packages in $DIST — refusing to deploy an index that points at nothing"

# --- credentials: name every missing piece in one message -------------------
MISSING=""
[ "${MARKETPLACE_DEPLOY_HOST:-}" != "" ] || MISSING="$MISSING MARKETPLACE_DEPLOY_HOST"
[ "${MARKETPLACE_DEPLOY_PATH:-}" != "" ] || MISSING="$MISSING MARKETPLACE_DEPLOY_PATH"
if [ "$MISSING" != "" ]; then
    fail "missing deploy secrets:$MISSING
  add them under Settings → Secrets and variables → Actions (see
  docs/github-owner-actions.md, 'Marketplace publish secrets'). Nothing was
  deployed; until they exist, run the publish workflow with dry-run: true."
fi

# SSH_OPTS is an options STRING by contract: word splitting on use is how the
# separate -o/-p options reach ssh. Never quote it at the call sites below.
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -p ${MARKETPLACE_DEPLOY_PORT:-22}"

# --- ssh key: temp file, 0600, always cleaned up ----------------------------
KEY_FILE=""
cleanup() {
    [ "$KEY_FILE" = "" ] || rm -f "$KEY_FILE"
}
trap cleanup EXIT
if [ "${MARKETPLACE_DEPLOY_SSH_KEY:-}" != "" ]; then
    KEY_FILE=$(mktemp "${TMPDIR:-/tmp}/mkt-deploy-key.XXXXXX")
    printf '%s\n' "$MARKETPLACE_DEPLOY_SSH_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    SSH_OPTS="$SSH_OPTS -i $KEY_FILE"
fi

# --- connectivity preflight: fail HERE, with the pointer, not mid-rsync ----
# shellcheck disable=SC2086 # options string: the split IS the interface
if ! ssh $SSH_OPTS "$MARKETPLACE_DEPLOY_HOST" true 2>/tmp/mkt-deploy-ssh-err.$$; then
    sed 's/^/  ssh: /' /tmp/mkt-deploy-ssh-err.$$ >&2 || true
    rm -f /tmp/mkt-deploy-ssh-err.$$
    fail "marketplace host unreachable: $MARKETPLACE_DEPLOY_HOST
  check (a) MARKETPLACE_DEPLOY_HOST names a reachable host,
       (b) MARKETPLACE_DEPLOY_SSH_KEY is the private key authorized there,
       (c) the host allows this runner's connection. Nothing was deployed;
  until the credentials exist, run the publish workflow with dry-run: true."
fi
rm -f /tmp/mkt-deploy-ssh-err.$$

# --- deploy: checksum comparison, not mtime trust ---------------------------
echo "deploying $DIST -> $MARKETPLACE_DEPLOY_HOST:$MARKETPLACE_DEPLOY_PATH ($TGZ_COUNT package(s) + index.json)"
# MARKETPLACE_DEPLOY_PATH is deploy config: it must expand on the CLIENT side
# (the remote has no such variable); the inner single quotes guard the remote
# side against spaces in the already-expanded value.
# shellcheck disable=SC2086,SC2029 # options-string split + client-side path
ssh $SSH_OPTS "$MARKETPLACE_DEPLOY_HOST" "mkdir -p '$MARKETPLACE_DEPLOY_PATH'"
rsync -rc --delete-after \
    --include='index.json' --include='*.tgz' --exclude='*' \
    "$DIST/" "$MARKETPLACE_DEPLOY_HOST:$MARKETPLACE_DEPLOY_PATH/"

# --- post-upload verification: the remote index IS the local index ----------
LOCAL_DIGEST=$(shasum -a 256 "$DIST/index.json" | awk '{print $1}')
# shellcheck disable=SC2086,SC2029 # options-string split + client-side path
REMOTE_DIGEST=$(ssh $SSH_OPTS "$MARKETPLACE_DEPLOY_HOST" \
    "sha256sum '$MARKETPLACE_DEPLOY_PATH/index.json' 2>/dev/null || shasum -a 256 '$MARKETPLACE_DEPLOY_PATH/index.json'" \
    | awk '{print $1}')
[ "$LOCAL_DIGEST" = "$REMOTE_DIGEST" ] || \
    fail "post-upload digest drift: local $LOCAL_DIGEST != remote $REMOTE_DIGEST — the deployed catalog is NOT the signed one; investigate the host before trusting it"

ENTRY_COUNT=$(grep -c '"id"' "$DIST/index.json" || true)
echo "deployed: index.json (sha256 $LOCAL_DIGEST, $ENTRY_COUNT entries) + $TGZ_COUNT package(s)"
echo "next: the signed index's signature is what hosts verify — hosting compromise alone cannot produce an installable package."
