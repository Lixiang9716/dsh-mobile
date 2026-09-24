// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * upstream/boot.js — the MOBILE PROFILE BOOT (decision D9).
 *
 * Same entry shape as the desktop: apps/cli profile-boot resolves the profile,
 * stacks its patch layers (dsh.profile.bundles order → profile cordis.patch.yml
 * → overlays) over an EMPTY root, and drives the cordis Loader until the tree
 * settles. On mobile the platform differences live BELOW the upstream
 * contracts, never above them:
 *
 *   - The profile tree is the PINNED VENDOR CLOSURE (vendor/dsh@0.1.6-alpha.2
 *     + vendor/npm), mapped by the spike host loader; there is no disk Loader
 *     because the gateway fs scopes are not the module filesystem. The layer
 *     composition below mirrors the dsh-base cordis.patch.yml rows the mobile
 *     profile mounts (llm → session → agent → tools → system-prompt →
 *     session-projection → settings → agent-loop), in activation order.
 *   - $DSH_HOME / process.cwd() collapse into the host-granted PROFILE
 *     CONTAINER (caller-provided paths, pinned for the shims).
 *   - `llm` is the VENDORED dsh-llm LlmRuntime (adapter registry), with the
 *     gateway transport adapter (upstream/llm-transport.js) registered for
 *     the caller's provider route — the same service the desktop boots, over
 *     the mobile transport seam (gateway httpFetch).
 *
 * Exports bootUpstream(options) → { ctx, services, sessionId, agentId }.
 */
import './web-shims.js';
import process from 'node:process';
import { releaseKeeps } from 'logger.js';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SettingsMemory } from 'upstream/settings-memory.js';
import { LlmRuntime, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createGatewayLlmAdapter } from 'upstream/llm-transport.js';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
// The FIRST ported tool package (D9). It exports `{Config, apply, inject,
// name}` and no default, so the namespace object IS the cordis plugin (it
// carries the apply/inject/name/Config the kernel reads).
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo';
// The outboard WebAssembly tool (contract v1.2.0). It is a staged system
// plugin, not a vendored upstream package: the closure has no WebAssembly tool
// to port, and an in-house implementation package is where a host-specific
// capability belongs (D6) — `system-plugins/dsh-fs` beside it is the same
// shape. Mounted after `tools`, which its `inject` waits for.
import * as ShellWasm from 'system-plugins/dsh-shell-wasm/index.js';
// The in-process Linux userland tool (contract v1.3.0): the same shell seam as
// the WebAssembly executor beside it, backed by a real Alpine userland the host
// emulates inside its own process. A host that staged no guest root answers
// nothing here — the plugin declines to register a tool it cannot honour.
import * as ShellIsh from 'system-plugins/dsh-shell-ish/index.js';
// The FILE-TOOLS row (the dsh-desktop plugin surface): upstream's fs tool
// family over the vendored fs-local backend, working in ONE in-memory
// workspace world (upstream/shims/fs.js mountWorkspace). The npm bridge that
// registers bare `diff` (tool-fs' structuredPatch dependency) is a STATIC
// import so its body runs at graph load; the tool packages themselves resolve
// DYNAMICALLY inside mountSpine — quickjs links a static import graph before
// any module body runs, so a static tool-fs import would demand `diff` before
// the bridge exists (measured 2026-09-22).
import 'upstream/shims/npm-bridges.js';
import { mountWorkspace } from 'upstream/shims/fs.js';
// The Agent 预设 panel's data source (contract parity with the desktop shell):
// the REAL upstream services, verbatim — the cordis Loader service (which the
// presets service `inject`s) and the agent-presets roster over the four shipped
// presets (cordis / minimal / ptc / standard). The presets tree is seed data
// under the staged VFS root (the fs shims serve it; a driver delivers the bytes
// over the bus seam). The Loader ALSO serves the web-boot client composition's
// `entries()`/`internal` face — one loader service, no second claim (the
// conflict that kept this mount off is resolved in upstream/web-boot.js).
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { AgentPresets } from '@deepseek-ai/dsh-agent-presets';

/** cordis logger records ride the unified sink as diagnostics (module prefix
 * distinguishes them from scenario events; they carry no scenario tag, so the
 * E2E checker's one-to-one match ignores them).
 *
 * These records are stripped under the logger's release policy, through the
 * SAME releaseKeeps() the forwarding console uses: a release build keeps the
 * critical set (mapped type → warn/error) and drops the debug/info stream.
 * Exported so the release-logging evidence can drive this route (the sink
 * probe wires it to a real cordis Context) without booting the whole spine. */
