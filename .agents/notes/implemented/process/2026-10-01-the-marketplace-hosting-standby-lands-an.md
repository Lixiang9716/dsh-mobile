# Agent Note: The marketplace hosting standby lands — an unreachable server is published as a standby kit, never as a deployment

Status: implemented
Related: D5

## Problem

The marketplace v0 needs an online home for its signed catalog (the
2026-10-01 contract proposal: a static index.json plus tgz files on plain
hosting), on the owner's Alibaba Cloud server. The landing agent, however,
cannot assume the server exists for it: SSH credentials may not be on the
machine, and the standing honesty rule for anything server-touching is that
a missing target must be REPORTED, never papered over with a plausible
deployment claim. The work needs a shape that makes progress (the whole
hosting kit ready to publish) while the unreachable state stays truthfully
visible — and the sample catalog must be a real signature, since a
placeholder signature would hide generator bugs until the day a real key
first signs.

## Decision

`deploy/marketplace/` ships the complete one-click standby kit. The probe
(2026-10-01) ran to a verdict with evidence — direct SSH times out, the
Clash-proxy route opens TCP but no SSH banner ever answers, and `~/.ssh`
holds no private key at all — so the kit lands in standby: `deploy.sh`
fails loud until `DEPLOY_HOST` exists, and the README pair documents the
owner checklist (host+key, security group 80/443, domain+TLS via caddy or
certbot) and the exact probe table. The kit itself: `generate-index.mjs`
(keys/build/verify — deterministic ustar matching `runtime/spike/tar-mini.js`
byte layout, gzip with mtime 0, ed25519 over canonical JSON, raw-key
`keys{}`, and a `--verify` mode that re-checks signature plus every entry's
`blobSha256`/`manifestSha256` against the files on disk); `catalog.json`
as the authored bilingual summaries source (fail-loud on drift with the
packaged set); `nginx.conf.example` (index.json short-cache JSON, tgz
immutable long-cache, no listings, nosniff); and a SAMPLE payload in
`site/` — the repo's nine real `system-plugins/` packed and really-signed
by a throwaway TEST keypair (`dsh-market-test-1`) that is generated on
demand via `--keygen` and never committed — the repo's `.gitignore` keeps
every key out (production key: CI secrets only, never the repo, never the
server).

## Alternatives considered

- Wait for credentials and deploy for real in this change: rejected — the
  probe's verdict is final for today; blocking the kit on the owner hides
  finished work, and nothing about the kit depends on which host appears.
- Ship an unsigned sample index (or a fake signature string): rejected —
  the signature is the marketplace's entire trust model; a fabricated one
  would rehearse the generator against a lie and make the sample
  unverifiable. The throwaway TEST keypair keeps the sample real and the
  production key discipline loud.
- Commit the test keypair so anyone can re-sign the exact sample: rejected —
  the repo's own no-keys rule (`.gitignore` `*.pem`, "any token/key stays
  out") outranks the convenience, and re-signing needs no shared key: a
  fresh `--keygen` + `--build` reproduces the FLOW, while the committed
  sample stays verifiable by anyone through the public key embedded in its
  `keys{}`. (Review #284 caught the original text claiming the pair was
  committed while `.gitignore` silently excluded it — the narrative now
  matches the tree.)
- Put summaries inside each plugin's manifest: rejected — the manifest
  format is FROZEN (D5) with no summary field, and catalog display data is
  advisory per the proposal; `catalog.json` keeps the freeze intact.
