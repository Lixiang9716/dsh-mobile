# Agent Note: registry provenance: installedAt records the first install and survives re-installs; every real row change stamps updatedAt (loop-l)

Status: implemented
Related: D9

## Problem

A plugin update implemented as re-install erased the plugin's provenance:
the registry row's `installedAt` was rewritten with the update's timestamp
(tester r1→r2: quick-notes 03:05:04.879Z → 03:29:54.501Z) and no
`updatedAt` recorded the change, so nothing could distinguish "installed
at creation" from "reinstalled at every edit" (loop-l). The writer is the
plugin-manager tool's install leg — it proposes a fresh
`installedAt: new Date().toISOString()` on EVERY call
(system-plugins/dsh-plugin-manager-tools/index.js:241) — and
`upsertRegistryRow`'s field merge rewrote the existing row's stamp with it.

## Decision

Provenance becomes a registry-module contract in `upsertRegistryRow`
(runtime/spike/workspace-registry.js), not a caller convention: an
incoming `installedAt` is discarded when the row already carries one
(first-install wins — the tool's per-call timestamp is exactly that, a
proposal), and every REAL change stamps `updatedAt` (an idempotent
re-install leaves the row byte-identical, stamp churn included). A fresh
install records both fields. The tool keeps proposing `installedAt` — as
a first-install value it is correct; the registry decides what survives.

## Verification

`test/panel/plugin-manager-write-legs.test.js` gains four cases driving
`upsertRegistryRow` over an injected VFS: fresh install records both
stamps; re-install with a fresh `installedAt` keeps the FIRST stamp while
the update itself lands and `updatedAt` advances; an idempotent
re-install changes nothing (no stamp churn); a model-authored row without
`installedAt` adopts the incoming one (backfill). Panel suite: 194 passed
(14 files). Closure copies synced (android assets + harmony rawfile);
closures gate green.

## Alternatives considered

- Dropping `installedAt` from the tool's proposal (fix the caller only):
  rejected — the contract belongs to the registry any caller can hit; a
  second caller (or the model adopting rows through raw writes into an
  upsert flow) would reintroduce the erase, and the module's merge is
  where the #340 field-ownership semantics already live.
- Recording an update HISTORY array per row: rejected for now — nothing
  consumes it, and the registry doc is model-visible state whose shape
  the creation prompts reason about; one `updatedAt` carries loop-l's
  need at the smallest surface.
- Preserving the EARLIEST of the two timestamps instead of the existing
  row's: equivalent today (the existing stamp IS the earliest); the
  simpler keep-existing rule avoids defining ordering semantics for
  clock-skewed callers.
