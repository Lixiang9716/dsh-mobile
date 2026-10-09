# Agent Note: session/delete retires a page-created session through the vendored AgentHandle.dispose

Status: implemented
Related: D9, T-0210, the 2026-10-10 terminal verification (six probe sessions
with no way to remove them)

## Problem

The 2026-10-10 device verification left six probe sessions on the phone:
the page can create and prompt sessions, but the seat claims no
`session/delete` (nor any archive), so every probe ever created against a
device build stays in `session/list` forever — and a list that only grows
is not a list a user can manage. The Phase-B carrier answered the
endpoint's absence with `gateway/unimplemented`.

Neither reference surface defines the operation: the upstream
session-controller at the pin (packages/api/session-controller/src/) has
no delete command, and the vendored `@deepseek-ai/dsh-session` store
exposes no delete/forget — its only removal path is the detach disposer
`enter()` returns. So "align with upstream" had no upstream to align with,
and inventing a storage-level deletion would have been D9-forbidden
product behavior invented from nothing.

## Decision

`upstream/web-write-session-delete.js` (a new adapter split from
web-write.js at the code-size gate, spread into the HISTORICAL claim set)
implements `session/delete` on top of the one teardown primitive the
vendored family DOES expose: the `AgentHandle.dispose` capability
(@deepseek-ai/dsh-agent lib/types/index.d.ts — "stops the loop, awaits its
exit, unregisters the agent, removes its session from the store, and
finally unwinds its scoped world", emitting `agent/disposed` +
`session/disposed`). The write surface is the seat that creates
page sessions, so `session/create` and `session/fork` now capture their
handle's `dispose` into `deps.agentDisposes` (a per-surface Map), and the
delete handler consumes exactly that capability — the vendored contract
"among consumers, only the holder can tear this agent down" holds by
construction.

The narrowed decisions, each pinned by the spine suite
(test/panel/spine/session-delete.test.mjs):

- **A running turn refuses** with `session/agent-busy` +
  `details.reason:'running'` (the controller's own mid-work refusal code,
  commands.prompt's): a turn's partial output is user-visible state and
  `session/cancel` is the explicit verb for stopping it — silently killing
  a watched turn is a destructive surprise. The vendored dispose WOULD
  drain a running turn (`machine.cancel({kind:'disposed'})`); we decline
  before reaching it.
- **No journal file is deleted because none exists**: the mobile profile
  mounts no persistence backend (boot.js config.agents create path — no
  sessionPersistence; upstream/shims/dsh-session-persistence.js is
  linkage-errors-only), so the in-memory store removal inside dispose IS
  the whole deletion.
- **The boot carrier refuses** with `gateway/unavailable` +
  `details.reason:'no-dispose-capability'`: the loop fiber owns that
  handle (config-created agents are loop-owned, dsh-agent's own doc), the
  surface holds no capability for it, and lying with `session/not-found`
  would contradict the `session/list` the page just read.
- **The page projections answer from the store alone**: after the dispose,
  `session/list` stops carrying the id and `session/page` (plus every
  session-addressing handler) answers `session/not-found` through the
  shared resolution — no per-endpoint tombstones, no local flags. A second
  delete is the same `session/not-found`.
- **The workspace registry drops the id** (the seeded workspace's
  sessionIds) and publishes the upsert increment on the same channel
  `attachWorkspace` uses, so a page re-attach's `workspace/follow`
  baseline agrees with the list.

## Alternatives considered

- **A store-level `sessions.forget(id)`** (delete the SessionStore entry
  directly, leave the agent live): rejected — the vendored store
  deliberately exposes no such API, and an agent whose session vanishes
  underneath it leaves the loop driving a ghost (the exact
  ordered-lifecycle hazard dsh-agent's enter/announce/detach machinery
  exists to prevent).
- **Allow deleting a running session** (lean on dispose's own drain):
  rejected — the drain aborts a turn the user can see mid-flight, which
  is `session/cancel`'s job with an explicit user gesture; a delete that
  also kills a running turn conflates two verbs and one of them becomes
  irreversible.
- **Soft delete / archive** (hide from list, keep the session): rejected
  for this round — the upstream wire has no archive contract for sessions
  at the pin, and the mobile profile's actual need is retirement of probe
  and scratch sessions; an archive plane would be an invented product
  surface (D9) with no page to drive it.
- **Deleting from a fresh `agents.create` capability lookup** (re-resolve
  a handle at delete time): impossible — the handle exists only at
  create/resume; the registry returns bare Agents afterwards, which is
  precisely why the capture happens at the create/fork sites.

## Consequences

- Sessions created before this change (the boot carrier excepted) by an
  OLDER build have no captured handle; after an app restart they are gone
  anyway (in-memory), so the six probe sessions the device verification
  left are retired by the restart + the new endpoint's E2E walk, not by
  data migration.
- A thrown teardown keeps the capability (the map entry is removed only
  after the dispose settles), so a failed delete is retryable rather than
  permanently stuck.
- The parity/staging family carries the new module (harmony BUNDLE_FILES,
  iOS RESOURCES, android assets mirror, vendor-official roster) — the
  standard new-runtime-module recipe, verified by the staging checks.
