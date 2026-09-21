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

/** Mount the dsh-base bundle's spine rows over the vendored packages, in
 * base-patch order (activation is service-availability driven upstream; here
 * the mount order mirrors the patch rows). */
const mountSpine = async (ctx, identity) => {
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SystemPrompt, { personaPrefix: '' });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SettingsMemory);
  // The ported tool packages (D9): mounted AFTER `tools`, because a tool
  // registers into that service at apply time. `allowParallelInProgress:
  // false` is the mobile profile's shape — one agent, sequential work.
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false });
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

  await mountSpine(ctx, { agentId, sessionId, cwd, provider: llm.provider, model: llm.model });
  await demandServices(ctx);

  onEvent('upstream/services', {
    kernel: '@deepseek-ai/cordis@4.0.2',
    services: MOUNTED_SERVICES,
    llm: `vendored LlmRuntime + gateway adapter (provider "${llm.provider}")`,
  });

  return { ctx, sessionId, agentId };
}
