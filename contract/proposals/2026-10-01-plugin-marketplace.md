# Proposal: the plugin marketplace — a signed catalog over the frozen package format (data-protocols v1.1.0 candidate)

> **Status: ADOPTED (2026-10-01, owner decision: the mobile-side dsh plugin
> marketplace, and the plugin format is exactly the existing DSH package
> format) — frozen additively as data-protocols v1.1.0 §7.** One draft-shape
> delta: the single `signature` object became a `signatures` ARRAY (one entry
> normally, two during a rotation window) so dual-signing is expressible in
> the one frozen shape. The frozen rules live in
> [data-protocols.md](../data-protocols.md) §7; the machine schema is
> [schemas/marketplace-index.schema.json](../schemas/marketplace-index.schema.json).
> English | [简体中文](2026-10-01-plugin-marketplace.zh.md)

## Motivation

The registry is the third of the four named gaps between this repository and the
product identity ("an app with no predefined identity, defined by its profile"):
profile-as-app-manifest, **registry**, process model, runtime grants. The other
three have each moved (capability grants landed with the capability plane; the
profile manifest has its own D5 draft, issue #268); the registry has nothing.

What already exists — and this is why the proposal is thin:

- **The plugin package format is FROZEN** (data-protocols.md v1.0.0, D5):
  `manifest.json` (schema-validated, static), the per-file `integrity.json`
  ledger, the `receipts/` install journal, `plugins/<pkg>@<semver>/` layout.
- **The M3 installer is live**: `install-pipeline.js` runs the full transaction
  (tgz → sha256 → blob store → **trust-record verification** → untar → manifest
  validation → install-time capability negotiation → staging → read-back →
  promote → receipt), and `install-fetch.js` already installs over a streaming
  `httpFetch` — proven on-device against the iOS loopback carrier.
- The pipeline's own header names the missing piece: the trust record
  "stands in for **the signed catalog a real installer consults**."

Decision (owner, 2026-10-01): the marketplace is **the mobile-side dsh plugin
marketplace**, and **the plugin format is exactly the existing DSH package
format** — upstream ecosystem plugins, this repo's `system-plugins/`, and
web-client skins are ONE format. Nothing below invents a package format.

## The model (three rules)

1. **The catalog is data, not a service.** v0 is a signed static `index.json`
   plus package tarballs on plain file hosting (object storage / GitHub
   Releases). No resident server process, no database, no accounts. The phone
   is the client: discovery and install both flow through the frozen
   `httpFetch` primitive over the real network, exactly as the on-device E2E
   already exercises against the loopback carrier.
2. **The signature is the trust.** The index is signed with **ed25519**; the
   verification public key is pinned host-side by the same discipline as the
   vendor pin table (a key rollover is an index event, not an app update).
   Every entry carries the `blobSha256` / `manifestSha256` pair the installer
   already consumes as its trust record — signature over the index plus the
   existing integrity ledger means tampered hosting can never produce an
   installable package.
3. **Grants happen at install, through the frozen path.** Install-time
   capability negotiation already lives in the pipeline (a `required`
   capability the host declares unavailable rejects the install before
   unpack). The marketplace adds no grant mechanism of its own; the catalog's
   `capabilities` summary is advisory display data, the manifest stays the
   single source of truth.

## The catalog format (index.json)

```json
{
  "schemaVersion": 1,
  "marketplace": "dsh",
  "generatedAt": "2026-10-01T00:00:00Z",
  "keys": { "dsh-market-1": "ed25519-pub-base64" },
  "entries": [
    {
      "id": "dsh-office",
      "version": "0.1.0",
      "type": "service",
      "tgzUrl": "https://…/dsh-office@0.1.0.tgz",
      "blobSha256": "…",
      "manifestSha256": "…",
      "capabilities": { "required": ["fsRead", "fsScope"], "optional": [] },
      "summary": { "en": "…", "zh": "…" }
    }
  ],
  "signature": { "key": "dsh-market-1", "value": "ed25519-base64" }
}
```

- `keys` carries the CURRENT verification key set; a rotation publishes a new
  index signed by both the outgoing and incoming key for one rotation window,
  then drops the outgoing one. Hosts pin the initial key out-of-band (repo
  config) and learn rotations only from dual-signed indexes.
- `entries[]` mirrors the frozen manifest fields the installer and the UI need
  **before download**; anything else is read from the package's own
  `manifest.json` after fetch. `blobSha256`/`manifestSha256` ARE the pipeline's
  trust record — the resolver passes them through untouched.
- The signature covers the canonical JSON of everything except `signature`
  itself.

## The install flow (one new seam: the resolver)

```
marketplace.lookup(id@range?)          → entry (from the cached, verified index)
  → installFromFetch({ url: entry.tgzUrl, id,
      trust: { blobSha256, manifestSha256 }, … })   // EXISTING, unchanged
```

`install-fetch.js` and `install-pipeline.js` are **not modified**. The new code
is a resolver module (index fetch + signature verify + entry lookup + cache
invalidation policy) plus a small marketplace UI face. Rejections are the
installer's existing `InstallRejected` vocabulary: bad signature, unknown key,
integrity mismatch, missing entry — each auditable.

## What v0 deliberately excludes (named non-goals)

- **No user accounts.** Publisher v0 is the owner's token (the catalog is
  authored by CI from the repo, exactly like the vendor pin table); consumers
  are the already-vendored anonymous device identity.