export const wireLogger = (ctx) => {
  ctx.logger.exporter({
    levels: { default: 4 },
    export: ({ name, type, args }) => {
      const level = type === 'success' || type === 'info' ? 'info' : type;
      if (!releaseKeeps(level)) return;
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
        level,
        module: `cordis:${name ?? 'root'}`,
        message: args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
        }).join(' '),
        data: [],
      }));
    },
  });
};

/** Pin the profile container (the $DSH_HOME / cwd / tmpdir equivalents). */
const pinProfileContainer = (container) => {
  globalThis.__dshProfileCwd = container.cwd;
  globalThis.__dshProfileScopeRoot = container.scopeRoot;
  globalThis.__dshProfileTmpdir = container.tmpdir;
  globalThis.__dshProfileHome = container.home;
  globalThis.__dshProfilePlatform = container.platform ?? 'mobile';
  globalThis.__dshProfileLaunch = container.env ?? {};
  globalThis.__dshProfileArgv = container.argv ?? [];
  if (typeof globalThis.process === 'undefined') globalThis.process = process;
};

/** The staged VFS root of the vendored agent-presets package (the same path
 * space the fs shims' VFS serves and the drivers seed): the presets tree is
 * `<root>/presets/**` and the package-health resolution walks `<root>/
 * node_modules/<pkg>/package.json` from here. A `file:` URL — the shape the
 * presets service documents for `ctx.baseUrl` (a composition's package names
 * resolve against it). */
export const AGENT_PRESETS_VENDOR_ROOT = '/vendor/dsh/agent-presets@0.1.6-alpha.2';
export const AGENT_PRESETS_BASE_URL = `file://${AGENT_PRESETS_VENDOR_ROOT}/`;
/** The deployment default preset (the shipped roster: cordis/minimal/ptc/
 * standard; the package README's own deployment example pins `standard`). */
export const AGENT_PRESETS_DEFAULT = 'standard';

/** The dsh-base rows the mobile profile mounts, in base-patch order. */
const MOBILE_LAYERS = [
  ['session', '@deepseek-ai/dsh-session'],
  ['agent', '@deepseek-ai/dsh-agent'],
  ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
  ['tools', '@deepseek-ai/dsh-tools'],
  ['session-projection', '@deepseek-ai/dsh-session-projection'],
  ['settings', 'in-memory SettingsProvider (no settings-file on mobile)'],
  ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
];

/** The service keys the mobile profile must provide after the spine mounts. */
const MOUNTED_SERVICES = ['sessions', 'agents', 'systemPrompt', 'tools', 'sessionProjections', 'settings', 'agentLoop', 'llm'];

/** Fail loud naming any spine service that failed to mount (rule 5). */
const demandServices = async (ctx) => {
  const missing = MOUNTED_SERVICES.filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(`boot: services failed to mount: ${missing.join(', ')}`);
  }
};

/** The settings-plane services (the Agent 预设 data source) the boot demands
 * BESIDE the spine: demanded separately so the `upstream/services` record
 * keeps its published spine shape (the E2E manifests pin it). */
const PRESET_SERVICES = ['loader', 'agentPresets'];

/** Fail loud when the Agent 预设 mount chain did not land (rule 5). */
const demandPresetServices = (ctx) => {
  const missing = PRESET_SERVICES.filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(`boot: preset services failed to mount: ${missing.join(', ')}`);
  }
};

/** The REAL spine mounts, as plugin-inventory rows (the settings 插件 list's
 * global plane). Every row is answered from live context facts, never from
 * the declaration alone: a spine service is enabled when its service is
 * actually mounted on the context, and a tool plugin is enabled when its
 * tool is actually registered in the tool table (the ish tool declines to
 * register when the host stages no Linux guest root — that host sees the
 * row disabled, exactly what the tool layer does). `fiberPhase: 'active'`
 * names the mounted truth (demandServices proved the spine); a declined
 * plugin carries `null` — it has no fiber. */
