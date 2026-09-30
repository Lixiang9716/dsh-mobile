# Data Protocols — Bundle Layout, Manifest, Receipt, Signed Catalog (v1.1.0)

> **Status: FROZEN at the contract freeze** (2026-09-19, decision D5); **additively extended to
> v1.1.0** (2026-10-01: §7, the signed catalog — proposal
> [2026-10-01-plugin-marketplace.md](proposals/2026-10-01-plugin-marketplace.md), ADOPTED). These
> are the four data protocols every host and every plugin build must honor. Machine-readable
> schemas live in [schemas/](schemas/). Companion to [primitives.md](primitives.md).
> English | [简体中文](data-protocols.zh.md)

## 1. Bundle layout

An installed plugin is a self-contained directory under a profile:

```
profiles/<name>/
├── profile.json
├── cordis.patch.yml
├── plugins/<pkg>@<semver>/
│   ├── manifest.json          # static manifest (§2) — schema: schemas/manifest.schema.json
│   ├── integrity.json         # per-file digest ledger (§3) — schema: schemas/integrity.schema.json
│   ├── bundle/                # JS ESM sources (code as data), entry per manifest
│   └── web/                   # Web Client assets; present only for type "web-client"
├── receipts/                  # install/remove transaction journal (§4)
├── sessions/*.jsonl
└── state/
```

- `<pkg>` is the manifest `id`, `<semver>` the manifest `version` — one directory per
  version, so downgrade and side-by-side are data operations.
- `bundle/` sources are read by the host's ESM loader and may be precompiled to bytecode
  into `cache/blobs/` by the host; the cache is regenerable and carries no authority.
- The `receipts/` journal (transaction records, §4) extends the storage picture of
  ARCHITECTURE.md §7; sessions and state remain as specified there.

## 2. Plugin manifest

`manifest.json` is **static**: reading it must never execute code. Schema:
[schemas/manifest.schema.json](schemas/manifest.schema.json).

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | manifest schema version, `1` in this freeze (§6) |
| `id` | string | package identity, e.g. `dsh-fs-ios`; stable across versions |
| `version` | string | semver 2.0.0 of this package |
| `type` | `"service"` \| `"web-client"` | service = JS implementation plugin; web-client = whole Web Client plugin |
| `entry` | string | ESM entry relative to `bundle/` (required for `service`) |
| `web` | string | assets directory relative to the package root (required for `web-client`) |
| `capabilities` | object | `required[]` / `optional[]` capability strings (§5) |
| `hooks` | object | optional `activate` / `deactivate` ESM export names — the deterministic lifecycle |

Semantics:

- **Negotiation**: the host activates a plugin only if every `capabilities.required` entry
  is satisfied by its `RuntimeDescriptor`; `optional` entries tune behavior when present.
  The host's own surface includes `gateway@1` (the primitive contract) plus its declared
  primitives. A manifest requesting a primitive the host declared unavailable fails
  negotiation — visibly, never silently.
- **Lifecycle**: `activate` runs after negotiation; `deactivate` before unload. Hooks are
  plain named exports of the entry module, invoked once, in order, with no re-entrancy.
- **Isolation**: one QuickJS runtime per plugin, zero sharing; all platform access flows
  through the gateway primitives ([primitives.md](primitives.md)).

## 3. Integrity ledger

`integrity.json` covers every file of the installed tree so any host can verify any install
without trusting the transport. Schema:
[schemas/integrity.schema.json](schemas/integrity.schema.json).

- `algorithm`: `"sha256"` (only value in v1).
- `files`: map of package-root-relative path → lowercase hex digest.
- `manifestSha256`: digest of `manifest.json` itself (also present in `files`).

A tree whose recomputed digests mismatch `integrity.json` is corrupt: hosts refuse to
activate it and surface the offending paths.

## 4. Install transaction & receipt

Install is a **content-addressed, crash-safe transaction** (mirroring upstream
`desktopPnpm.installPlugin` recovery-receipt semantics):

1. fetch the package tgz → digest it → store at `cache/blobs/<sha256>`;
2. verify the digest; mismatch aborts before anything is unpacked;
3. atomically unpack into `plugins/<pkg>@<semver>/` and re-verify against the bundled
   `integrity.json`;
4. append the receipt to `receipts/` — the receipt write is the **commit point**.

The receipt is the journal of record; schema:
[schemas/receipt.schema.json](schemas/receipt.schema.json).

- `status: "pending"` — steps 1–3 interrupted (crash, power loss). At startup the host
  replays every pending receipt: complete the install if the staged tree verifies, else
  roll it back and mark the receipt `rolled-back`. A host never leaves a pending receipt
  unexamined.
- `status: "committed"` — the installed tree is authoritative; `previousVersion` records
  what it replaced (`null` on fresh install).
- `action: "remove"` — symmetric: the tree is unlinked, the receipt records the removed
  `version` and `previousVersion` for audit.
- Receipts are append-only; rewriting or deleting a committed receipt is a contract
  violation.

