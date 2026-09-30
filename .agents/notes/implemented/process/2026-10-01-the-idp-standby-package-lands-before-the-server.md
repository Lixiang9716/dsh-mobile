# Agent Note: the IdP standby package lands before the server does

Status: implemented

## Problem

The marketplace proposal's evolution section names v2 — "publisher accounts
via an OIDC IdP (Logto-class, TS, self-hostable)"
([contract/proposals/2026-10-01-plugin-marketplace.md](../../contract/proposals/2026-10-01-plugin-marketplace.md)).
The owner commissioned the first concrete step: make the IdP **able to run**
(v0), by deploying it to the standing server. The clues on record: the
historical target `root@1.1.1.1` reached through `ProxyCommand nc -x
127.0.0.1:7890`; no private keys in `~/.ssh`. A deployment that cannot
authenticate must not be invented — the deliverable in that case is the
standby package plus an honest probe record, never a fabricated deployment.

## Decision

- **Probe first, honestly (2026-10-01):** direct `ssh -o BatchMode=yes`
  to `1.1.1.1:22` timed out in both rounds (`Operation timed out`, exit
  255); via the SOCKS5 proxy (`nc -x 127.0.0.1:7890`, listening) the TCP
  connect succeeds but the SSH banner never arrives (`Connection timed out
  during banner exchange`, exit 255, three rounds); `ssh-add -l` reports
  no identities. Verdict: **unreachable: missing credentials**. The
  unreachable branch was taken, per instruction.
- **`deploy/idp/` is the one-click standby package (config-as-data):**
  - `logto/docker-compose.yml` — Logto (`ghcr.io/logto-io/logto:1.44.0`,
    pinned to the verified release tag — the repo's pin discipline applies
    to the IdP's own image too) + Postgres 16, loopback-only ports,
    `TRUST_PROXY_HEADER=1`, official seed/alteration entrypoint;
    placeholders come from `.env` created **on the host**
    (`logto/env.example` carries `CHANGE_ME` callback-domain markers).
  - `pocketbase/pocketbase.service` — the fallback: single pinned binary
    (`v0.40.4`) behind a hardened systemd unit TEMPLATE (paths are
    `@REMOTE_DIR@` placeholders baked in by `deploy.sh` at install time,
    so the unit always points where the script actually installed),
    loopback-only `:8090`.
  - `deploy.sh` — parameterized (`--host/--port/--proxy/--remote-dir/
    --target/--check-only`), BatchMode-only; probe → fail-loud exit 3 with
    raw ssh stderr; syncs the target from a local tarball that EXCLUDES
    `.env` (built to a temp file first — a local tar failure aborts instead
    of being masked by the remote side of a pipeline); generates the
    Postgres password **on the remote host** into a mode-600 `.env` if
    absent — hex, because base64's `/` would corrupt the `postgresql://`
    URL; honors `--remote-dir` on BOTH branches (the logto branch passes
    it as `$1` into the quoted heredoc, keeping the remote-side `$(...)`
    expansion); health check polls the OIDC discovery document (logto) or
    `/api/health` (pocketbase) with a deadline, never a blind sleep. The
    proxy path auto-appends `%h %p` when the caller omits them (a bug the
    shipped script's own first probe run caught — nc usage error, fixed,
    re-run). Five PR-review findings (unit↔script path split, ignored
    `--remote-dir` on the logto branch, `.env` riding the sync tarball,
    base64 `/` in the DB URL, unpinned `:latest` image) were fixed before
    any real deployment — consistent with the honest record that nothing
    beyond `--check-only` has ever executed.
  - `README.md` + `README.zh.md` + `README.i18n.yaml` — the bilingual pair
    with the owner checklist (host / keys / security group / domain), the
    raw probe record, the first-boot admin procedure, and the caddy HTTPS
    recommendation.
- **Selection rationale.** *Logto preferred*: TS — the same stack as this
  repo's runtime and web clients; standard OIDC issuer (discovery at
  `/oidc/.well-known/openid-configuration`); admin console included; the
  stack the proposal already named. Sources:
  [Logto OSS get-started](https://docs.logto.io/logto-oss/get-started-with-oss)
  (hardware class, first-run single admin via the console's Create-account
  page), [deployment & configuration](https://docs.logto.io/logto-oss/deployment-and-configuration)
  (`DB_URL`/`ENDPOINT`/`ADMIN_ENDPOINT`/`TRUST_PROXY_HEADER`).
  *PocketBase fallback*: single Go binary, minimal footprint — but the
  note is honest that PocketBase is an OIDC **client**, not a native
  issuer ([authentication docs](https://pocketbase.io/docs/authentication),
  [discussion #4861](https://github.com/pocketbase/pocketbase/discussions/4861));
  no maintained OIDC-issuer plugin could be found when searched
  (2026-10-01), so on the fallback target the package provides the
  identity store + auth API, and anything that must speak OIDC belongs on
  the Logto target. *Keycloak rejected*: JVM footprint disproportionate
  for a single-tenant publisher service; *Zitadel rejected*: capable but
  gRPC-first, adding client-side weight the plain-OIDC v2 surface does not
  need ([zitadel.com](https://zitadel.com),
  [keycloak.org](https://www.keycloak.org)).
- **The pairing gate now covers `deploy/`:** `.gov/pairing.json` include
  gains `deploy/**/*.md`, re-baselined through the sanctioned unattended
  path with the owner instruction as the recorded reason (same move as
  the contract-directory extension). Without this, the README pair would
  sit outside the gate and rule 8's guarantee would hold only by
  discipline.

## Alternatives considered

- **Deploying Keycloak or Zitadel as the primary**: rejected — see the
  rationale above; the proposal already named the Logto class, and nothing
  in this task's evidence overturns that.
- **Treating PocketBase as a drop-in OIDC IdP**: rejected as a claim —
  the search found no maintained issuer plugin; the package keeps
  PocketBase as directed (fallback, systemd) and states its real scope
  instead of pretending it issues OIDC tokens.
- **Exposing Logto's ports directly on `0.0.0.0` for a quicker first
  run**: rejected — TLS belongs at the proxy (caddy), admin surfaces stay
  behind it; the loopback binding is the security posture, not an
  inconvenience.
- **Holding the pairing-include extension for a later PR**: rejected —
  it is exactly the "discipline over enforcement" posture the contract-dir
  note rejected; enforcement lands with the first `deploy/` pair.
- **Waiting on the server before landing anything**: rejected — the ask
  is explicit that v0 prepares "able to run" even when the target is
  unreachable; the probe record is part of the evidence, not a failure of
  it.

## Consequences

When credentials arrive, deployment is one command (`./deploy.sh --host
USER@HOST --target logto`) and its health gate is the OIDC discovery
document itself. No gateway primitive was proposed, needed, or touched:
user management is product-plane, and this change is configuration and
process only — `runtime/` and `contract/` are untouched. The secrets
posture is enforceable by construction: the repository carries
placeholders only; the DB password is generated on the host, and both
initial-admin passwords are typed in a browser at first boot.
