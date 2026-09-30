#!/bin/sh
# deploy.sh — one-click standby deploy for the dsh IdP (marketplace v2).
#
# Targets:
#   logto      docker-compose (logto + postgres) — the preferred IdP
#   pocketbase single binary + systemd unit      — the constrained fallback
#
# Everything is parameterized; nothing here holds a secret. The Postgres
# password (logto) is GENERATED ON THE REMOTE HOST if missing and written
# to .env with mode 600 — it never transits git or this script's output.
# The initial admin account is created at FIRST BOOT (browser), per
# deploy/idp/README.md — never via a password on a command line.
#
# Usage:
#   ./deploy.sh --host USER@HOST [--port N] [--proxy 'nc -x HOST:PORT']
#               [--target logto|pocketbase] [--remote-dir /opt/dsh-idp]
#               [--check-only] [--pb-version v0.40.4]
#
# Exit codes: 0 ok; 2 usage; 3 target unreachable (probe below); 4 remote
# step failed; 5 health check did not pass before the deadline.

set -eu

HOST=""
PORT="22"
PROXY=""
TARGET="logto"
REMOTE_DIR="/opt/dsh-idp"
CHECK_ONLY="0"
PB_VERSION="v0.40.4" # pinned; bump deliberately (single-binary fallback)
HEALTH_DEADLINE="120" # seconds — poll the condition, never blind-sleep
PROBE_ERR="/tmp/dsh-idp-probe.$$.err"

usage() {
  sed -n '2,22p' "$0"
  exit "${1:-2}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    --pb-version) PB_VERSION="$2"; shift 2 ;;
    --check-only) CHECK_ONLY="1"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "deploy.sh: unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$HOST" ] || { echo "deploy.sh: --host is required" >&2; usage; }
case "$TARGET" in
  logto|pocketbase) ;;
  *) echo "deploy.sh: --target must be logto or pocketbase, got: $TARGET" >&2; exit 2 ;;
esac

# rssh CMD... — run a command on the target through ssh.
# Options are passed as ONE argv element each, so a ProxyCommand with
# spaces (--proxy 'nc -x 127.0.0.1:7890') survives intact. The %h %p
# placeholders are appended unless the caller already supplied them.
PROXY_CMD=""
case "$PROXY" in
  "") ;;
  *'%h'*) PROXY_CMD="$PROXY" ;;
  *) PROXY_CMD="$PROXY %h %p" ;;
esac

rssh() {
  if [ -n "$PROXY_CMD" ]; then
    set -- -o "ProxyCommand=$PROXY_CMD" "$@"
  fi
  ssh -o BatchMode=yes -o ConnectTimeout=15 \
      -o StrictHostKeyChecking=accept-new -p "$PORT" "$HOST" "$@"
}

say() { printf '[deploy-idp] %s\n' "$1"; }

# --- phase 1: probe (fail loud; never fabricate a deployment) ----------
say "probe: BatchMode ssh to $HOST:$PORT (direct${PROXY:+ / via proxy}) — polling with a deadline, no blind wait"
if ! rssh true 2>"$PROBE_ERR"; then
  say "PROBE FAILED — unreachable: missing credentials or host down"
  say "--- raw ssh stderr ---"
  cat "$PROBE_ERR" >&2
  rm -f "$PROBE_ERR"
  say "No deployment was attempted. Fix access (install an SSH key for this
account, or supply --proxy), then re-run. This package stays on standby."
  exit 3
fi
rm -f "$PROBE_ERR"
say "probe ok: ssh reachable"

if [ "$CHECK_ONLY" = "1" ]; then
  say "--check-only: probe passed, nothing deployed"
  exit 0
fi

# --- phase 2: sync the target's files -----------------------------------
# Tarball locally first — no shell pipeline, so a local tar failure aborts
# (set -e) instead of being masked by the remote's success — and .env is
# EXCLUDED: it belongs to the deployment host only; a local copy (even a
# leftover experiment) must never overwrite the host-generated one.
say "sync: $TARGET -> $HOST:$REMOTE_DIR/$TARGET (.env excluded)"
TARBALL="$(mktemp "${TMPDIR:-/tmp}/dsh-idp-sync.XXXXXX.tar.gz")"
tar --exclude="$TARGET/.env" -czf "$TARBALL" -C "$(dirname "$0")" "$TARGET"
rssh "tar -xzf - -C '$REMOTE_DIR'" < "$TARBALL"
rm -f "$TARBALL"

# --- phase 3: install ----------------------------------------------------
case "$TARGET" in
  logto)
    # .env lives on the host only; generate the DB password THERE if absent.
    # The remote dir travels as $1: the heredoc stays quoted (the $(...)
    # inside must expand on the REMOTE, never locally) while --remote-dir
    # is still honored.
    rssh bash -s "$REMOTE_DIR" <<'REMOTE'
