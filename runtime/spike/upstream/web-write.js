// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write.js — the WRITE SURFACE adapter (decision D9, W-RPC
 * leg). The official UI's composer send is `POST /api/session/prompt`
 * (frozen envelope: `{args:{request:{requestId, sessionId, mode, content}}}`);
 * the reply reaches the page over the mux `session/follow` journal stream
 * (snapshot opening frame → live `event` entries → `assistant-stream`
 * notification frames). This adapter answers those endpoints from the REAL
 * vendored spine on the SAME ctx — the upstream Session/Workspace
 * controllers' behavior, narrowed to the attached-store subset the mobile
 * profile serves. Everything not implemented here stays structured-
 * unavailable (fail loud, never faked).
 *
 * The settings legs live in upstream/web-write-settings.js and the mux
 * feeds in upstream/web-write-streams.js.
 *
 * Upstream semantics mirrored from source at the pin:
 *   - prompt admission (api/session-controller commands.prompt): content
 *     validation, `source:{kind:'user', rpcId}`, followup/steer, `{accepted}`,
 *     admitted WITHOUT awaiting the turn — the journal streams the turn live.
 *   - session create (commands.create → agents.create): minted id, meta.cwd,
 *     agentOptions {provider, model}; adopt when the session already exists.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createFollowStreams } from 'upstream/web-write-streams.js';
import {
  makeNamespaceGuard,
  makeDescribeSettings,
  makeSettingsWrite,
} from 'upstream/web-write-settings.js';
import { makePluginInventoryHandler, makePluginManagerHandlers } from 'upstream/web-write-inventory.js';

/** The /api endpoints this surface claims (the generated TypertRemoteMap
 * spellings; `session.list` is the b3 probe's dot alias). The settings
 * legs: the 预设 panel's roster (agentPresets/*), the 插件 list's read-only
 * snapshot (pluginInventory/list), and the settings namespaces. */
export const WRITE_ENDPOINTS = [
  'session.list', 'session/list', 'session/create', 'session/prompt',
  'settings/describe', 'settings/update', 'settings/mutate',
  'agentPresets/list', 'agentPresets/read', 'agentPresets/copy',
  'agentPresets/deletePreset', 'agentPresets/select',
  'pluginInventory/list',
  // The settings 内置插件 section reads the manager's LIST legs directly
  // (no managementAvailable gate there — measured on device); both answer
  // READ-ONLY rows (`readOnlyReason: 'management-required'`). The WRITE
  // legs stay unclaimed: management is desktop machinery.
  'pluginManager/listBundles', 'pluginManager/listPlugins',
  // The settings 内置插件 SHELL's own loads: the subagent model-selection
  // card reads the model catalog and the credential state (measured on
  // device: both answering unavailable left the shell's generic
  // 暂时无法读取插件 banner up even with the inventory itself healthy).
  // Both answer the honest single-route facts of this host.
  'credentials/describe', 'session/modelCatalog',
];

/** The mux stream endpoints this surface attaches. */
export const WRITE_STREAMS = [
  'session/follow', 'workspace/follow', 'session/control', '$events',
];

/** Business failure carrying the upstream RemoteError wire shape. */
export const remoteError = (code, message, details = {}) => (
  { remote: true, code, message, details });

/** Map one thrown value onto the wire error triple. Two pass-throughs: this
 * adapter's own `remoteError` shape, and the VENDORED upstream RemoteError
 * (identified structurally by its `isDSHRemoteError` marker — the same
 * cross-realm identification upstream's own gateway uses), so a refusal
 * thrown by the real service (agent-preset/read-only, agent-preset/not-
 * found, ...) reaches the page with its real code, never flattened into a
 * generic unavailable. */
export const errorOf = (error) => {
  if (error && typeof error === 'object' && error.remote === true) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error && typeof error === 'object' && error.isDSHRemoteError === true
    && typeof error.code === 'string') {
    return { code: error.code, message: error.message, details: error.details ?? {} };
  }
  return {
    code: 'gateway/unavailable',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
};

