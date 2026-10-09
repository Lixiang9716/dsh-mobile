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
import { makePluginInventoryApiEntries } from 'upstream/web-write-inventory.js';
// The marketplace opt-in's VALIDATION (marketplaceOf) lives with the shape's
// consumer (web-write-marketplace.js); the handlers themselves spread only
// under the coverage plane's marketplace flag.
import { marketplaceOf } from 'upstream/web-write-marketplace.js';
// The COVERAGE plane (api-full-coverage): its endpoint lists, api-map
// assembly, and stream-open leg live in web-write-coverage.js (split at the
// code-size gate); the lists are re-exported here so the surface's public
// face stays one module.
import {
  COVERAGE_ENDPOINTS, COVERAGE_STREAMS,
  buildCoverageApi, openCoverageStream, createChangeFeed,
} from 'upstream/web-write-coverage.js';
// The catalog adapters (skills/goals/commands) and the MODEL-CATALOG plane
// (session/modelCatalog's shell loads, session/selectModel, session/fork)
// live in web-write-catalog.js; these ride the HISTORICAL claim set (the
// composer model dialog commits and forks through them even on
// non-coverage boots).
import {
  makeModelSelectionHandlers, makeSessionForkHandlers,
  makeSessionFeedbackHandlers, shellLoadHandlers,
} from 'upstream/web-write-catalog.js';
// The session deep-page legs (transcript paging, search, rename, the queue
// mutations, the desktop-opener gate): upstream/web-write-session.js.
import {
  makeSessionPageHandlers, makeSessionSearchHandlers,
  makeSessionRenameHandlers, makeSessionQueueHandlers,
  makeSessionOpenerHandlers,
} from 'upstream/web-write-session.js';
// The subagent control-plane legs (forwarders onto the vendored
// @deepseek-ai/dsh-subagent runtime boot.js mounts): upstream/
// web-write-subagents.js.
import { makeSubagentHandlers } from 'upstream/web-write-subagents.js';
// The preset adapters (agentPresets forwarders + the endpointPresets
// platform-fact adapter), split out at the code-size gate.
import {
  makeAgentPresetHandlers, makeEndpointPresetAdapter,
} from 'upstream/web-write-presets.js';
// The preset-join observability line's logger (the adapter's only log face).
import { createLogger } from 'logger.js';

const log = createLogger('web-write');

export { COVERAGE_ENDPOINTS, COVERAGE_STREAMS };

/** The /api endpoints this surface claims (the generated TypertRemoteMap
 * spellings; `session.list` is the b3 probe's dot alias). The settings
 * legs: the 预设 panel's roster (agentPresets/*), the 插件 list's read-only
 * snapshot (pluginInventory/list), and the settings namespaces. */
