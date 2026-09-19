# Agent Note: M0 contract freeze: gateway primitives v1.0.0 + data protocols

Status: implemented
Related: D5

## Problem

D5 promises that `contract/` freezes before any implementation code lands, but the directory
held only a placeholder README — nothing was actually freezable. Every additional day of
M1 prep without a frozen surface widened the same three risks D5 exists to kill: the four
platforms (iOS / Android / HarmonyOS / desktop interop) start drifting before the shared
foundation exists; capability negotiation has no referent to negotiate against (a
`RuntimeDescriptor` needs a named, versioned surface to declare); and the first host code
written would set de-facto shapes that later get retrofitted as "the contract" — the
code-first freeze AI-era rework cost D5 explicitly rejects.

## Decision

`contract/` is frozen at v1.0.0 (2026-09-19):

- **Primitive contract** (`contract/primitives.md` + `.zh.md` + `primitives.d.ts`): the
  capability gateway's narrow table — 9 primitives (`fsRead`, `fsWrite`, `fsScope`,
  `httpFetch`, `notify`, `presentApproval`, `presentPicker`, `keychainGet`, `keychainSet`),
  each with a closed typed shape, a permission flag, and mandatory audit; two bridge event
  channels (`app.state`, `notify.response`); a 7-code structured `GatewayError` model with
  fail-loud unknown-code handling; async-only dispatch onto the runtime queue (D8); the
  negotiation string `gateway@1`; conformance rules (implement all nine or declare
  `unavailable` — never fake, ARCHITECTURE.md §12); semver evolution policy (frozen shapes
  immutable in 1.x, additions = minor, shape changes = major).
- **Data protocols** (`contract/data-protocols.md` + `.zh.md`): bundle layout under
  `plugins/<pkg>@<semver>/` (manifest.json + integrity.json + bundle/ + web/, extending the
  ARCHITECTURE.md §7 profile picture with a `receipts/` transaction journal); static
  manifest semantics (schemaVersion 1, required/optional capability negotiation,
  deterministic activate/deactivate hooks); integrity ledger (sha256 per file); the
  install transaction (tgz → `cache/blobs/<sha256>` → verify → atomic unpack → receipt
  write as commit point, pending receipts replayed at startup) with append-only receipts.
- **JSON Schemas** (`contract/schemas/`): manifest, integrity, receipt — draft 2020-12,
  the validators hosts and tooling enforce.

## Alternatives considered

- **Code-first, freeze after M1 spikes**: rejected — that is exactly what D5 forbids; the
  first spike would have set shapes under time pressure and the other platforms would
  inherit them as fait accompli.
- **7-primitive table exactly as ARCHITECTURE.md §4 names it** (fsRead / fsWrite / httpFetch
  / notify / presentApproval / presentPicker / keychain, keychain as one primitive):
  rejected — a single `keychain` primitive cannot carry read/write permission separation,
  and user-granted scope persistence has no home at all; the table therefore splits
  keychainGet/keychainSet (least-privilege flags match the fs read/write split) and adds
  `fsScope` as the explicit authorization primitive. 9 ≤ the ≤10 ceiling.
- **Express primitives as JSON Schema too** (one schema formalism for everything): rejected
  — the runtime and plugins are TypeScript, so `.d.ts` is the native, checkable surface for
  call signatures; JSON Schema is reserved for the data files where cross-language hosts
  (Swift/Kotlin/ArkTS) actually need validators.
- **A 10th primitive (clipboard) to round out the table**: deferred — nothing in M0–M2 needs
  it; the minor-version path exists precisely so additions can follow negotiation demand.
  Restraint is the point of the narrow table.
- **`fsBookmark` (Apple vocabulary) instead of `fsScope`**: rejected — contract names must
  be platform-neutral or hosts would map names unevenly; "scope" is the concept,
  "bookmark" is one platform's mechanism.

## Consequences

Hosts now have a concrete conformance target: `hosts/ios` M1 work builds against
`gateway@1` and the three schemas, and "the contract" has an address to cite. Negotiation
gains its referent. The `receipts/` journal is a deliberate extension of ARCHITECTURE.md §7's
storage picture (flagged here rather than editing the architecture doc). Breaking a frozen
shape now costs a major version bump — that friction is the product.
