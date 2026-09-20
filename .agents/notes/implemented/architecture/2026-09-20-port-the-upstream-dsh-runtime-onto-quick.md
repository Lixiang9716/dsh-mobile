# Agent Note: Port the upstream DSH runtime onto quickjs: vendor closure, shim system layer, mobile profile boot (PR-A)

Status: implemented
Related: D6, D9

## Problem

The mobile host needs the REAL DSH harness (agent spine, session event log,
system prompt, tools), not an in-house reimplementation: at 0.1.x upstream
velocity any ported-by-hand flow forks product behavior and guarantees
divergence (the exact failure D9 records). The blocked state before this
change: `runtime/spike/vendor/ensure-dsh.sh` and 19 vendored
`@deepseek-ai/dsh-*` packages existed untracked and unverified from a
stopped worker session — no audit trail that they matched their sha256
pins, no shim layer, no boot, and no E2E proving a single upstream turn
runs inside quickjs-ng. The runtime could not load a bare npm specifier at
all (`node:path`, `@deepseek-ai/cordis` all failed in the module loader).

## Decision

PR-A lands the D9 port for the agent-spine closure, all in-house code as
system support (glue), upstream packages verbatim:

- **Vendor closure, audited**: every vendored package re-fetched and
  verified against its pinned tgz sha256 AND byte-diffed against the
  tarball (only addition: a PROVENANCE.md note). Stale
  `util-crypto@0.1.6-alpha.1` removed; the loader now pins alpha.2. The
  `llm*` packages were REMOVED from this closure — W-LLM owns the dsh-llm
  vendor + transport seam. The vendored dsh/npm trees stay UNTRACKED
  (gitignored), exactly like `vendor/quickjs-ng/`: the ensure script's pin
  table is the tracked provenance record, CI materializes on demand, and
  the syntax-class checker never judges upstream code (zod v3's bundled
  file does not parse under the editor-level checker; upstream JS cannot
  be refactored to satisfy it).
- **Host loader seams** (`dsh_spike_host.c`): bare npm specifiers
  (`@deepseek-ai/dsh-*`, `@deepseek-ai/{cordis,cosmokit,schemastery}`,
  `zod` + zod-internal relative subpaths) map into the vendor tree;
  `node:` builtins map to the shim layer; relative imports resolve in
  SPECIFIER space so mapped packages re-enter the bare map; unmapped bare
  specifiers fail loud naming the specifier (rule 5). Plus a native `atob`.
- **Shim system layer** (`upstream/web-shims.js`, `upstream/shims/`):
  structuredClone (JSON-safe superset), AbortController/AbortSignal,
  console→log-sink backstop, ALS over promise-continuation context capture,
  POSIX path, randomUUID, loud stubs for `node:fs`, profile-container-pinned
  `node:os`/`node:process`, and a native `Function.prototype.toString`
  normalization (quickjs-ng renders native functions multi-line; upstream's
  intrinsic-constructor check compares Node's single-line format, and every
  upstream plain-object JSON walk rejected itself without this).
- **Mobile profile boot** (`upstream/boot.js`): the same entry shape as
  desktop's `apps/cli` profile boot (empty root, layer composition, cordis
  host, settle), mounting the dsh-base bundle's spine rows (sessions,
  agents, system-prompt, tools, session-projection, settings, agent-loop)
  over the vendored packages, with `llm` mounted SCRIPTED
  (`upstream/model-scripted.js`, logged `model.scripted`): the agent spine
  stays upstream, the driver stays swappable. Two staged upstream-SHAPE
  shims cover module-load linkage only: `shims/dsh-llm.js(+stream)` (the 14
  pure value helpers the spine imports — message factories, error classes,
  BlockAssembler, AssistantStreamAccumulator — ported from upstream MIT
  source, NO transport/service) and `shims/dsh-session-persistence.js`
  (error classes only). Both retire by deleting one loader-map row when the
  real vendors land.
- **E2E** (`scenario/m2-upstream-session.js` +
  `tools/e2e/scenarios/m2-upstream-session.json`, runner
  `ci/run-upstream-e2e.sh`, evidence
  `artifacts/macos-cli-upstream-session/`): one REAL upstream agent-loop
  turn — configured-agent create, prompt assembly, scripted stream, durable
  assistant/message through the upstream BlockAssembler path — asserted
  one-to-one over the session log in the upstream event vocabulary
  (23/23, 3x byte-identical) plus the turn-boundary projection. All five
  existing scenarios re-verified green after the loader change.
- `tools/check-size.py` gains the same `/vendor/` exemption the logging
  gate already had (vendored bundles cannot be refactored to our limits).

## Alternatives considered

- Vendor dsh-llm too (one more pin row): rejected — ownership is explicit
  (W-LLM lands the llm vendor + transport); vendoring it here would fork
  the seam and duplicate W-LLM's work. The value-helper shim is the
  minimum that lets upstream agent-loop LINK; it carries no product
  behavior beyond data construction, and is first in line for deletion.
- Patch the vendored `hasIntrinsicConstructor` (toString format) instead
  of shimming `Function.prototype.toString`: rejected — D6 forbids editing
  vendored copies; the platform difference (native-code rendering) belongs
  in the shim, and the shim fixes every upstream consumer of that pattern
  at once.
- Reuse dsh-desktop's cordis-host-runner + disk Loader: rejected for PR-A —
  it needs `node:vm`, timers, Buffer/fetch and a filesystem-backed module
  Loader; the gateway fs scopes are not the module filesystem. boot.js
  composes the identical layer order in memory; the disk Loader path stays
  a declared staged gap.
- wall-clock timers shim (setTimeout = immediate): rejected — a silent
  semantic lie; upstream timeout rows stay unmounted until the host gains
  a real timer primitive (contract proposal first).
