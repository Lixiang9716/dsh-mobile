# Agent Note: the composer model dialog resolves — the mobile spine publishes the modelSelection projection (issue #306)

Status: implemented
Related: D9

## Problem

The composer's model dialog hung on "Loading models…" forever, even after a
completed turn. The data plane was healthy (`session/modelCatalog`,
`llm/listProviders`, `llm/listConfigurableProviders` all answered with the staged
BYOK model) and the Settings → Models tab rendered — only the composer dialog
stuck. Root cause: `dsh-client-ui-model-selection` gates its store on a
"durable model selection projected from Session history" — the journal's
`projections.modelSelection` entry. That projection unit is registered by
`dsh-api-session-controller`, which the Phase-B mobile composition does not
apply; the journal baseline carried `"projections":{}` permanently, the client's
projected store stayed `undefined`, and `syncInputs` pinned the dialog at
"loading".

## Decision

`runtime/spike/upstream/model-selection-projection.js` registers a first-party
`modelSelection` unit on the session-projection registry — the registry's
designed extension seam — mirroring the vendored definition at the pin exactly
(key `modelSelection`; `model/selection` events set `pending`; `request/header`
events adopt the served `{provider, model, reasoningEffort?}` into `lastUsed`
and clear an honored `pending`; view `{lastUsed, next: pending ?? lastUsed}`).
boot.js registers it after `mountSpine` (`mountModelSelectionProjection`) —
unconditional, since the model dialog exists on every page surface and the
registry folds lazily over the in-memory log. The host mirrors carry it:
android's whole-dir upstream mirror (automatic), harmony's `SPINE_OURS` row +
`Index.ets` BUNDLE_FILES row (952 = 952 both directions), iOS `gen_bundle_header.py`
RESOURCES row (the `upstream/tool-present.js` dynamic-import precedent).

## Alternatives considered

- Applying the whole `dsh-api-session-controller` in the mobile boot: rejected —
  the controller drags the full desktop session-API surface (connections,
  fetch registry, deep-page faces) the Phase-B composition deliberately
  replaces with its own coverage plane.
- Exporting `installModelSelectionProjection` from the vendored package and
  calling it: rejected for D6 — upstream packages stay verbatim at the pin;
  the registry seam exists precisely so compositions register projection
  units without touching upstream code.
- Leaving the dialog on the Settings → Models tab only: rejected — the
  per-conversation switcher is the composer's own surface; the settings tab
  cannot switch the current conversation's model.
