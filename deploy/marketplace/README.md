# The marketplace v0 static site — the catalog's online home

> English | [简体中文](README.zh.md)

The marketplace v0 is **a signed static `index.json` plus package tarballs on
plain file hosting** (contract/proposals/2026-10-01-plugin-marketplace.md,
model rule 1: the catalog is data, not a service). This directory is the
hosting kit for that site on the owner's server: the nginx site config, the
one-command publisher, the catalog generator/signer, and a SAMPLE payload
(a really-signed index over the repo's real `system-plugins/`, signed with a
throwaway TEST keypair that is generated on demand and never committed).

## Layout

```
deploy/marketplace/
├── README.md / README.zh.md   this pair
├── generate-index.mjs         catalog tool: --keygen / --build / --verify
├── catalog.json               per-plugin bilingual summaries (authored, fail-loud on drift)
├── nginx.conf.example         the static site (content types + cache headers, no listings)
├── deploy-local.sh            the OWNER-side one-click publish (rsync + ATOMIC index swap, DEPLOY_HOST required)
├── deploy.sh                  the CI publish pipeline's step (GHA secrets MARKETPLACE_DEPLOY_* — #283's half)
└── site/                      the webroot: index.json + packages/*.tgz (SAMPLE payload)
```

## Status (2026-10-01): STANDBY — the server was not reachable

The connectivity probe ran with evidence, and the outcome is honest: **the
server is unreachable from this machine, and there are no credentials**.
Nothing was deployed; no deployment is claimed.

| Probe (BatchMode, ConnectTimeout) | Result |
| --- | --- |
| `ssh root@1.1.1.1` direct ×3 | `Operation timed out` ×3 |
| via `-o ProxyCommand="nc -x 127.0.0.1:7890 %h %p"` ×3 (+2 with a 10 s timeout) | TCP connects through the proxy, then `Connection timed out during banner exchange` every time — nothing speaks SSH on that path |
| raw TCP `nc -z` direct / via proxy | direct fails; via proxy `succeeded` (TCP opens, no SSH banner follows) |
| credentials | `~/.ssh` has no private key (no `id_*`), no `config`; `known_hosts` lists only `github.com` — this machine has never completed an SSH handshake with that host |

Shell history shows the owner previously used `ssh root@1.1.1.1 -o
Proxycommand="nc -x 127.0.0.1:7890 %h %p"` (local Clash on 7890) — that
route is preserved as `DEPLOY_PROXY` in deploy-local.sh, but without a key and
without an answering sshd there is nothing to deploy with.

## What the owner provides (the standby checklist)

1. **Host + SSH key** — the real host/IP and an authorized key for this
   machine (`ssh-keygen -t ed25519`, publish the public key to the server's
   `authorized_keys`). Then `export DEPLOY_HOST=<host>` (plus
   `DEPLOY_USER`/`DEPLOY_PORT`/`DEPLOY_IDENTITY`/`DEPLOY_PROXY` as needed).
2. **Security group: open 80/443** — on Alibaba Cloud, the instance's
   security group must allow inbound TCP 80 and 443 (and 22 from the
   deploying machine's IP for publish runs).
3. **A domain, and TLS via caddy or certbot** — the marketplace is meant to
   be reached over HTTPS (`tgzUrl` in the signed index is absolute). Either:
   - **caddy** (recommended, least config): point the domain at the server,
     run caddy on 443 with `reverse_proxy 127.0.0.1:80` — certificates are
     automatic; or
   - **certbot**: `certbot --nginx -d <domain>` amends the nginx config with
     the 443 block and managed renewal.

## Publish (once the server exists)

```sh
node generate-index.mjs --keygen test-keys/test-ed25519   # once, LOCAL only — no key is ever committed
node generate-index.mjs --build --plugins ../../system-plugins \
  --catalog catalog.json --key test-keys/test-ed25519.pem \
  --key-id dsh-market-test-1 --base-url https://<your-domain> --out site
node generate-index.mjs --verify site/index.json   # signature + digests
DEPLOY_HOST=<host> ./deploy-local.sh                     # rsync + atomic index swap
DEPLOY_HOST=<host> ./deploy-local.sh --dry-run           # preview first
curl -fsSL https://<your-domain>/index.json | head # post-check
```

The index is GENERATED, never hand-edited: every `tgzUrl` is signed into the
catalog, so a new domain (or new key) means regenerate + re-sign + redeploy.
`deploy-local.sh` fails loud until `DEPLOY_HOST` exists — that is the standby
state by design, not an error to work around.

## Keys — read this before publishing anything real

- **No key lives in this repo — not even the test pair.** The sample payload
  in `site/` is a REAL signature (not a placeholder), made by a throwaway
  TEST pair (`dsh-market-test-1`) that stays out of the tree on purpose:
  the repo's standing rule is that no key is ever committed
  (`.gitignore` `*.pem` — "any token/key stays out"). Reproduce the flow
  yourself with `--keygen` + `--build` above; verifying the COMMITTED sample
  needs no key at all — the public key rides inside `index.json`'s `keys{}`,
  so `--verify` works on a fresh clone. Test keys guard nothing; never point
  production traffic at them.
- **The production signing key lives in CI secrets** (GitHub Actions
  environment secret; file-style secret written to disk at build time).
  It is NEVER committed to the repo and NEVER copied to the hosting
  server — the server is untrusted hosting by design (the proposal rejects
  transport-only trust precisely so a compromised host cannot forge a
  catalog; keep that property).
- **Verification keys are pinned host-side** (app build config / repo
  config, same discipline as the vendor pin table): the `keys{}` block in
  the index carries the raw ed25519 public keys, base64.
- **Rotation is a dual-signed window** (proposal rule: a rotation publishes
  a new index signed by both keys for one window, then drops the old one).
  The `--key-id` flag names the signing key.

## Site contract (what nginx.conf.example guarantees)

- `/index.json` → `application/json`, `Cache-Control: public, max-age=60`
  (short: key rotations and new entries propagate in minutes; the client
  resolver adds its own cache policy).
- `/packages/<pkg>@<semver>.tgz` → `application/gzip`,
  `Cache-Control: public, max-age=31536000, immutable` (a versioned tarball
  never changes; a new version is a new file). `blobSha256` in the index is
  the real integrity anchor — the cache header is transport efficiency only.
- No directory listings (`autoindex off`), no HTML, everything else 404,
  `X-Content-Type-Options: nosniff` everywhere.
- Packages are published ADDITIVELY (`--ignore-existing`, no `--delete`):
  installed bases may still reference old versions; disk cost is the only
  thing that grows, and a periodic prune is a deliberate human act.
