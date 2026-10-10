# Plugin development on dsh-mobile — the tutorial, one-to-one

This is the mobile counterpart of the upstream "first plugin" tutorial
(deepseek-harness docs → develop → basic): every capability that tutorial
teaches exists on the mobile host, through the same cordis shapes, proven by
the `plugin.forms` E2E leg (`runtime/dsh/ci/run-plugin-forms-e2e.sh`, receipts
under `runtime/dsh/artifacts/macos-cli-plugin-forms/`).

## What a plugin is

Identical to upstream: a module exporting an `apply` function that receives a
cordis `ctx`. Three forms are first-class (the mount chain normalizes all of
them, `runtime/dsh/plugin-mount.js`):

| Form | Entry shape | Use |
| --- | --- | --- |
| object | `export const name/inject/apply` (or the same under `default`) | the default choice |
| function | `export default (ctx) => {}` | minimal plugins |
| class | `export class X extends Service` (a single class/function export is picked) | plugins that provide a service |

```js
import { Service } from '@deepseek-ai/cordis';   // resolves on-device (pinned vendored copy)
export class MyService extends Service {
  static inject = ['tools'];                     // dependencies load first
  constructor(ctx) { super(ctx, 'myService'); }
}
```

`inject` is honored exactly as upstream: the framework loads the plugin only
after the named services are up.

## Declaring effects (and the one semantic to know)

Everything registered through `ctx` (listeners, tools, timers) is cleaned up
automatically on unload. For manual resources use `ctx.effect` — in the
vendored `cordis@4.0.2` the callback runs **immediately as setup and its
return value is the disposer**:

```js
export const apply = (ctx) => {
  const heartbeat = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(heartbeat));   // setup returns the cleanup
};
```

## How plugins mount (the mobile differences)

There is no `pnpm dsh web` on a phone; the three registration paths map onto
the tutorial's `cordis.yml` insert:

1. **Chat-created** (the product path): ask the agent to make a plugin — the
   model authors the tree, a native approval gate asks you, and the plugin
   mounts live (`plugin-mount.js`: read → validated → approved → adopted →
   linked → mounted).
2. **Marketplace**: signed packages install through the marketplace plane —
   same registry, same boot behavior.
3. **Developer push** (the tutorial's loop): `tools/plugin/dev.sh` compiles
   your TypeScript on the dev machine (the device never compiles — it only
   interprets prebuilt bytes), stages the tree into the simulator's app
   container, and enables the registry row. Relaunching the app mounts every
   ENABLED registry row at spine boot — the one-to-one equivalent of the
   tutorial's `--patch` layer, which is also per-launch:

   ```sh
   tools/plugin/dev.sh my-plugin/            # compile → stage → enable → relaunch
   ```

   `my-plugin/` is the tutorial's scratch-plugin in mobile spelling:
   `plugin.json` (`{id, name?, version?, entry?, capabilities?}`) plus
   `src/index.ts` (or `.js`, passed through verbatim).

## Unload and reload

Unload is a first-class operation: `unmountWorkspacePlugin(spec)` awaits the
cordis fiber's `dispose()` (every effect the plugin registered unwinds) and
disables the registry row. Mounting again re-links the **current** source
under an epoch query (`?e=1` — the loader's node-style cache-buster), so
edit → relaunch is a true reload, not a stale module. Removing through the
plugin manager (`marketplace/remove`) disposes a live mount first — a tree
never disappears under a running fiber.

## Writing a tool (develop/basic/tool)

The tutorial's `greet` tool runs verbatim — `defineTool` resolves through the
loader's bare map, the registration is an effect, and execution goes through
the REAL ToolRuntime:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'greet-tool';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    async execute(args) { return `Hello, ${args.name}!`; },
  }));
}
```

Other plugins observe every call independently through `ctx.on('tools/result',
(exec, result) => …)` — loose coupling, no imports between the two.

## Plugin config (develop/basic/config)

Export a `Config` schema (Schemastery — any Standard Schema validator works)
and `apply(ctx, config)` receives the validated config with defaults filled:

```js
import Schema from '@deepseek-ai/schemastery';

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
});
export const apply = (ctx, config) => { /* config.greeting is always set */ };
```

The config travels in the mount options (`pluginOpts`). Validation runs
inside `ctx.plugin` itself: an invalid config fails the mount **loud** with
the ValidationError, and the adoption (the enabled registry row) is rolled
back — a broken plugin never stays enabled to retry at every boot.

Config can also be HOT-UPDATED on a live mount — the kernel's config-HMR
face, exposed as `updateWorkspacePluginConfig(spec, config)`: the update is
validated, the fiber restarts IN PLACE (unload effects run, apply re-runs),
and an invalid update refuses while the old config keeps running. The
tutorial's `.volatile()` fields and `!!js` YAML tags remain
desktop-composition features.

## Events (develop/framework/events)

The four dispatch modes are the cordis kernel's, verbatim: `ctx.emit`
(broadcast), `ctx.bail` (first non-null answer short-circuits),
`ctx.serial`, `ctx.waterfall` (each listener wraps `next()`). Every
`ctx.on` is an effect — unmount detaches the listeners. `tools/result` and
the other `namespace/action` harness events observe exactly as the tutorial
shows.

## Services and the dependency cascade (develop/framework/service)

Providing is the class form (`super(ctx, 'myService')`); consuming is
`inject: ['myService']` (required) or `ctx.get('myService')` (optional). The
cascade contract holds on this host and is proven: **disposing the provider
disposes the dependent; restoring the service reloads it.**

## When a mount refuses: the PENDING diagnosis (cordis-tutorial 06)

A plugin whose `inject` names a service nobody provides would silently wait
forever upstream. On this host the mount **refuses** with
`plugin is PENDING — an injected service is missing`, unwinds the fiber, and
rolls back the adoption. A mount must run now or not at all.

## LLM adapters (develop/practice/llm-adapter)

A workspace plugin can serve its own provider — subclass `LlmAdapter` from
`@deepseek-ai/dsh-llm` and override `stream()` (the base class owns
`providerInfo`/`providerRetryPolicy`/`resolveModel`/`prepareCall`):

```js
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

