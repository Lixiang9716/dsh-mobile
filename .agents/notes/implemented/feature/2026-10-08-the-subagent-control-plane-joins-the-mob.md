# Agent Note: the subagent control plane joins the mobile spine — subagents/* answer from the vendored runtime

Status: implemented
Related: D9, D6, T-0050 (item 2)

## Problem

The official page's subagent surface drives three session-controller legs
the seat never claimed — `subagents/list` (the @-mention Subagents tab's
roster), `subagents/prompt` (browser-authored delivery to a continuable
child), and `subagents/interruptByParent` — so every one of them ended in
the carrier's `gateway/unimplemented` envelope. The vendored
`@deepseek-ai/dsh-subagent` runtime already sat in the closure (harmony's
SPINE_PKG_DSH and the committed android assets carry it; the iOS TREES
embed it), unmounted and unclaimed.

## Decision

boot.js mounts the vendored `SubagentRuntime` (service `subagents`,
schema-default shape: depth 1, 8 active children) right after the
settings/projection mounts, plus the vendored `SessionQueryEngine`
(service `sessionQuery`, `inject: ['sessions']`, live-preferred) — the
catalog's `prepareListing` HARD-requires the sessionQuery service and
refuses without it (`SUBAGENT_CONTROL_QUERY_UNAVAILABLE`). The write
surface claims the three legs through `upstream/web-write-subagents.js`:
thin forwarders onto `ctx.subagents` (the catalog-forwarder convention —
`gateway/unavailable` on the bare compose-only embed), wire spellings per
the generated dsh-api-remotes descriptors (list takes the plain
`parentSessionId`, prompt nests under `request`, interrupt takes the three
json fields). This composition registers NO delegation provider, so the
catalog answers the honest empty roster (`{entries: [],
parentAvailable}` — live over a live parent, `parentAvailable: false`
cold), a prompt to an address with no live child refuses with the
service's own `subagent/not-resumable`, and interrupt keeps the upstream
absent-target no-op (`{accepted: true}`). The service's own structured
codes pass to the page unchanged (the vendored RemoteError's
isDSHRemoteError marker rides both errorOf pass-throughs).

Staging: `dsh-session-query` was vendored (npm face) but staged nowhere —
the android stager's npm-at-own-path loop grows `dsh-session-query`,
harmony gains `stage_npm_face_at_dsh_path session-query` + its
BUNDLE_FILES rows, and the iOS embedder's npm-face TREES spread grows the
row (the SpikeBundle.c regenerates in CI's Xcode pre-build phase). The
subagent package itself and chunked-list/util-time were already staged on
every platform. `fileUploads/upload` stays a pinned residue with the
mount chain named: the vendored `FileUploads` service injects agents +
attachments + commands + connection, the mounted AttachmentStore's
default provider refuses verbatim files, and none of the three missing
services is mounted — a real backend is an outboard provider composition
of its own.

Verification: the mounted runtime driven directly under Node through a
real cordis mini-spine (SessionStore + AgentRegistry + SystemPrompt +
ToolRuntime + LlmRuntime + SessionProjectionRegistry + SettingsMemory +
SessionQueryEngine + AgentLoop's configured agent + SubagentRuntime) —
the three legs asserted green (empty roster/parentAvailable, the
not-resumable refusal with the service's own code, the interrupt no-op,
the cold-parent read). The coverage probe's gap list shrinks to the true
residues and its session-legs phase drives the same three legs through
the full boot.

## Alternatives considered

- Registering a delegation provider (dsh-subagent-fork-in-process) so
  children actually run: lost for this round — the provider composition
  drags the delegation tool row, child agent options, and the model-input
  attachment story; the empty roster is the honest mobile state until
  that composition lands, and the mounted runtime is exactly the surface
  the provider will register into.
- Keeping subagents/* unclaimed until a provider exists: lost — the
  catalog/interrupt legs are complete upstream faces over mounted
  services, and the page's Subagents tab reads an honest empty roster
  instead of firing an unimplemented toast.
- A hand-written catalog over ctx.sessions (no SubagentRuntime): lost —
  D9 forbids reimplementing the vendored service; the runtime is vendored
  and its injects are all mounted.
