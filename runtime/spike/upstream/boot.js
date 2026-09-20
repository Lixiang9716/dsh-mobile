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
 *   - `llm` is mounted late and scripted (model.scripted): the agent spine
 *     stays upstream, the driver stays swappable; the real dsh-llm transport
 *     lands with W-LLM's vendor and replaces it at the same key.
 *
 * Exports bootUpstream(options) → { ctx, services, sessionId, agentId }.
 */
import './web-shims.js';
import process from 'node:process';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SettingsMemory } from 'upstream/settings-memory.js';
import { createScriptedModelService } from 'upstream/model-scripted.js';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';

/** cordis logger records ride the unified sink as diagnostics (module prefix
 * distinguishes them from scenario events; they carry no scenario tag, so the
 * E2E checker's one-to-one match ignores them). */
const wireLogger = (ctx) => {
  ctx.logger.exporter({
    levels: { default: 4 },
    export: ({ name, type, args }) => {
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
        level: type === 'success' || type === 'info' ? 'info' : type,
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
  // dsh-base row `agent-loop` with ONE configured agent (config.agents create
  // path — no persistence backend is mounted, matching the base default).
  await ctx.plugin(AgentLoop, {
    maxParallelToolCalls: 10,
    agents: [{
      id: identity.agentId,
      sessionId: identity.sessionId,
      provider: 'scripted',
      model: 'scripted-1',
      reasoningEffort: 'off',
      cwd: identity.cwd,
    }],
  });
};

/**
 * Boot the mobile profile: empty root, the dsh-base-equivalent spine mounted
 * over the pinned vendored packages, the scripted model under `llm`.
 *
 * @param options.scenario - E2E scenario id the caller logs under (used for
 *   the boot evidence events the caller emits).
 * @param options.container - profile container {cwd, tmpdir, home, env?, argv?}.
 * @param options.agentId - configured agent id (created by AgentLoop at mount).
 * @param options.sessionId - exact session identity for the configured agent.
 * @param options.cwd - session cwd (mobile-honest: a gateway fs scope label).
 * @param options.onEvent - observability hook: (event, fields) => void; boot
 *   emits `upstream.profile`, `model.scripted`, `upstream.services`.
 */
export async function bootUpstream(options) {
  const { scenario, container, agentId, sessionId, cwd, onEvent } = options;
  pinProfileContainer(container);

  const ctx = new Context();
  wireLogger(ctx);
  // Lifecycle listeners registered BEFORE the spine mounts, so boot-time
  // creation events (session/created, agent/created) are observable.
  for (const [type, fn] of Object.entries(options.listeners ?? {})) {
    ctx.on(type, fn);
  }

  // dsh-base row `llm` — mounted SCRIPTED on mobile (model.scripted boundary).
  const llm = createScriptedModelService({
    provider: 'scripted',
    model: 'scripted-1',
    deltas: ['Hello', ' from', ' upstream'],
    onStream: options.onModelStream,
  });
  ctx.provide('llm', llm);
  onEvent('model/scripted', {
    provider: 'scripted',
    model: 'scripted-1',
    note: 'upstream-shape driver; real dsh-llm transport lands with W-LLM vendor',
  });

  onEvent('upstream/profile', {
    profile: 'mobile',
    root: 'empty (patch layers compose over it)',
    upstream: '0.1.6-alpha.2 (vendored verbatim, sha256-pinned)',
    layers: MOBILE_LAYERS.map(([id]) => id),
  });

  await mountSpine(ctx, { agentId, sessionId, cwd });
  await demandServices(ctx);

  onEvent('upstream/services', {
    kernel: '@deepseek-ai/cordis@4.0.2',
    services: MOUNTED_SERVICES,
    scripted: ['llm'],
  });

  return { ctx, sessionId, agentId };
}
