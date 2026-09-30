# The IdP one-click standby package (marketplace v2 — publisher identity)

> English | [简体中文](README.zh.md)

**Status: STANDBY — not deployed.** The deployment target probed
**unreachable: missing credentials** (2026-10-01). Everything below is
prepared to run; nothing below claims a server answered. When access is
granted, `deploy.sh` turns this package into a live deployment with a
health check — until then it is config-as-data only, and it does not
touch `runtime/` or `contract/`.

Raw probe record (run 2026-10-01, `deploy/idp/deploy.sh --host root@1.1.1.1 --check-only`,
direct and via `--proxy 'nc -x 127.0.0.1:7890'`; `~/.ssh` holds no private
keys, `ssh-add -l` reports no identities):

```
=== manual rounds (ssh BatchMode) ===
direct:   ssh: connect to host 1.1.1.1 port 22: Operation timed out        (exit 255, 2 rounds)
proxy:    Connection timed out during banner exchange                      (exit 255, 3 rounds)
          Connection to UNKNOWN port 65535 timed out
tcp:      direct 1.1.1.1:22            -> failed (nc exit 1)
          via SOCKS5 127.0.0.1:7890    -> TCP connect succeeded, no SSH banner ever arrived
=== deploy.sh probe (the shipped tool) ===
[deploy-idp] PROBE FAILED — unreachable: missing credentials or host down
[deploy-idp] --- raw ssh stderr ---
ssh: connect to host 1.1.1.1 port 22: Operation timed out      (direct, exit 3)
Connection timed out during banner exchange                    (proxy, exit 3)
```

## What is in this package

| Path | Role |
| --- | --- |
| `logto/docker-compose.yml` | **Preferred target** — Logto `1.44.0` (pinned) + Postgres, loopback-only ports, placeholders from `.env` |
| `logto/env.example` | Placeholder template — copy to `.env` **on the host**, never commit it |
| `pocketbase/pocketbase.service` | **Fallback target** — single-binary systemd unit TEMPLATE (paths baked in by `deploy.sh` at install; resource-constrained hosts) |
| `deploy.sh` | Parameterized deploy + health check (`--host`, `--port`, `--proxy`, `--remote-dir`, `--target logto\|pocketbase`, `--check-only`) |

## Selection rationale (summary — full version in the Agent Note)

- **Logto preferred**: the marketplace proposal
  ([contract/proposals/2026-10-01-plugin-marketplace.md](../../contract/proposals/2026-10-01-plugin-marketplace.md),
  "Evolution v2") names an OIDC IdP "Logto-class, TS, self-hostable".
  Logto is TypeScript — the same stack as this repo's runtime and web
  clients — speaks standard OIDC (discovery at
  `/oidc/.well-known/openid-configuration`), and ships an admin console.
  Sources: [Logto OSS docs](https://docs.logto.io/logto-oss/get-started-with-oss),
  [deployment & configuration](https://docs.logto.io/logto-oss/deployment-and-configuration).
- **PocketBase fallback** (single binary, tiny footprint): honest caveat —
  PocketBase is an OIDC *client*, **not** a native OIDC issuer
  ([authentication docs](https://pocketbase.io/docs/authentication),
  [discussion #4861](https://github.com/pocketbase/pocketbase/discussions/4861)).
  On a constrained host it provides the identity store + auth API; if the
  v2 integration must speak OIDC there, land Logto (or a dedicated
  lightweight IdP) instead.
- **Keycloak / Zitadel not chosen**: Keycloak's JVM footprint is heavy for
  a single-tenant publisher service; Zitadel is capable but gRPC-first,
  adding client-side weight our plain-OIDC v2 surface does not need. Both
  lose to Logto on stack alignment with this repo.

## What the owner must provide (checklist)

1. **Host** — a Linux server reachable by SSH. For Logto, size per the
   [OSS docs](https://docs.logto.io/logto-oss/get-started-with-oss)
   (2 vCPU / 8 GiB RAM class) with Docker + the compose plugin installed;
   for PocketBase any small box runs the single binary.
2. **Keys** — an SSH **key pair** for the operator account, public half
   installed on the host. `deploy.sh` runs BatchMode-only: no passwords on
   command lines, no keys in git. If egress needs the SOCKS proxy, give
   the proxy address for `--proxy`.
3. **Security group** — inbound `80/tcp` + `443/tcp` (public; OIDC
   callbacks arrive from browsers), `22/tcp` restricted to the operator
   network. **Do not** expose `3001/3002/8090` — every service in this
   package binds loopback and expects TLS at the reverse proxy.
4. **Domain** — two DNS names for Logto (`ENDPOINT`, e.g.
   `idp.example.com`, and `ADMIN_ENDPOINT`, e.g. `idp-admin.example.com`),
   both pointing at the host, TLS terminated by the proxy. OIDC callback
   domains of future relying parties get registered inside the Logto
   admin console — the placeholders in `logto/env.example` mark where
   they belong.

## Deploy (when access exists)

```sh
# probe only — safe, changes nothing
./deploy.sh --host USER@HOST --check-only

# full deploy, Logto
./deploy.sh --host USER@HOST --target logto --proxy 'nc -x 127.0.0.1:7890'

# full deploy, PocketBase fallback
./deploy.sh --host USER@HOST --target pocketbase
```

`deploy.sh` generates the Postgres password **on the host** (mode-600
`.env`, hex — safe inside the `postgresql://` URL) if absent; an existing
`.env` is never overwritten, and the file sync excludes `.env` entirely,
so even a local leftover copy cannot reach the host.

## First boot — initial admin (passwords never enter git)

- **Logto**: open `ADMIN_ENDPOINT`; the welcome page offers **Create
  account** — set the admin username and password there, in the browser.
  The OSS console supports exactly one admin account. Source:
  [Logto OSS docs](https://docs.logto.io/logto-oss/get-started-with-oss).
- **PocketBase**: open `https://<host>/_/` and create the superuser in the
  web installer. Do not create it via a password on a shell command line.

Write neither password into git, chat, tickets, or shell history. Losing
the Logto admin is recoverable via re-seeding; treat the first-boot
password as the asset it is.

## HTTPS (recommended: caddy)

Both targets bind loopback; put TLS in front. Caddy answers the ACME
challenge and proxies — drop this `Caddyfile` on the host:

```
idp.example.com {
  reverse_proxy 127.0.0.1:3001
}
idp-admin.example.com {
  reverse_proxy 127.0.0.1:3002
}
# pocketbase fallback: one name, reverse_proxy 127.0.0.1:8090
```

`TRUST_PROXY_HEADER=1` is already set in the compose file for this
topology. Sources: [caddyserver.com](https://caddyserver.com),
[Logto reverse-proxy notes](https://docs.logto.io/logto-oss/deployment-and-configuration).