export const WRITE_ENDPOINTS = [
  'session.list', 'session/list', 'session/create', 'session/prompt',
  'session/cancel',
  // The composer model dialog's selection leg (the staged credential's
  // roster makes the catalog multi-model; this commits one session's pick).
  'session/selectModel',
  // The composer feedback dialog's record leg (the journal keeps the
  // session's feedback records — the `feedback/record` journal event).
  'sessionFeedback/record',
  // The composer dialog's Fork session leg: the child session the seat
  // forks server-side from one completed-turn prefix (the #306 thread's
  // design; the desktop controller's commands.fork semantics, narrowed).
  'session/fork',
  // The session deep-page legs (upstream/web-write-session.js; the T-0049
  // tail item): the transcript pager, the cross-session text search, the
  // user rename, the pending-queue mutations, and the desktop-opener gate
  // (canOpenWorkspacePath answers false so the page hides the open-in-app
  // asker — openWorkspacePath itself stays unclaimed). The permission
  // 预设 popup's catalog rides here too: the catalog IS the deployment's
  // configured preset table (interaction/permission-presets
  // src/index.ts catalog()), this host's composition configures none, and
  // the honest answer is the empty table — never a fabricated roster.
  'session/page', 'session/search', 'session/rename',
  'session/updateQueue', 'session/canOpenWorkspacePath',
  'permissionPresets/catalog',
  // The subagent control plane: forwarders onto the vendored
  // @deepseek-ai/dsh-subagent runtime (upstream/web-write-subagents.js).
  'subagents/list', 'subagents/prompt', 'subagents/interruptByParent',
  'settings/describe', 'settings/update', 'settings/mutate',
  'agentPresets/list', 'agentPresets/read', 'agentPresets/copy',
  'agentPresets/deletePreset', 'agentPresets/select',
  'pluginInventory/list',
  // The settings 内置插件 section reads the manager's LIST legs directly
  // (no managementAvailable gate there — measured on device). The spine and
  // staged tiers answer READ-ONLY rows (`readOnlyReason:
  // 'management-required'`); the workspace tier carries patchId rows — the
  // scope the WRITE legs manage in-band (#335 A1, over the §4 pipeline +
  // receipts journal + the dsh.plugins/1 registry).
  'pluginManager/listBundles', 'pluginManager/listPlugins',
  'pluginManager/installBundle', 'pluginManager/removeBundle',
  'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled',
  'pluginManager/inspect', 'pluginManager/cancelInstall',
  // The dynamicCordisRunner runtime-side legs (#335 B3): the page halves
  // (ui-cordis panel refresh + cordis-client-runner inspect sync) called
  // these on every load and read the structured unimplemented. The answers
  // are the honest mobile state (an empty dynamic roster; the synced client
  // inspect manifest recorded) — upstream/web-write-cordis.js.
  'dynamicCordisRunner/inventory', 'dynamicCordisRunner/syncInspectManifest',
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

/** The seat's preset-join opt-in: a fresh session's agent joins the
 * deployment default preset ("changing the default takes effect on the next
 * session created" — the vendored selection policy's own semantics; the
 * session is blank here, so no agent-preset/locked). Fail loud (rule 5): a
 * seat asking for the join staged no working roster, and a session that
 * silently joined nothing would answer the empty layer again (the exact
 * defect the flag exists to close). The agent resolves through the registry
 * lookup — the same live handle path the boot agent's join reads (the
 * create return carried no scoped ctx on the harmony seat, 2026-10-08).
 * The debug line after the mount is the join's observability half (T-0209):
 * the vendored service warns at `agent/created` — BEFORE this join runs — so
 * every page-created session logs that warn even when the join then covers
 * it; the paired line names what the session actually composed from. */
const joinCreatedSessionToDefault = async (ctx, sessionId) => {
  const service = ctx.get('agentPresets');
  if (service === undefined) {
    throw remoteError('gateway/unavailable',
      'session.create presetJoin: the agentPresets service is not mounted', {});
  }
  const agent = ctx.agents.get(sessionId);
  const preset = await service.mount(agent.ctx, undefined);
  log.debug('session preset joined', { sessionId, preset: preset?.id, agent: agent.id });
  return preset;
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
    // The seat's preset-join opt-in (joinCreatedSessionToDefault).
    if (deps.presetJoin === true) await joinCreatedSessionToDefault(ctx, sessionId);
  } else if (live.session?.header?.cwd !== cwd) {
    throw remoteError('session/conflict',
      `session "${sessionId}" already exists at another directory`,
      { sessionId, requestedCwd: cwd, existingCwd: live.session?.header?.cwd });
  }
  streams.attachWorkspace(
    workspace ?? workspaces.get(seeded.workspaceId), sessionId);
  return { sessionId };
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

/** The REAL cancel path (upstream session-controller commands.cancel at
 * the pin): abort the session's live turn with the user cause KEEPING the
 * inbox (queued messages are not dropped), idempotent on an idle agent.
 * The desktop leg's subagent-ownership guard is deliberately absent — the
 * mobile profile attaches no subagent-owned sessions. */
const makeCancelSession = (ctx) => async (args) => {
  const request = args?.request ?? args;
  if (request === null || typeof request !== 'object'
    || typeof request.sessionId !== 'string') {
    throw remoteError('gateway/bad-request',
      'cancel request needs sessionId', {});
  }
  const agent = ctx.agents.get(request.sessionId);
  if (agent === undefined) {
    throw remoteError('session/not-found',
      `session "${request.sessionId}" not found (not attached)`,
      { sessionId: request.sessionId });
  }
  agent.cancel({ kind: 'user' }, { keepInbox: true });
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
 * @param options.fullCoverage - optional COVERAGE flag (the api-full-
 *   coverage work stream): when true the surface also answers the full
 *   namespace surface (COVERAGE_ENDPOINTS / COVERAGE_STREAMS) from the
 *   vendored services boot.js mounted for it (options.goals /
 *   options.fileReferences / options.skills / options.commands). Without it
 *   the claim set and handlers are byte-identical to the pre-coverage
 *   surface (the delivered manifests pin that shape).
 * @param options.spine - () => the mounted runtime spine as plugin-inventory
 *   rows (boot.js `spineInventory`; the caller wires it so this adapter never
 *   imports boot.js — the bare compose-only embed does not carry the spine).
 * @returns {api, openStream, dispose}
 */

/** The /api handler map (split from createWriteSurface at the file-size
 * gate): every claimed endpoint's handler, keyed by wire name. */
const buildApiMap = (ctx, deps, options, ensureNamespaces) => ({
      'session.list': makeListSessions(ctx),
      'session/list': makeListSessions(ctx),
      'session/create': makeCreateSession(ctx, deps),
      'session/prompt': makePromptSession(ctx),
      'session/cancel': makeCancelSession(ctx),
      // The composer model dialog's commit leg: validates the pick against
      // the boot route and appends the model/selection intent to the live
      // session journal (the desktop controller's selectModel semantics).
      ...makeModelSelectionHandlers(ctx, deps.llmRoute),
      ...makeSessionFeedbackHandlers(ctx),
      // The composer dialog's Fork session leg: seeds the child from one
      // completed-turn prefix and attaches it to the profile's workspace.
      ...makeSessionForkHandlers(ctx, deps),
      // The session deep-page legs + opener gate + preset catalog
      // (upstream/web-write-session.js).
      ...makeSessionPageHandlers(ctx),
      ...makeSessionSearchHandlers(ctx),
      ...makeSessionRenameHandlers(ctx),
      ...makeSessionQueueHandlers(ctx),
      ...makeSessionOpenerHandlers(),
      'permissionPresets/catalog': async () => ({ options: [] }),
      // The subagent control plane: forwarders onto the vendored runtime
      // (upstream/web-write-subagents.js).
      ...makeSubagentHandlers(ctx),
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
      // The settings 插件 list: an honest snapshot of the mounted spine +
      // the staged client bundles + the Agent 预设 compositions
      // (upstream/web-write-inventory.js). managementAvailable stays false
      // (the desktop panel's machinery); the manager legs themselves — list
      // AND write — answer from this surface (#335 A1).
      ...makePluginInventoryApiEntries(ctx, options, deps),
      ...shellLoadHandlers(deps.llmRoute),
      // The desktop's endpointPresets service is NOT public (no npm package —
      // unlike agentPresets). The platform fact this host can honestly serve:
      // exactly ONE model endpoint, the user's staged credential (its base
      // URL, model and label — never the key). Reads answer from it; writes
      // fail with the upstream RemoteError shape naming the limitation.
      ...makeEndpointPresetAdapter(options),
    });

/** The write-surface deps (split from createWriteSurface at the code-size
 * gate): everything the api map's factories read. The coverage plane is
 * late-bound — deps.publish fans out through the streams' registry. */
const writeDeps = (options, streams, workspaces, seeded, archived) => ({
  streams, root: options.root, workspaces, seeded, archived,
  llmRoute: {
    provider: options.provider, model: options.model, baseURL: options.baseURL,
    // The staged credential's multi-model roster ({id, name} rows; absent
    // on mock/byok routes) — session/modelCatalog lists it and
    // session/selectModel validates against it.
    models: options.models,
    // The honest source fact (upstream/llm-route.js): 'staged' | 'byok' |
    // 'mock' | undefined (surfaces built without the route's provenance —
    // the CLI probes). The onboarding status answers from it.
    kind: options.routeKind,
  },
  // The plugin marketplace's opt-in (web-write-marketplace.js): the
  // validated {indexUrl} (publicKey optional — the resolver's declared
  // gap without it). Absent → the marketplace legs stay unclaimed.
  marketplace: marketplaceOf(options),
  // The seat's preset-join opt-in (T-0048's tail item): sessions the page
  // creates join the deployment default preset (the Agent 预设 policy's
  // own default), so the turn serves the joined composition instead of
  // the empty global layer. Absent → the historical shape (no join).
  presetJoin: options.presetJoin === true,
  // The workspace registry's gateway path (#346): the boot-derived
  // `<containerRoot minus fsScopeRoot>/plugins/registry.json` spelling
  // the LIST provider and the plugin_manager tool read — the write legs'
  // roster adoption must land in the SAME document the tier lists.
  // Absent → the legs keep their default (workspace == scope root) spelling.
  registryPath: typeof options.registryPath === 'string'
    ? options.registryPath : undefined,
  mintId: mintUUID,
  publish: streams.publish,
});

export const createWriteSurface = (ctx, post, options) => {
  const root = options.root;
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw new Error(
      `web-write: profile container root not granted: ${JSON.stringify(root)}`);
  }
  const seeded = seedWorkspace(root);
  const workspaces = new Map([[seeded.workspaceId, seeded]]);
  const archived = [];
  const coverage = options.fullCoverage === true ? { archived: () => archived } : undefined;
  const streams = createFollowStreams(ctx, post, root, workspaces, coverage);
  const deps = writeDeps(options, streams, workspaces, seeded, archived);
  if (coverage !== undefined) {
    coverage.open = (msg) => openCoverageStream(ctx, deps, createChangeFeed(ctx), post, msg);
  }
  return {
    api: {
      ...buildApiMap(ctx, deps, options, makeNamespaceGuard(ctx, deps.llmRoute)),
      ...(coverage === undefined ? {} : buildCoverageApi(ctx, deps)),
    },
    openStream: streams.openStream,
    cancel: streams.cancel,
    dispose: streams.dispose,
  };
};