set -eu
cd "$1/logto"
if [ ! -f .env ]; then
  umask 077
  {
    # hex only: base64's '/' would corrupt the postgresql:// URL in compose
    echo "POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "POSTGRES_DB=logto"
    echo "ENDPOINT=https://idp.CHANGE_ME.example.com"
    echo "ADMIN_ENDPOINT=https://idp-admin.CHANGE_ME.example.com"
  } > .env
  echo "[deploy-idp] generated .env on the host (DB password random hex, mode 600)."
  echo "[deploy-idp] EDIT .env: set ENDPOINT / ADMIN_ENDPOINT to your domains"
  echo "[deploy-idp] BEFORE pointing DNS at this host."
else
  echo "[deploy-idp] .env already present on the host — left untouched."
fi
command -v docker >/dev/null 2>&1 || {
  echo "[deploy-idp] docker missing on the host — install docker+compose plugin" >&2
  exit 4
}
docker compose up -d
REMOTE
    ;;
  pocketbase)
    # heredoc is unquoted: $REMOTE_DIR / $PB_VERSION expand locally
    rssh bash -s <<REMOTE
set -eu
id pocketbase >/dev/null 2>&1 || useradd --system --home-dir '$REMOTE_DIR/pocketbase' --shell /usr/sbin/nologin pocketbase
mkdir -p '$REMOTE_DIR/pocketbase/pb_data'
cd '$REMOTE_DIR/pocketbase'
if [ ! -x pocketbase ]; then
  # release assets embed the version: pocketbase_0.40.4_linux_amd64.zip
  case "$(uname -m)" in
    aarch64|arm64) PB_ARCH=arm64 ;;
    *) PB_ARCH=amd64 ;;
  esac
  PB_VER="${PB_VERSION#v}"
  curl -fsSL -o pb.zip "https://github.com/pocketbase/pocketbase/releases/download/$PB_VERSION/pocketbase_${PB_VER}_linux_${PB_ARCH}.zip"
  unzip -o pb.zip pocketbase && rm pb.zip && chmod +x pocketbase
fi
chown -R pocketbase:pocketbase '$REMOTE_DIR/pocketbase'
# the unit is a TEMPLATE: bake the real install dir in at install time,
# so ExecStart points where this script actually put the binary
sed "s|@REMOTE_DIR@|$REMOTE_DIR/pocketbase|g" '$REMOTE_DIR/pocketbase/pocketbase.service' > /etc/systemd/system/pocketbase.service
chmod 644 /etc/systemd/system/pocketbase.service
systemctl daemon-reload
systemctl enable --now pocketbase
REMOTE
    ;;
esac

# --- phase 4: health check (poll the condition with a deadline) ---------
say "health: polling (deadline ${HEALTH_DEADLINE}s)"
case "$TARGET" in
  logto)
    # OIDC standard output IS the health signal: discovery must return 200 JSON.
    HEALTH_CMD='i=0
while [ $i -lt '"$HEALTH_DEADLINE"' ]; do
  code=$(curl -fsS -o /tmp/oidc.json -w "%{http_code}" http://127.0.0.1:3001/oidc/.well-known/openid-configuration 2>/dev/null || echo 000)
  if [ "$code" = "200" ] && grep -q "\"issuer\"" /tmp/oidc.json 2>/dev/null; then
    echo "health ok: OIDC discovery returned 200 with issuer"
    grep -o "\"issuer\":\"[^\"]*\"" /tmp/oidc.json | head -1
    exit 0
  fi
  sleep 2
  i=$((i + 2))
done
echo "health FAILED: OIDC discovery did not answer within '"$HEALTH_DEADLINE"'s" >&2
exit 5'
    ;;
  pocketbase)
    HEALTH_CMD='i=0
while [ $i -lt '"$HEALTH_DEADLINE"' ]; do
  code=$(curl -fsS -o /tmp/pb-health.json -w "%{http_code}" http://127.0.0.1:8090/api/health 2>/dev/null || echo 000)
  if [ "$code" = "200" ] && grep -q "\"code\":200\|\"statusCode\":200" /tmp/pb-health.json 2>/dev/null; then
    echo "health ok: /api/health returned 200"
    cat /tmp/pb-health.json
    exit 0
  fi
  sleep 2
  i=$((i + 2))
done
echo "health FAILED: /api/health did not answer within '"$HEALTH_DEADLINE"'s" >&2
exit 5'
    ;;
esac

if ! rssh "$HEALTH_CMD"; then
  say "HEALTH CHECK FAILED — the service is NOT healthy; do not report this deploy as done"
  exit 5
fi

say "done: $TARGET healthy on $HOST. Next: first-boot admin (see deploy/idp/README.md)."
