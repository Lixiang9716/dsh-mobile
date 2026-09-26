# contract/

**The contract-freeze deliverable — the first priority of the entire project. Status: FROZEN v1.0.0 (2026-09-19, D5), additively extended to v1.5.0 (2026-09-26).**

No implementation code lands before this directory is frozen (D5: contract first). It is now.

## Contents

| Artifact | What it freezes |
| --- | --- |
| [primitives.md](primitives.md) | Capability gateway primitive table v1.5.0 — 24 primitives (v1.1.0–v1.5.0 additive), typed, permission-flagged, versioned; event channels; audit; conformance (`gateway@1`) · [简体中文](primitives.zh.md) |
| [primitives.d.ts](primitives.d.ts) | Machine-readable primitive surface (TS declarations) |
| [data-protocols.md](data-protocols.md) | Bundle layout · plugin manifest · integrity ledger · install receipt transaction · capability string grammar · [简体中文](data-protocols.zh.md) |
| [schemas/manifest.schema.json](schemas/manifest.schema.json) | Plugin manifest, `schemaVersion: 1` (JSON Schema 2020-12) |
| [schemas/integrity.schema.json](schemas/integrity.schema.json) | Installed-tree digest ledger, `ledgerVersion: 1` |
| [schemas/receipt.schema.json](schemas/receipt.schema.json) | Install/remove transaction receipt, `receiptVersion: 1` |
| [proposals/](proposals/) | Draft additions under debate (D5 proposals — nothing frozen, nothing implemented) · current: [the event channel](proposals/2026-09-26-event-channel.md) (a v1.6.0 candidate) and [the render surface](proposals/2026-09-26-render-surface.md) (a v1.7.0 candidate) |

## Reading order

1. [primitives.md](primitives.md) — the service surface every host implements and every
   plugin negotiates against.
2. [data-protocols.md](data-protocols.md) — the data every host stores and every install
   transaction writes.
3. Schemas — the validators enforcing the above.

## Change discipline

The contract is semver-versioned and evolution-gated: shapes frozen here are immutable in
`1.x`; additions are minor bumps; any shape change is a major bump with a migration note
(primitives.md §8, data-protocols.md §6). Proposals start as an Agent Note citing D5 —
never a drive-by edit.
