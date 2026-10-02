# Agent Note: Per-session model selection: staged multi-model roster and the session/selectModel wire leg

Status: implemented
Related: D9

## Problem

The composer's model dialog (dsh-client-ui-model-selection) renders its rows
from `session/modelCatalog` and commits through `sessions.selectModel` → the
`session/selectModel` wire endpoint — but this host's catalog was
single-model and the endpoint was unclaimed, so a user who stages a
credential serving several models sees one row, and picking anything is
impossible (the desktop's per-session switching has no mobile counterpart).
The catalog the dialog needs is a fact of the staged credential
(`config.json`), which no runtime-side code can invent — the roster has to
ride the same path the credential itself takes: host seat → runtime.config →
the boot route → the write surface.

## Decision

The staged credential's optional `models` roster (entries `{id, name}`)
flows end to end: SessionServe.loadCredential parses it into `Credential`
(a malformed roster voids the whole credential — the partial-file precedent)
and `runtimeConfig()` delivers it as `llmModels`; `stagedRoute` validates it
fail loud (rule 5: a malformed entry throws naming the offending shape) and
carries it as `route.models`; the write surface's `session/modelCatalog`
emits the roster as the provider group's model rows (the single configured
model when no roster is staged — those boots stay byte-identical), and the
newly claimed `session/selectModel` (makeModelSelectionHandlers, the
historical claim set, not coverage) resolves the live agent like every
catalog adapter, validates the pick against the ONE boot route (provider
equality; membership in the roster when present), appends
`model/selection` to the live session journal exactly as the desktop
controller's `selectForNextRequest` does — the modelSelection projection
(issue #306) folds it into `pending` and the next request header honors it —
and returns the desktop's `{selected}` envelope. An unroutable pick fails
with the upstream's own vocabulary, `session/model-unavailable`.

## Alternatives considered

- Real `commands.selectModel` (vendored dsh-api-session-controller) on the
  mobile composition: lost — it needs the controller's llm resolveCallConfig
  + default-model persistence stack, none of which this composition mounts;
  forwarding the journal append (the one durable, projected fact) keeps the
  dialog's contract while the desktop-only save legs stay desktop-only.
- Keeping the catalog single-model and deriving rows from a new
  runtime-side settings namespace: lost — the roster is a property of the
  staged credential file, so a second home for it invites drift with the
  exact file the transport is built from; one path, one source.
- Silent tolerance of a malformed roster (skip bad rows, ship the rest):
  lost to rule 5 — a half-parsed roster surfaces weeks later as a missing
  row in a dialog, unattributable; voiding the credential falls back to the
  scripted route, which is loud in the serving log the same session.
