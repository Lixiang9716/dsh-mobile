# Agent Note: the models settings page answers — llm directory, a real credential store, and the opener gate ride the coverage plane

Status: implemented
Related: D9, supersedes the `credentials/set stays unclaimed` stance of the api-full-coverage note (2026-09-24)

## Problem

On the user-facing serve seat the official UI's 设置 → 模型 page raised
`endpoint llm/listProviders is not implemented by the Phase-B carrier`: its
store load joins `llm/listProviders` × `llm/listConfigurableProviders` ×
`credentials/describe` (measured in the dsh-client-ui-settings-models bundle,
`load()`), and none of the llm rows were claimed — the coverage plane (D9,
api-full-coverage) had closed the workspace/goals/skills/commands surfaces
but never the llm namespace. The same page's configure/remove flow calls
`credentials/set`/`unset`, which the earlier note had pinned as deliberately
unclaimed ("the staged profile credential is not writable through the wire"),
and the api-coverage-probe's gapsPhase asserted that pin. Separately, the
Agent 预设 panel asks `settings/canOpenAgentPresetDirectory` before rendering
its desktop-opener affordance; unclaimed, the ASK itself toasted.

## Decision

All five rows join the COVERAGE plane (`fullCoverage: true` — the serve seat
opts in; every delivered manifest boots byte-identically), backed by a new
`upstream/web-write-llm.js`:

- `llm/listProviders` and `llm/listConfigurableProviders` forward to the
  mounted vendored LlmRuntime (`ctx.llm`) — the wire shapes are the service's
  own @Remote results, so the handlers do not reshape. On this host the
  directory answers the one registered route (`openai-compatible`) and an
  empty configurable directory; `llm/discoverModels` stays unclaimed because
  with an empty directory the page never reaches it (the honest residue).
- `credentials/set`/`unset`/`describe` become a REAL durable store: one JSON
  `{ref: value}` file at the app scope root (`credentials.json` — flat, so
  every host granting the v1.1.0 fs write primitives can hold it, including
  the mkdir-less CLI smoke backend), written through the gateway fs
  primitives; refs validate against the vendored
  dsh-credentials REF_PATTERN. `describe` answers state facts only
  (`configured`/`source`/`writable` — never values): a wire-configured ref
  reads from the store; the staged route's ref (derived exactly as the page
  derives it, `OPENAI_COMPATIBLE_API_KEY`) names the staged credential. The
  earlier not-writable stance is superseded, and the probe's gapsPhase now
  pins the opposite: set → describe → unset → describe must round-trip.
- `settings/canOpenAgentPresetDirectory` answers `false` — the honest
  platform fact — so the page hides the opener instead of toasting;
  `openAgentPresetDirectory`/`openSettingsDocument` stay unclaimed.

The residue (pinned unclaimed in the probe's gapsPhase, each named):
terminal/*, directoryPicker/pick, settings/replace|open*Document|
openAgentPresetDirectory, llm/discoverModels, subagents/*,
sessionFeedback/record, permissionPresets/catalog, fileUploads/upload,
officeToPdf/*, session/page|search|fork|attachment|cancel|updateQueue|
rename|selectModel|openWorkspacePath.

## Alternatives considered

- Claiming the llm rows unconditionally in WRITE_ENDPOINTS: rejected — the
  delivered composer-live-write manifests pin the historical claim row set;
  the coverage gate is exactly the mechanism the D9 note built for this.
- Backing credentials on the vendored dsh-credentials CredentialProvider
  service: it is an abstract seam whose storage providers live in the
  desktop composition; mounting it would mean porting a provider stack for
  one page. The direct store keeps the same ref grammar and the same
  never-serve-values rule at a fraction of the surface.
- Implementing `llm/discoverModels` as a real `GET {baseURL}/models`
  discovery: real, but unreachable while the configurable directory is
  empty (the page only offers discovery for declared providers) — deferred
  until a directory row exists to discover for.
