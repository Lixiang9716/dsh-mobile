# Data Protocols — Bundle Layout, Manifest, Receipt (v1.0.0)

> **Status: FROZEN at the contract freeze** (2026-09-19, decision D5). These are the three data protocols
> every host and every plugin build must honor. Machine-readable schemas live in
> [schemas/](schemas/). Companion to [primitives.md](primitives.md).
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

- The three schemas are versioned **independently of the primitive contract**: manifest
  carries `schemaVersion: 1`, receipt carries `receiptVersion: 1` (integrity `ledgerVersion: 1`).
- Additive optional fields = minor; any removal, retype, or required-field addition = major
  with a migration note. Hosts reject manifests/receipts whose major version they do not
  understand — loudly (fail-loud rule), never by best-effort parsing.