- **No resident marketplace backend.** Nothing to run, nothing to attack; the
  catalog is reproducible from the repository.
- **No ratings, payments, or search infrastructure** — the v0 catalog is small;
  the index is fetched whole.
- **No auto-update policy.** The index exposes versions; whether a profile
  upgrades is profile policy (belongs to the profile-manifest proposal, #268).

## Evolution (named, not designed)

- **v1 — publisher API:** third parties push packages through a
  registry service. Because the DSH package is an npm-shaped tarball,
  **Verdaccio** is a protocol-compatible shortcut for the publish/serve side
  without touching the client.
- **v2 — identities and review:** publisher accounts via an OIDC IdP
  (Logto-class, TS, self-hostable) and an Open VSX-style review model
  (metadata lint + human review tiers). The client contract does not change.

## Alternatives considered

- **Deploy Open VSX / Flathub now** (full marketplace backends): rejected for
  v0 — both are heavy server stacks (Spring/Postgres, FastAPI/Postgres) built
  around THEIR package metadata models; our format is frozen elsewhere and our
  installer seam already exists. Their publisher/review MODELS are the part
  worth copying, at v2.
- **Adopt the npm registry protocol as the package format**: unnecessary — the
  DSH format is already frozen and IS tarball+manifest shaped; protocol
  compatibility with npm tooling (Verdaccio) survives as a v1 deployment
  option regardless.
- **Unsigned catalog with transport-only trust (HTTPS)**: rejected — it makes
  the hosting account the single point of compromise; the ed25519 layer keeps
  the trust in the repo/CI, out of any server.

## Verification plan

- A `marketplace.install` e2e leg per the house pattern (scenario-id log
  match): loopback-served index + tgz → signature verify → resolve →
  `installFromFetch` → receipt; capability-negotiation rejections included.
- A tamper ladder as rejection cases: bad signature / unknown key / rotated
  key outside its window / blob digest mismatch / manifest digest mismatch —
  each must reject `InstallRejected` and audit, with nothing staged.
- Key rotation drill: dual-signed index accepted by a host pinning the
  outgoing key; post-window single-signed index rejected by the stale pin.

## Version

data-protocols **v1.1.0 candidate** (additive: the catalog format and its
signature rules extend the frozen package protocols; zero new gateway
primitives — the flow rides `httpFetch` and the existing install pipeline).
