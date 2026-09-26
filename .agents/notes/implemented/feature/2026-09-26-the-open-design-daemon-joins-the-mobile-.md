# Agent Note: the open design daemon joins the mobile runtime as the dsh-open-design plugin

Status: implemented
Related: D6, D9

## Problem

The owner asked to integrate Open Design (the nexu-io design daemon — a
design-generation service a coding agent drives over HTTP: projects, a BYOK
streaming generate proxy, artifact persistence and linting) into dsh-mobile.
The ecosystem's official bridge is an MCP **stdio** server
(`nano-step/open-design-mcp`): a child process running a node program. This
runtime has no OS child processes (single serial QuickJS thread, the
subprocess capability is a coroutine executor, not a process spawner), so the
official bridge cannot run here — and vendoring a modified copy of it would
violate the upstream discipline anyway (D6). Without an integration, a
dsh-mobile session cannot use Open Design at all: no project surface, no
generate leg, no artifact persistence or linting.

## Decision

`system-plugins/dsh-open-design` — an outboard implementation package (D6)
that speaks the daemon's REST contract directly over the contract's
`httpFetch` primitive. It ports the API surface the MCP bridge exposes (the
ten endpoints its vendored od-contracts freeze: projects CRUD, project files,
`POST /api/proxy/<provider>/stream`, artifact save/lint) into three model-
facing tools: `open_design_projects`, `open_design_generate`,
`open_design_artifact`. The generate leg consumes the daemon's SSE stream
(start/delta/end/error) through the same gateway byte-stream face the LLM
transport uses.

Configuration is two-tier (the ish executor's shape): a host declaration
global `__dshOpenDesign` first, the launch environment
(`DSH_OPEN_DESIGN_URL`, `_TOKEN`, `_BYOK_BASE_URL/_API_KEY/_MODEL/_PROVIDER`)
second. A host with no daemon configured mounts nothing — the plugin declines
to register tools, exactly as `dsh-shell-ish` declines without a guest root,
so the boot's static import graph stays unconditional and the settings
inventory reports the row honestly. BYOK is deliberately separate from the
session's own LLM route: the session's credentials are never shared with the
daemon implicitly.

Wiring rides the existing seams: `upstream/boot.js` imports and mounts the
plugin beside the shell plugins (D9 profile shape); the embed lists gain two
rows per host (android staging list, harmony BUNDLE_FILES, the iOS bundle
generator + stager). The E2E is logs-first: `open.design` drives the three
tools through the REAL ToolRuntime dispatch against a loopback mock daemon
(`ci/mock-open-design-server.mjs`), verified one-to-one by
`test/e2e/scenarios/open-design.json`, wired into `build.sh test core`.

## Alternatives considered

- **Run the official MCP bridge** — rejected physically: it is a stdio node
  child process; this runtime spawns none, and building a process model to
  host one server would be a platform change, not an integration.
- **Vendor the MCP package and adapt it in place** — rejected on D6: the
  bridge's stdio transport and MCP SDK dependency would sit unused in the
  closure while the actual usable surface (its od-client HTTP calls) is the
  part we re-implement anyway. The port instead cites the bridge as the
  upstream provenance of the endpoint table.
- **Give generate the session's own LLM route** — rejected on trust
  boundaries: the daemon's BYOK proxy is the daemon's credential path; passing
  the session's API key to a third-party service implicitly would make a
  network call leak credentials by design. The plugin demands an explicitly
  configured BYOK route instead.
- **Vendored Open Design's full prompt stack** (the ~700-line designer
  charter the MCP bridge composes) for the generate leg — deferred, not
  silently dropped: v0.1.0 carries a compact artifact contract and the header
  says so; closing the gap means vendoring `od-contracts` prompts verbatim,
  not inventing a second composition.