class MyAdapter extends LlmAdapter {
  async *stream(options) { /* yield the StreamChunk protocol */ }
}

export const inject = ['llm'];
export const apply = (ctx) => { ctx.llm.registerAdapter(['my-provider'], new MyAdapter()); };
```

The registration is an effect (unmount retires the provider) and the stream
flows through the real `LlmRuntime` waterfall.

## The three-layer seam (develop/practice/) and publishing (develop/basic/publish)

Definition / Provider / Consumer map onto three workspace trees (or three
marketplace packages) speaking the same Service name — the mechanics are the
Service form + `inject` proven above; the repo's own capability planes
(shell → bash-local → tool-bash) are the reference. Publishing maps onto the
marketplace plane: `dsh plugin add` ≈ `plugin_manager install_bundle`
(signed uSTAR tarballs from a marketplace index), `remove` ≈
`marketplace/remove` (which disposes a live mount first), and the profile
bundle list ≈ the `dsh.plugins/1` registry the boot-list mounts from. The
npm/pnpm packaging chapter is desktop-only by design — the device never
builds; authors compile on their machines (`dev.sh`) or ship prebuilt
tarballs.

## Where the E2E proof lives

`scenario/plugin-forms.js` (deterministic, no model): all three forms mount,
`inject` orders the load, the service answers through the resolver, effect
cleanups run on unload, edited source reloads, config validates (explicit →
default → invalid-loud), the four event modes dispatch, the greet tool runs
through the real ToolRuntime under an independent observer, the dependency
cascade disposes and reloads, a PENDING mount refuses with its diagnosis, a
workspace LLM adapter serves a real stream, and the boot list mounts exactly
the enabled rows — 23 events, one-to-one. Run it with
`runtime/dsh/ci/run-plugin-forms-e2e.sh` (wired into
`build/build.sh test core`); the manifest is
`test/e2e/scenarios/plugin-forms.json`.

## Policy hooks, background jobs, and the rest of the tool cookbook (reference/cookbook)

The deep tool-authoring surfaces are the same vendored `dsh-tools`, proven in
the leg:

- **Policy**: the `tools/pre-execute` waterfall may deny a call
  (`{kind: 'deny', reason}`) and `ctx.tools.guard` refuses monotonically —
  no later face can force-allow. Both are effects: unmount lifts the policy.
- **Background work**: the composition plane mounts the real
  `LocalJobRegistry` — `ctx.jobs.start({kind, label, run})`, `wait`, `read`,
  `kill`. The one contract to honor: a compliant producer's `cancel()`
  **must eventually settle `done`** (the runtime waits for resource release,
  not the kill request). `dsh-tool-jobs` renders job state to the model.
- **UI cards** (`presentCall`/`presentResult`/`presentationMeta`): faces of
  the same `defineTool`; on this host the model-facing `output.render` is
  what surfaces serve, and the product's own native card face (`card.*`
  events) is the UI plane. The web `tool.call.toolview` client-slot chapter
  is desktop-web-plane.
- **PTC mode**: programmatic tool access is proven through
  `ctx.tools.execute`; the full `run_code` PTC plane rides the PTC host
  runner, which the mobile wall (`preset-mobile-rows.js`) disables by design.
- `ctx.serial` completes the four dispatch modes; nested `ctx.plugin(child)`
  disposes recursively with its parent; `ctx.provide` is the plain-value
  providing face.

The quickstart's Web-UI flow (model settings → workspace picking → a real
turn with approvals) is this app's product surface — no plugin-dev mapping
needed.

## The seam inventory (reference/capability-seams, runtime-audited)

`scenario/seam-inventory.js` boots the production-equivalent spine (every
product flag + the composition plane) and probes every upstream-catalog
service name through the same resolver `inject` uses. Frozen by
`test/e2e/scenarios/seam-inventory.json`; run
`runtime/dsh/ci/run-seam-inventory-e2e.sh`. The runtime's answer:

**Mounted (22)**: sessions, agents, systemPrompt, tools, sessionProjections,
settings, agentLoop, llm, tokenMeter, jobs, userQuestions,
subagentModelSelection, shell (wasm executor), shellEnv, goals, commands,
agentPresets, skills, fileReferences, web (keyless plane), sessionQuery,
sessionFeedback.

**Absent, by design** — each maps to a mobile equivalent or a recorded wall:

| Absent | Mobile disposition |
| --- | --- |
| credentials | host-side store: the gateway keychain + the profile credential file (`loadCredential`) |
| approval | the gateway `presentApproval` primitive (contract-first; the native dialog) |
| fs (gateway, not a seam) | the host gateway's fs primitives are THE fs |
| subprocess, sandbox, terminals | the mobile wall: no processes — the wasm shell (+ optional iSH) story |
| compaction | the only closure consumer is `/compact` (command-compact), a desktop row the upstream README records as not carried; long-session auto-compaction is a flagged product follow-up |
| sessionPersistence | the abstract seam is vendored but the jsonl backend is not pinned; resume fails loud ("cannot resume: session persistence is not configured") — sessions are per-launch; durability is a flagged product follow-up |
| sessionTitle, attachments, schedule, planMode, messageFeedback, mcpResources, spillStore, workflowEngine, lsp | desktop product features not yet carried (each a candidate follow-up, none silently broken) |
| invariant, configEditor, setting, workspaceRegistry | desktop diagnostics/composition faces; mobile's equivalents are the settings service, the gateway workspace picker, and the host workspace model |
| api-gateway (typert/Remote) | the carrier API bridge: `/api/<endpoint>` + the bus-claimed endpoint table (session/*, goals/*, commands/*, marketplace/*, …) — the same namespace surface over the carrier contract, no typert wire |

## Documentation audit coverage (page-by-page, 2026-10-10)

Every docs-site page was read and compared against the host. Dispositions:

| Page | Disposition |
| --- | --- |
| develop/basic (first plugin, tool, config, publish) | proven — three forms, defineTool greet, Schemastery config, marketplace mapping (`plugin.forms`) |
| develop/framework (lifecycle, service, events) | proven — unload/dispose, dependency cascade incl. reload, all five dispatch modes (`plugin.forms`) |
| develop/practice (three-layer seam, LLM adapter, dynamic-cordis) | proven (Service+inject+adapter legs); dynamic-cordis = the chat-created plugin product flow itself |
| develop/cordis-tutorial (7 chapters) | proven — the chapters are the framework pages' hands-on forms; ch.6's PENDING trap is where the mount's refusal diagnosis comes from |
| reference/cordis-api (context, registry, fiber, events, service) | face-audited — 18 methods + 5 instance members + 7 Service kernel symbols asserted present (`seam.inventory/cordis.face`); fiber.update exposed as `updateWorkspacePluginConfig` |
| reference/capability-seams | runtime-audited — the seam inventory (22 mounted / 20 recorded dispositions, table above) |
| reference/tool-execution-pipeline | proven — all three waterfalls + monotonic guard + result observation (`plugin.forms` policy phase) |
| reference/agent-lifecycle | concept page (turn/step; `session/event` vs `agent/*`) — carried by the vendored agent-loop verbatim |
| reference/api-gateway | classified — desktop typert/Remote wire; mobile serves the same `/api` namespace surface over the carrier bridge + bus-claimed endpoints |
| reference/cookbook: adding-a-tool, adding-an-llm-adapter, extension-cookbook | proven/classified — every extension pattern (pre-execute, guard, post-execute, result, jobs, adapter registration) is in a leg |
| reference/cookbook: adding-a-package | desktop monorepo packaging (pnpm/tsdown/constraints) — N/A on mobile; the portable bits are the locale (`meta.title`/`description`) and icon metadata conventions, NOT carried (the marketplace catalog's `summaries.json` covers en/zh at catalog level) — flagged follow-up |
| guide/quickstart | the Web-UI flow IS this app's product surface |
| guide/providers | the model-configuration product page; mobile's equivalent is the BYOK/models settings surface (OpenAI-compatible endpoints); the desktop multi-protocol breadth (anthropic-messages / openai-responses via llm-pi-ai) is not vendored on mobile — flagged follow-up |
| guide/network-proxy, python-sdk | launch-env proxy vars / desktop SDK profile — no plugin-author face; N/A |
| guide/github-review, guide/schedule, guide/mcp-memory | desktop product features over seams not carried (webhookRuntime; schedule; mcp-client over stdio subprocess = the no-process wall) — flagged follow-ups |
| generated catalogs (config/tool/persistence) + subsystems (~45 pages) | generated FROM the same vendored packages — by-construction coverage; spot-checked tools + jobs: the documented faces match the vendored lib (the docs site tracks master, so a few type names drift from our 0.1.6-alpha.2 pin — the pin is authoritative) |

---

[中文版](plugin-dev.zh.md)