## 5. Capability string grammar

Shared with the primitive contract: `<name>` or `<name>@<major>`. Names are lowercase
alphanumeric with `-`/`.`. Reserved: `gateway` (this contract set, e.g. `gateway@1`); every
primitive permission flag of [primitives.md](primitives.md) is a valid capability name.

## 6. Versioning

- The four schemas are versioned **independently of the primitive contract**: manifest
  carries `schemaVersion: 1`, receipt carries `receiptVersion: 1` (integrity `ledgerVersion: 1`),
  the catalog index carries its own `schemaVersion: 1` (§7).
- Additive optional fields = minor; any removal, retype, or required-field addition = major
  with a migration note. Hosts reject manifests/receipts/catalogs whose major version they do
  not understand — loudly (fail-loud rule), never by best-effort parsing.

## 7. The signed catalog (v1.1.0 — the plugin marketplace)

The registry half of the product identity is **a signed static `index.json` plus package
tarballs on plain file hosting** (object storage / GitHub Releases). The catalog is data, not a
service: no resident server process, no database, no accounts; it is reproducible from the
repository (authored by CI, the same discipline as the vendor pin table). Discovery and install
both ride the frozen `httpFetch` primitive; nothing here invents a package format — packages on
the catalog are exactly the §1–§4 format. Proposal:
[2026-10-01-plugin-marketplace.md](proposals/2026-10-01-plugin-marketplace.md) (ADOPTED,
owner decision 2026-10-01: the mobile-side dsh plugin marketplace, one format for upstream
plugins, this repo's `system-plugins/`, and web-client skins). Schema:
[schemas/marketplace-index.schema.json](schemas/marketplace-index.schema.json).

```json
{
  "schemaVersion": 1,
  "marketplace": "dsh",
  "generatedAt": "2026-10-01T00:00:00Z",
  "keys": { "dsh-market-1": "ed25519-public-key, base64 (32 bytes)" },
  "entries": [
    {
      "id": "dsh-office", "version": "0.1.0", "type": "service",
      "tgzUrl": "https://…/packages/dsh-office@0.1.0.tgz",
      "blobSha256": "…", "manifestSha256": "…",
      "capabilities": { "required": ["fsRead"], "optional": [] },
      "summary": { "en": "…", "zh": "…" }
    }
  ],
  "signatures": [ { "key": "dsh-market-1", "value": "ed25519-signature, base64 (64 bytes)" } ]
}
```

- `entries[]` mirrors the frozen manifest fields a consumer needs **before download**;
  everything else is read from the package's own `manifest.json` after fetch.
  `capabilities` here is ADVISORY DISPLAY DATA — the package manifest (§2) stays the single
  source of truth, and grants happen only at install time through the §2 negotiation in the
  frozen pipeline. `blobSha256`/`manifestSha256` ARE the §4 transaction's trust record.
- `keys` carries the CURRENT verification key set. `signatures` carries ONE ed25519 signature
  (PureEdDSA per RFC 8032) normally, TWO during a rotation window (below).

### 7.1 Signature rules

- The signature covers the **canonical JSON** of everything except `signatures` itself:
  UTF-8 of the JSON encoding with object keys recursively sorted (lexicographic by code unit),
  arrays in order, no insignificant whitespace.
- **The signature is the trust.** A consumer refuses a catalog it cannot verify, and trusts no
  key it did not pin or learn per §7.2. Verification failure, an unknown signing key, a
  malformed catalog, and a missing entry are all loud refusals in the installer's existing
  `InstallRejected` vocabulary — each auditable, nothing staged.
- The verification public key is pinned host-side, out-of-band, by the same discipline as the
  vendor pin table (a key rollover is an index event, not an app update). The initial pin is
  repo configuration; private keys live only in the signing CI environment — never in the
  repository.

### 7.2 Key rotation

A rotation publishes, for one rotation window, an index signed by BOTH the outgoing and the
incoming key. A host verifies it under a key it already trusts, then LEARNS the incoming key —
but only from such a dual-signed, verified index: a key a host has not pinned and has not seen
co-sign a verified index is an unknown key, and a catalog signed only by it is refused. The
window then closes: the published index drops the outgoing signature, and hosts that observed
the window continue; hosts that never did (a stale pin) refuse the post-window catalog until
they observe a dual-signed index. Learning is session state, not persistence — a restarted
host falls back to its pin, so a compromised host cannot shortcut the window discipline.

### 7.3 Consumer flow (the resolver seam)

```
marketplace.lookup(id@range?)   → verified catalog entry
  → installFromFetch({ url: entry.tgzUrl, id: entry.id,
      trust: { blobSha256, manifestSha256 }, … })     // §4, EXISTING and unchanged
```

The resolver (index fetch over `httpFetch` + §7.1 verification + §7.2 rotation state + entry
lookup) is the ONE new seam; the §4 install transaction is unchanged — the resolver passes the
signed trust record through untouched, so tampered hosting can never produce an installable
package (the signature covers the digests; the transaction re-derives them from bytes).
