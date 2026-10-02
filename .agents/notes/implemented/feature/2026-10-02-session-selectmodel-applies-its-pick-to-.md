# Agent Note: session/selectModel applies its pick to the next request — the mobile seat installs the vendored model-selection holder

Status: implemented
Related: D9

## Problem

PR #308 gave the mobile seat a working `session/selectModel` wire leg: it
validates the pick against the boot route's roster and appends the
`model/selection` intent to the live session journal, so the modelSelection
projection's `pending` (and the dialog's `next` view) moves. But nothing
applied the pick to the request build: the desktop commits a selection
through dsh-api-session-controller's `selectForNextRequest`, which ALSO sets
the agent-scoped holder's `current` — the slot the vendored
`installModelSelection` (@deepseek-ai/dsh-agent) couples to the
`system-prompt/assemble` and `agent/request` waterfalls. Without the holder,
every turn after a pick kept serving the boot route: the next
`request/header.config.model` never equaled the selection, the projection's
`lastUsed` never followed `next`, and the composer's model dialog was a
no-op with a journal trail. Reimplementing the desktop's selection mechanics
in-house was not an option (D9: never reimplement Harness behavior the
vendored packages already carry).

## Decision

`runtime/spike/upstream/model-selection-holder.js` (new) installs the SAME
vendored holder at boot: `mountModelSelectionHolder(ctx, bootRoute,
sessionId)` registers the modelSelection projection unit (moved verbatim
from boot.js's `mountModelSelectionProjection` so the plane has one home),
waits bounded for the configured agent (creation is async past the
AgentLoop mount), and calls the vendored `installModelSelection(agent.ctx,
holder)` with a holder mirroring the controller's `selectionFor` at the
pin — `current` reads the picked slot, else the last request header
(effort omitted when `adapterDefaults.reasoningEffort` is true), else the
boot route; `consume(provider, model, reasoningEffort)` retires a pick
equal to the served route, single-shot; `assembled` is the assembly
waterfall's snapshot field. The boot-route fallback carries the loop's
configured `reasoningEffort` (boot.js's single `agentRoute` fact, shared
with the AgentLoop config row), so the first request's config is reproduced
byte-identically — no header drift on boots that never select. The ctx's
`session/event` request/header leg drives `consume` exactly like the
controller's, so the durable journal, not a stale slot, stays the source of
truth. `session/selectModel` (web-write-catalog.js) now commits like
`selectForNextRequest`: after validation it fetches the holder
(`sessionModelSelection(agent)`, reached through a DYNAMIC import — a
static edge would drag the @deepseek-ai/dsh-agent spine into the
compose-only embed's bundle), refuses fail-loud when the boot installed
none, appends the journal intent, and sets `holder.current = selection`.
The new module joins the three embed lists (android whole-dir mirror picks
it up; harmony `SPINE_OURS` + Index.ets `BUNDLE_FILES`; iOS
gen_bundle_header.py authored files).

## Alternatives considered

- Hand-rolled apply: read the selection in web-write-catalog and rewrite the
  agent's request config from a first-party listener. Lost: it would
  reimplement `installModelSelection`'s assemble-snapshot/request-override/
  switch-notice coupling (D9) and miss the pre-step model-switch notice the
  vendored module appends; the vendored path is ~zero new mechanism.
- Applying the pick inside the handler by mutating agent options: the
  AgentLoop's options are creation-time facts, and the desktop semantics are
  explicitly a mutable selection scoped to prompt assembly — not an agent
  rebuild; also loses the effort-clearing rule (an absent selected effort
  must clear any inherited effort).
- Stashing the holder on boot.js's export: the write surface resolves agents
  through ctx, and the compose-only embed imports the catalog handlers
  without the spine — a WeakMap keyed by the live session inside the holder
  module (the controller keys its map by agent; agent id === session id by
  registry invariant) reaches both sides without widening any export
  surface.
- Feeding the holder BEFORE the journal append (controller order is
  append-then-set): chosen against — a boot without the apply leg would
  otherwise journal an intent nothing would ever honor, wedging the
  projection's `pending`; the pre-check makes the two legs atomic for the
  wire caller, and when both are installed the observable outcome is
  identical.