/** Mint one RFC-4122-shaped v4 id from the host crypto (upstream randomUUID). */
export const mintUUID = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** upstream commands.create: `session-<uuid>` identities. */
const mintSessionId = () => `session-${mintUUID()}`;

/** upstream commands.prompt hasPromptContent: non-whitespace text or an
 * attachment part. */
const hasPromptContent = (content) => Array.isArray(content) && content.some(
  (part) => {
    if (part === null || typeof part !== 'object') return false;
    if (part.type === 'text') {
      return typeof part.text === 'string' && part.text.trim() !== '';
    }
    return part.type === 'image' || part.type === 'file';
  });

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;

/** upstream util-time canonicalClientTimeZone, narrowed for the runtime:
 * validate, then canonicalize only when Intl exists (quickjs may omit it). */
const canonicalTimeZone = (value) => {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined;
  try {
    if (typeof Intl === 'undefined') return value;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: value });
    const canonical = fmt.resolvedOptions().timeZone;
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
};

/** Mobile workspace registry state: the seeded container-root workspace. */
const seedWorkspace = (root) => {
  const base = root.replace(/\/+$/, '');
  const title = base.slice(base.lastIndexOf('/') + 1) || base;
  const now = new Date().toISOString();
  return {
    workspaceId: mintUUID(),
    path: base,
    title,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
};

/** The REAL session summaries (the b3 handler's shape, shared by both
 * endpoint spellings). */
const makeListSessions = (ctx) => async () => {
  const summaries = [];
  for (const session of ctx.sessions.list()) {
    const running = ctx.agents.get(session.id)?.status === 'running';
    summaries.push({
      sessionId: session.id,
      updatedAt: session.header?.createdAt ?? 0,
      running: running === true,
      blank: session.seq === 0,
      ...(session.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items: summaries };
};

/** The REAL create path: mint → agents.create (meta.cwd) → workspace
 * attach. Adoption mirrors upstream createOrAdopt: a live agent wins; a
 * cwd conflict rejects with `session/conflict`. */
const makeCreateSession = (ctx, deps) => async (args) => {
  const { streams, root, workspaces, seeded, llmRoute } = deps;
  const request = args?.request ?? args ?? {};
  if (request.workspaceId !== undefined && request.cwd !== undefined) {
    throw remoteError('gateway/bad-request',
      'session.create accepts workspaceId or cwd, not both', {});
  }
  const workspace = [...workspaces.values()].find(
    (ws) => ws.workspaceId === request.workspaceId);
  if (request.workspaceId !== undefined && workspace === undefined) {
    throw remoteError('workspace/not-found',
      `workspace "${request.workspaceId}" not found`,
      { workspaceId: request.workspaceId });
  }
  const cwd = workspace?.path ?? request.cwd ?? root;
  const sessionId = request.sessionId ?? mintSessionId();
  const live = ctx.agents.get(sessionId);
  if (live === undefined) {
    await ctx.agents.create({
      sessionId,
      agentOptions: { provider: llmRoute.provider, model: llmRoute.model },
      meta: { cwd },
    });
  } else if (live.session?.header?.cwd !== cwd) {
    throw remoteError('session/conflict',
      `session "${sessionId}" already exists at another directory`,
      { sessionId, requestedCwd: cwd, existingCwd: live.session?.header?.cwd });
  }
  streams.attachWorkspace(
    workspace ?? workspaces.get(seeded.workspaceId), sessionId);
  return { sessionId };
};

/** The REAL prompt admission (upstream commands.prompt, narrowed): admit
 * into the agent inbox and return — the turn streams via the journal. */
/** The agentPresets/* handlers: thin forwarders onto the service boot.js
 * mounted from @deepseek-ai/dsh-agent-presets. Wire names, argument names,
 * and the IMPLEMENTATION each wire method maps to follow the package's own
 * @Remote descriptors (dsh-api-remotes): list→remoteExportList,
 * read→readDocument, copy→remoteExportCopy, deletePreset→remoteExportDelete,
 * select→select — and select's `agent` parameter arrives on the wire as an
 * agentId, which the host resolves to the LIVE agent before invoking (the
 * same resolution commands.prompt does). The panel's wire names are
 * agentPresets/list, /read, /copy, /deletePreset, /select. */
const makeAgentPresetHandlers = (ctx) => {
  const call = async (method, args) => {
    const service = ctx.get('agentPresets');
    if (service === undefined) {
      throw remoteError('gateway/unavailable', 'agentPresets service is not mounted', {});
    }
    return service[method](...args);
  };
  return {
    'agentPresets/list': () => call('remoteExportList', []),
    'agentPresets/read': (args) => call('readDocument', [args?.agentPreset]),
    'agentPresets/copy': (args) => call('remoteExportCopy', [args?.from, args?.id, args?.name]),
    'agentPresets/deletePreset': (args) => call('remoteExportDelete', [args?.id]),
    'agentPresets/select': async (args) => {
      const agent = ctx.agents.get(args?.agent);
      if (agent === undefined) {
        throw remoteError('session/not-found',
          `session ${JSON.stringify(args?.agent ?? null)} is not attached to the mobile runtime`,
          { sessionId: args?.agent ?? null });
      }
      return call('select', [agent, args?.agentPreset]);
    },
  };
};

/** The endpointPresets adapter. The desktop keeps this service closed-source,
 * so there is nothing to port (D9 forbids inventing product behavior); what
 * THIS host knows is a platform fact: one model endpoint, the user's staged
 * credential. Reads project it (no key material); writes refuse honestly. */
const makeEndpointPresetAdapter = (options) => {
  const one = {
    id: 'default',
    name: 'This device (staged credential)',
    baseUrl: options.llm?.baseURL ?? '',
    model: options.llm?.model ?? '',
    readonly: true,
  };
  return {
    'endpointPresets/list': async () => ({
      presets: [one],
      default: one.id,
      authorable: false,
    }),
    'endpointPresets/read': async (args) => {
      if (String(args?.id ?? '') === one.id) return one;
      throw remoteError('endpoint-preset/not-found', `no endpoint preset "${String(args?.id)}"`, {});
    },
    'endpointPresets/create': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
    'endpointPresets/update': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
    'endpointPresets/delete': async () => {
      throw remoteError('gateway/unimplemented',
        'endpoint presets are read-only on this host (one staged credential)', {});
    },
  };
};

const makePromptSession = (ctx) => async (args) => {
  const request = args?.request ?? args;
  if (request === null || typeof request !== 'object'
    || typeof request.sessionId !== 'string'
    || typeof request.requestId !== 'string'
    || (request.mode !== 'queue' && request.mode !== 'steer')) {
    throw remoteError('gateway/bad-request',
      'prompt request needs requestId, sessionId, mode, content', {});
  }
  if (!hasPromptContent(request.content)) {
    throw remoteError('gateway/bad-request',
      'prompt content must include non-whitespace text or an attachment', {});
  }
  let clientTimeZone;
  if (request.clientTimeZone !== undefined) {
    clientTimeZone = canonicalTimeZone(request.clientTimeZone);
    if (clientTimeZone === undefined) {
      throw remoteError('session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone });
    }
  }
  const agent = ctx.agents.get(request.sessionId);
  if (agent === undefined) {
    throw remoteError('session/not-found',
      `session "${request.sessionId}" is not attached to the mobile runtime`,
      { sessionId: request.sessionId });
  }
  const source = {
    kind: 'user',
    rpcId: request.requestId,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  };
  const message = createUserMessage({ content: request.content, source });
  if (request.mode === 'steer') agent.steer(message);
  else agent.followup(message);
  return { accepted: true };
};

/**
 * The write surface over one booted spine ctx.
 * @param ctx - the spine context (ctx.sessions / agents / settings /
 *   loader / agentPresets).
 * @param post - the bus post fn (mux frames toward the carrier).
 * @param options.root - the profile container root: the seeded workspace's
 *   REAL directory and the default cwd for workspace-less creates.
 * @param options.provider, options.model - the llm route new agents select.
 * @param options.spine - () => the mounted runtime spine as plugin-inventory
 *   rows (boot.js `spineInventory`; the caller wires it so this adapter never
 *   imports boot.js — the bare compose-only embed does not carry the spine).
 * @returns {api, openStream, dispose}
 */

/** The settings 内置插件 SHELL's loads, from the boot's llm route: ONE
 * provider with ONE configured model (the staged credential). The catalog's
 * `default` IS the route the agent loop uses; nothing is invented.
 * credentials/set stays unclaimed (the credential file is the user's staged
 * profile, not writable through the wire). */
const shellLoadHandlers = (llmRoute) => ({
  'credentials/describe': async () => ({
    [llmRoute.provider]: {
      configured: true,
      source: 'staged profile credential (profiles/default/llm)',
      writable: false,
    },
  }),
  'session/modelCatalog': async () => ({
    default: { provider: llmRoute.provider, model: llmRoute.model },
    routableProviders: [llmRoute.provider],
    groups: [{
      id: llmRoute.provider,
      name: llmRoute.provider,
      models: [{ id: llmRoute.model, name: llmRoute.model }],
    }],
  }),
});

/** The /api handler map (split from createWriteSurface at the file-size
 * gate): every claimed endpoint's handler, keyed by wire name. */
const buildApiMap = (ctx, deps, options, ensureNamespaces) => ({
      'session.list': makeListSessions(ctx),
      'session/list': makeListSessions(ctx),
      'session/create': makeCreateSession(ctx, deps),
      'session/prompt': makePromptSession(ctx),
      'settings/describe': makeDescribeSettings(ctx, ensureNamespaces),
      'settings/update': makeSettingsWrite(ctx, ensureNamespaces,
        (settings, args) => settings.update(
          String(args.ns), args.patch, args.expectedRevision)),
      'settings/mutate': makeSettingsWrite(ctx, ensureNamespaces,
        (settings, args) => settings.mutate(
          String(args.ns), args.ops, args.expectedRevision)),
      // The Agent 预设 panel (contract parity with the desktop shell): the
      // presets service is the REAL vendored @deepseek-ai/dsh-agent-presets,
      // mounted by boot.js — these handlers forward, they do not reimplement.
      ...makeAgentPresetHandlers(ctx),
      // The settings 插件 list: an honest read-only snapshot of the mounted
      // spine + the staged client bundles + the Agent 预设 compositions
      // (upstream/web-write-inventory.js). managementAvailable is false —
      // the plugin-manager's write machinery stays unclaimed (fail loud).
      'pluginInventory/list': makePluginInventoryHandler(ctx, {
        spine: options.spine,
        stagedPlugins: options.stagedPlugins,
      }),
      // The manager's LIST legs: the same snapshot as read-only rows (the
      // wire's own `readOnlyReason: 'management-required'` member). Writes
      // stay unclaimed (fail loud).
      ...Object.fromEntries(Object.entries(
        makePluginManagerHandlers(ctx, {
          spine: options.spine,
          stagedPlugins: options.stagedPlugins,
        }),
      ).map(([name, handler]) => [`pluginManager/${name}`, handler])),
      ...shellLoadHandlers(deps.llmRoute),
      // The desktop's endpointPresets service is NOT public (no npm package —
      // unlike agentPresets). The platform fact this host can honestly serve:
      // exactly ONE model endpoint, the user's staged credential (its base
      // URL, model and label — never the key). Reads answer from it; writes
      // fail with the upstream RemoteError shape naming the limitation.
      ...makeEndpointPresetAdapter(options),
    });

export const createWriteSurface = (ctx, post, options) => {
  const root = options.root;
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw new Error(
      `web-write: profile container root not granted: ${JSON.stringify(root)}`);
  }
  const seeded = seedWorkspace(root);
  const workspaces = new Map([[seeded.workspaceId, seeded]]);
  const streams = createFollowStreams(ctx, post, root, workspaces);
  const ensureNamespaces = makeNamespaceGuard(ctx);
  const deps = {
    streams, root, workspaces, seeded,
    llmRoute: { provider: options.provider, model: options.model },
  };
  return {
    api: buildApiMap(ctx, deps, options, ensureNamespaces),
    openStream: streams.openStream,
    dispose: streams.dispose,
  };
};