export const spineInventory = (ctx) => {
  // The tool layer's GLOBAL visibility view — the same resolver the model-
  // facing catalog reads (scoped registrations shadow it; no scope exists at
  // the root). Reading `view().visible` is the registry's own answer to
  // "which tools does this runtime actually serve".
  const visibleTools = ctx.tools?.view?.(undefined)?.visible;
  const service = (entryId, moduleName, serviceName) => ({
    entryId,
    moduleName,
    enabled: ctx.get(serviceName) !== undefined,
    fiberPhase: ctx.get(serviceName) !== undefined ? 'active' : null,
  });
  const tool = (entryId, moduleName, toolName) => {
    const registered = visibleTools !== undefined && visibleTools.has(toolName);
    return { entryId, moduleName, enabled: registered, fiberPhase: registered ? 'active' : null };
  };
  return [
    service('session', '@deepseek-ai/dsh-session', 'sessions'),
    service('agent', '@deepseek-ai/dsh-agent', 'agents'),
    service('system-prompt', '@deepseek-ai/dsh-system-prompt', 'systemPrompt'),
    service('tools', '@deepseek-ai/dsh-tools', 'tools'),
    service('session-projection', '@deepseek-ai/dsh-session-projection', 'sessionProjections'),
    service('settings', 'upstream/settings-memory.js (in-memory SettingsProvider)', 'settings'),
    service('agent-loop', '@deepseek-ai/dsh-agent-loop', 'agentLoop'),
    service('llm', '@deepseek-ai/dsh-llm', 'llm'),
    tool('tool-todo', '@deepseek-ai/dsh-tool-todo', 'todo_write'),
    tool('shell-wasm', 'system-plugins/dsh-shell-wasm', 'shell'),
    tool('shell-ish', 'system-plugins/dsh-shell-ish', 'ish'),
    service('fs', '@deepseek-ai/dsh-fs-local', 'fs'),
    tool('tool-fs', '@deepseek-ai/dsh-tool-fs', 'read'),
    tool('tool-str-replace-editor', '@deepseek-ai/dsh-tool-str-replace-editor', 'str_replace_editor'),
    service('loader', '@deepseek-ai/cordis-plugin-loader', 'loader'),
    service('agent-presets', '@deepseek-ai/dsh-agent-presets', 'agentPresets'),
  ];
};

/** The FILE-TOOLS row's mounts (see the import note at the top of this
 * file): the workspace world, the vendored fs-local backend as the `fs`
 * service, and the file tools into the REAL ToolRuntime. */
const mountFileTools = async (ctx, cwd) => {
  mountWorkspace(cwd);
  const [{ LocalFileSystem }, ToolFs, StrReplaceEditor] = await Promise.all([
    import('@deepseek-ai/dsh-fs-local'),
    import('@deepseek-ai/dsh-tool-fs'),
    import('@deepseek-ai/dsh-tool-str-replace-editor'),
  ]);
  await ctx.plugin(LocalFileSystem, { cwd });
  await ctx.plugin(ToolFs, {});
  await ctx.plugin(StrReplaceEditor, {});
};

/** The SKILL row (2026-09-23, the agent-flow E2E): the upstream skill family
 * over the vendored packages — dsh-skill (the `ctx.skills` provider registry),
 * dsh-skill-filesystem (project/custom/user discovery; on mobile mounted with
 * `watch:false` — the runtime has no fs-event/timer seam for chokidar, which
 * the npm-bridges seam answers with a loud linkage shim), and dsh-tool-skill
 * (the model-facing `skill` tool + the durable session catalog). Mounted only
 * when the caller configures `options.skills` (customSkillDirs), so the
 * existing spine legs boot byte-identically. Dynamic imports here — same
 * reason as the file-tools row: the bridges must register `yaml`/`chokidar`
 * before these specifiers resolve (ESM links static graphs before any module
 * body runs). `dshHome`/`agentsHome` are pinned to the profile container so
 * discovery is deterministic; `includeDefaultRoots` stays on and simply finds
 * nothing (the container has no project `.dsh/skills`/`.agents/skills` and
 * no `$DSH_HOME/skills` unless staged). */
const mountSkillPlane = async (ctx, skills) => {
  const [Skills, SkillFs, ToolSkill] = await Promise.all([
    import('@deepseek-ai/dsh-skill'),
    import('@deepseek-ai/dsh-skill-filesystem'),
    import('@deepseek-ai/dsh-tool-skill'),
  ]);
  await ctx.plugin(Skills.SkillRegistry, {});
  await ctx.plugin(SkillFs, {
    dshHome: skills.dshHome,
    agentsHome: skills.agentsHome,
    customSkillDirs: skills.customSkillDirs ?? [],
    watch: false,
  });
  await ctx.plugin(ToolSkill, {});
};

