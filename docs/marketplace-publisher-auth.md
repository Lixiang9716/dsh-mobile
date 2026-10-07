# Publisher identity and tokens for the plugin marketplace — the product wiring face (v0, with the v1 token model named)

English | [简体中文](marketplace-publisher-auth.zh.md)

This document records the publisher-side design for the plugin marketplace
as a PRODUCT question: who may publish, what credential proves it, and where
that credential is consumed. It is a wiring-face design, not a gateway
change — the survey in [§6](#6-gateway-primitive-survey-verdict) concludes
that **zero new gateway primitives** are required at v0 or v1, so no D5
proposal stop is triggered.

Basis (all read at this repository's `main`, 2026-10-01):

- [contract/proposals/2026-10-01-plugin-marketplace.md](../contract/proposals/2026-10-01-plugin-marketplace.md)
  — the D5 DRAFT (data-protocols **v1.1.0 candidate**, nothing frozen): v0
  catalog = a signed static `index.json`; its non-goals already state
  "**No user accounts.** Publisher v0 is the owner's token (the catalog is
  authored by CI from the repo, exactly like the vendor pin table);
  consumers are the already-vendored anonymous device identity." Its
  evolution section names the v1 publisher API (Verdaccio-compatible
  publish/serve side) and the v2 identities (OIDC IdP, Open VSX-style
  review).
- The frozen package format (data-protocols v1.0.0) and the installer's
  trust record (`blobSha256` / `manifestSha256`) — the fields a published
  package must carry, untouched by anything in this document.
- The vendored consumer identity:
  `@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2`, pinned in
  [runtime/dsh/vendor/ensure-dsh.sh](../runtime/dsh/vendor/ensure-dsh.sh)
  (the vendor pin table, D6 discipline).

## 1. The two faces, and why they never meet

The marketplace has exactly two authentication faces, and v0 puts them on
opposite sides of the network:

| Face | v0 | Who holds the credential |
| --- | --- | --- |
| **Publisher** (write: catalog + packages) | repo owner only | GitHub credentials; CI is the acting identity |
| **Consumer** (read: discover + install) | anonymous | the vendored anonymous device ID; no login, no token on the phone |

The publisher face is a **production-side** concern: it lives in the
repository and CI. The consumer face is a **device-side** concern: it lives
behind the frozen `httpFetch` primitive and the install pipeline's trust
record. Nothing in this document moves authentication onto the device; the
phone never sees, holds, or validates a publisher credential at any version.

## 2. v0 — the publisher IS the owner; CI is the acting identity

v0 has **no token artifact at all**. Publisher authority is exactly
repository write access, and the publish action is a CI run:

1. The owner (or a maintainer with repo write) merges changes that feed the
   catalog — plugin sources, versions, the index generator's inputs.
2. CI (GitHub Actions, the same trust plane that holds the ed25519 catalog
   signing keys per the marketplace proposal) builds the package tarballs,
   computes the `blobSha256` / `manifestSha256` trust records, signs
   `index.json`, and uploads artifacts to static hosting.
3. The only credentials involved are GitHub's own — the workflow's
   `GITHUB_TOKEN` / deploy credentials in Actions secrets.

This is the same shape as the vendor pin table (D6): the registry of truth
is the repository, the machine that acts is CI, and no human ever handles a
marketplace-specific credential. It is also the shape the marketplace
CI/CD line already assumes — the publish flow needs no new identity system,
only the repo's existing one.

**Custody rules (red lines):** signing keys and GitHub credentials live in
Actions secrets / the repo's key custody, never in git; there is no initial
admin password anywhere because there are no accounts to administer.

## 3. v1 — the token model when a publish API appears

Named here so v0's shape evolves without rework; not built in this change.
When third parties can push packages through a registry service (the
proposal's v1 evolution), the credential is a **short-lived, PAT-shaped
bearer token**:

- **Shape.** An opaque-looking signed envelope, `dshpub-v1.<claims>.<sig>`:
  claims name the issuer (the IdP), the publisher subject, the audience
  (`dsh-marketplace-publish`), the scope (`publish`), and issue/expiry
  times. **Lifetime is bounded — hours, not months** (working figure: 1 h,
  ceiling 8 h). A PAT-shaped token that lives forever is a leaked-secret
  liability, not a credential.
- **Issuance goes through the IdP.** The OIDC identity provider named in
  the proposal's v2 evolution is pulled forward to serve v1 issuance: CI
  exchanges its GitHub Actions OIDC identity for a short-lived publish
  token per run (no long-lived secret is ever stored); a human publishing
  locally mints one through IdP login. The IdP is the only issuer.
- **Validation lives entirely on the publish API side.** The registry
  verifies signature + claims at ingest (issuer allowlist, audience,
  scope, expiry window, per-token `jti` for deny-list revocation). The
  phone performs no publisher-token validation — it never receives one.
- **What does not change.** The client contract (the frozen package format,
  the installer's trust record, `httpFetch`) is untouched; publish-side
  auth adds nothing client-visible. The catalog's signature layer remains
  the consumer-side trust — a valid publisher token makes an entry
  *publishable*, never *installable*; install still requires the signed
  index and the matching digests.

## 4. Consumption points

| Version | Who presents | What | To whom | Where it ends |
| --- | --- | --- | --- | --- |
| v0 | CI (on the owner's merge) | repo-owned signing keys + `GITHUB_TOKEN` | the static host / GitHub | the marketplace publish flow |
| v1 | publisher CI or tooling | short-lived `dshpub-v1` bearer | the publish API (Verdaccio-compatible) | the marketplace publish flow |
| both | the phone | **nothing publisher-side** — anonymous device ID over `httpFetch` | static host / registry (read-only) | discovery + install only |

The marketplace publish flow is the ONLY consumer of publisher identity.
Terminal users are unaffected at every version: they remain the
already-vendored anonymous device identity
(`@deepseek-ai/dsh-anonymous-user-id`), with no account, no login, and no
publisher token on the device.

## 5. Deliberate non-coupling with the profile manifest (#268)

The profile-manifest proposal (#268) answers a **consumption-side**
question: which packages a profile wants and when it upgrades. This
document answers a **production-side** question: who may write into the
catalog. They share no fields, no identity, and no flow — their only
meeting point is the catalog entry format the marketplace proposal already
fixes. A change to upgrade policy requires no publisher-token change and
vice versa; neither document references the other's model.

## 6. Gateway-primitive survey: verdict

**Zero new gateway primitives are required. None is proposed. No D5 stop.**

- v0 publish flow: repository + CI only. It never touches the device, so it
  cannot need a device primitive.
- v0/v1 consumption flow: discovery and install ride the FROZEN
  `httpFetch` primitive read-only, then the frozen install pipeline with
  its existing trust record — exactly the proposal's own conclusion
  ("zero new gateway primitives — the flow rides `httpFetch` and the
  existing install pipeline").
- v1 publish API: a server-side (repo/registry) concern. Client behavior
  is download-only and unchanged, so no client primitive appears.
- The one hypothetical that WOULD open the gateway face — publishing or
  authoring FROM the phone, which would need an on-device
  credential/authenticated-write surface — is explicitly out of scope for
  v0/v1 and is named here so it cannot arrive by drift: it must go through
  a D5 proposal first.

Process rule note: the publish flow is CI (an event on merge), not a
polling loop, consistent with D8; no component polls another's state.

## 7. Groundwork shipped with this document: the mock validator

[v1 groundwork only — nothing calls the validator: no service, no gate
command, no runtime caller.] A pure-function validator for the v1 token
envelope ships alongside this document as design evidence:

- `tools/publisher-token.mjs` — `validatePublisherToken(token, options)`:
  format, claims schema, audience/scope/expiry rules (with an injected
  `now`), a maximum-lifetime rule that REJECTS long-lived tokens, and an
  injected signature-verifier callback so the function stays pure and
  offline.
- `tools/publisher-token.test.mjs` — the colocated vitest suite, including
  the counterexample legs: expired, wrong audience, missing scope,
  over-ceiling lifetime, bad signature, malformed envelope. Falsify-then-
  restore: a deliberately rule-less implementation was run against the
  suite first (RED), then the real validator restored it (GREEN) — the
  committed counterexamples are the permanent record of that falsification.
  The suite runs continuously as a CI step in the `gates` workflow's job
  (`tools/test/run-tools-tests.sh`, after the gate DAG, on the
  materialized tree) — the PR #285 review flagged that a manually-runnable
  net protects nothing, so a validator regression now turns CI red.

## 8. Security notes

- No credential, key, or password enters git — v0 has nothing to leak, v1's
  tokens are short-lived and minted per run.
- Compromise map: v0's blast radius is the repo/CI trust plane itself (the
  same one that holds the vendor pins and catalog keys); v1's is one
  expired-in-hours token, revocable by `jti` deny-list at the publish API.
- The consumer side never grows an auth surface because of publisher auth:
  the catalog signature (ed25519, pinned key, dual-signed rotation) remains
  the only trust the phone exercises.