/** The COMMAND row (2026-09-24, the owner's "/" report): the upstream
 * interactive-command registry (dsh-commands) plus the command-defining
 * plugins the desktop composition mounts (command-feedback first — its deps
 * are already vendored). Commands are plugin-owned: the registry carries no
 * built-ins, so the surface is only as rich as the plugins mounted after it.
 * Mounted only when the caller configures `options.commands` (the user-facing
 * seat), so every existing spine leg boots byte-identically. The registry
 * must precede the command-defining plugins (they register into it). */
const mountCommandPlane = async (ctx) => {
  const [Commands, CommandFeedback] = await Promise.all([
    import('@deepseek-ai/dsh-commands'),
    import('@deepseek-ai/dsh-command-feedback'),
  ]);
  await ctx.plugin(Commands.default ?? Commands, {});
  await ctx.plugin(CommandFeedback.default ?? CommandFeedback, {});
};

/** Mount the dsh-base bundle's spine rows over the vendored packages, in
 * base-patch order (activation is service-availability driven upstream; here
 * the mount order mirrors the patch rows). */

/** The Agent 预设 data-source mounts — split from mountSpine at the
 * file-size gate; the block's comment carries the WHY of each choice
 * (one Loader, includeUserRoot: false, mounted after agent-loop). */
const mountPresetPlane = async (ctx) => {
  // Agent 预设 data source, contract parity with the desktop shell: the REAL
  // cordis Loader service and the REAL vendored AgentPresets over the staged
  // presets VFS. Composition order is upstream's own demand: the presets
  // service `inject`s `loader` + `sessionProjections` (both mounted above) and
  // reads `ctx.baseUrl` — set below BEFORE either mount. One Loader serves
  // both the presets inject and the web-boot client composition's resolution
  // face (upstream/web-boot.js decorates `entries()`/`internal` on THIS
  // service; it never claims the property a second time). Mounted LAST: this
  // host never joins presets at agent-creation (the staged gap upstream's
  // `agent/created` warning exists for), and mounting after agent-loop keeps
  // the boot agent outside that listener. `includeUserRoot: false` is the
  // honest mobile root set: authoring writes refuse at the fs shim (the
  // staged view is read-only), so there is no user preset root to scan.
  ctx.baseUrl = AGENT_PRESETS_BASE_URL;
  await ctx.plugin(Loader, { baseUrl: AGENT_PRESETS_BASE_URL });
  if (ctx.get('loader') === undefined) {
    throw new Error('boot: the cordis Loader failed to mount under "loader"');
  }
  await ctx.plugin(AgentPresets, {
    default: AGENT_PRESETS_DEFAULT,
    includeUserRoot: false,
  });
};

const mountSpine = async (ctx, identity) => {
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SystemPrompt, { personaPrefix: identity.personaPrefix ?? '' });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SettingsMemory);
  // The ported tool packages (D9): mounted AFTER `tools`, because a tool
  // registers into that service at apply time. `allowParallelInProgress:
  // false` is the mobile profile's shape — one agent, sequential work.
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false });
  await ctx.plugin(ShellWasm);
  await ctx.plugin(ShellIsh);
  // The FILE-TOOLS row (dsh-desktop plugin surface): the vendored fs-local
  // backend service (`fs`) plus upstream's file tools, over one in-memory
  // workspace world pinned to the container cwd. Dynamic imports here — the
  // npm bridge must register `diff` before these specifiers resolve (see the
  // import note at the top of this file), and fs-local's Config static reads
  // the pinned profile container. The world is in-memory by design for this
  // host: no durability, no symlinks, no permissions — the staged gap.
  await mountFileTools(ctx, identity.cwd);
  // The SKILL row (the agent-flow E2E): mounted after the file tools (its
  // discovery prefers the `fs` service) and before the agent loop (the
  // tool-skill catalog registers its `agent/pre-step` listeners on the
  // context, so every later step sees them). Only when configured.
  if (identity.skills) await mountSkillPlane(ctx, identity.skills);
  if (identity.commands) await mountCommandPlane(ctx);
  // dsh-base row `agent-loop` with ONE configured agent (config.agents create
  // path — no persistence backend is mounted, matching the base default).
  await ctx.plugin(AgentLoop, {
    maxParallelToolCalls: 10,
    agents: [{
      id: identity.agentId,
      sessionId: identity.sessionId,
      provider: identity.provider,
      model: identity.model,
      reasoningEffort: 'off',
      cwd: identity.cwd,
    }],
  });
  await mountPresetPlane(ctx);
};

/**
 * @param options.scenario - E2E scenario id the caller logs under (used for
 *   the boot evidence events the caller emits).
 * @param options.container - profile container {cwd, tmpdir, home, env?, argv?}.
 * @param options.agentId - configured agent id (created by AgentLoop at mount).
 * @param options.sessionId - exact session identity for the configured agent.
 * @param options.cwd - session cwd (mobile-honest: a gateway fs scope label).
 * @param options.llm - the llm route: {baseURL, apiKey, provider, model,
 *   onWire?, onSse?} — required; the profile has no transport-free fallback.
 * @param options.systemPrompt - optional override seam: {personaPrefix} —
 *   the vendored SystemPrompt's own config (the prompt's persona section),
 *   mounted verbatim; default '' (the historical boot shape).
 * @param options.commands - optional COMMAND-row flag (true mounts the
 * upstream commands registry + the command-defining plugins vendored so far).
 * @param options.skills - optional SKILL-row configuration: {dshHome,
 *   agentsHome, customSkillDirs?} — mounting the vendored skill family
 *   (registry + filesystem provider + the `skill` tool). Absent = the
 *   historical spine (the parity/session manifests pin that shape).
 * @param options.onEvent - observability hook: (event, fields) => void; boot
 *   emits `upstream.profile`, `llm/runtime`, `upstream.services`.
 */
/** Mount the dsh-base row `llm`: the VENDORED LlmRuntime with the gateway
 * transport adapter registered for the caller's provider route. */
const mountLlm = async (ctx, llm, onEvent) => {
  await ctx.plugin(LlmRuntime);
  const runtime = ctx.get('llm');
  if (runtime === undefined) throw new Error('boot: the LlmRuntime failed to mount under "llm"');
  runtime.registerAdapter([llm.provider], createGatewayLlmAdapter({
    baseURL: llm.baseURL,
    apiKey: llm.apiKey,
    provider: llm.provider,
    name: llm.adapterName ?? 'mock loopback chat-completions (dsh-llm-mock-server)',
    userEndpoint: llm.userEndpoint === true,
    onWire: llm.onWire,
    onSse: llm.onSse,
    onRequestBody: llm.onRequestBody,
  }));
  onEvent('llm/runtime', {
    provider: llm.provider,
    model: llm.model,
    service: 'vendored @deepseek-ai/dsh-llm LlmRuntime (adapter registry)',
    transport: llm.transportLabel
      ?? 'gateway httpFetch → loopback chat-completions mock server',
    userAgent: attributionHeaders()['user-agent'],
  });
};

/**
 * Boot the mobile profile: empty root, the dsh-base-equivalent spine mounted
 * over the pinned vendored packages, the vendored LlmRuntime under `llm`.
 */
export async function bootUpstream(options) {
  const { scenario, container, agentId, sessionId, cwd, onEvent } = options;
  const llm = options.llm ?? {};
  if (!llm.baseURL || !llm.apiKey || !llm.provider || !llm.model) {
    throw new Error('boot: options.llm {baseURL, apiKey, provider, model} is required — the profile boots the vendored LlmRuntime over the gateway transport');
  }
  pinProfileContainer(container);

  const ctx = new Context();
  wireLogger(ctx);
  // Lifecycle listeners registered BEFORE the spine mounts, so boot-time
  // creation events (session/created, agent/created) are observable.
  for (const [type, fn] of Object.entries(options.listeners ?? {})) {
    ctx.on(type, fn);
  }

  await mountLlm(ctx, llm, onEvent);

  onEvent('upstream/profile', {
    profile: 'mobile',
    root: 'empty (patch layers compose over it)',
    upstream: '0.1.6-alpha.2 (vendored verbatim, sha256-pinned)',
    layers: MOBILE_LAYERS.map(([id]) => id),
  });

  await mountSpine(ctx, {
    agentId, sessionId, cwd,
    provider: llm.provider, model: llm.model,
    personaPrefix: options.systemPrompt?.personaPrefix,
    skills: options.skills,
    commands: options.commands,
  });
  await demandServices(ctx);
  demandPresetServices(ctx);

  onEvent('upstream/services', {
    kernel: '@deepseek-ai/cordis@4.0.2',
    services: MOUNTED_SERVICES,
    llm: `vendored LlmRuntime + gateway adapter (provider "${llm.provider}")`,
  });

  return { ctx, sessionId, agentId };
}
