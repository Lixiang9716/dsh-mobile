// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-catalog.js — the CATALOG COVERAGE adapters (decision D9,
 * api-full-coverage work stream): the session-scoped catalog faces the
 * official page drives — skills/list (the composer's "/" skill candidates),
 * fileReferences/list (the @-mention lexicon), goals/* (the goal panel), and
 * commands/list + commands/execute (the "/" command palette) — plus the
 * MODEL-CATALOG plane that rides the HISTORICAL claim set (web-write.js
 * spreads it on every boot): session/modelCatalog (the settings 内置插件
 * shell's load, from the boot's llm route) and session/selectModel (the
 * composer model dialog's commit leg). Each handler FORWARDS to the real
 * vendored service boot.js mounted (ctx.skills / fileReferences / goals /
 * commands) or answers the boot route's honest facts — they do not
 * reimplement; the wire argument names are the generated TypertRemoteMap
 * spellings, and the live agent each catalog handler addresses resolves
 * exactly like agentPresets/select does (ctx.agents.get).
 */
import { remoteError } from 'upstream/web-write.js';

/** The registry's own user-invocation filter, linked HERE only (a dynamic
 * import, the boot.js pattern): web-write.js composes on the bare
 * spine-less embed too, and a static dsh-skill edge would demand the package
 * on every leg whether or not the coverage plane is configured. */
const userInvocableFilter = async () => {
  const Skills = await import('@deepseek-ai/dsh-skill');
  return Skills.isUserInvocable;
};

/** The live agent a wire identity names, or the upstream not-found refusal
 * (the same resolution commands.prompt admission uses). */
const liveAgent = (ctx, agentId) => {
  const agent = ctx.agents.get(agentId);
  if (agent === undefined) {
    throw remoteError('session/not-found',
      `session ${JSON.stringify(agentId ?? null)} is not attached to the mobile runtime`,
      { sessionId: agentId ?? null });
  }
  return agent;
};

/** The caller lifetime the wire's cancellation parameter carries. The
 * carrier's frozen envelope delivers no signal, so every forwarded call runs
 * under a fresh live one (never aborted — cancellation is the page's own
 * disconnect, which the carrier answers by tearing the seat down). */
const liveSignal = () => new AbortController().signal;

/** Forward one call onto a mounted service, naming the boot flag when the
 * service is absent (a structured gap, never a fake row). */
const forward = async (ctx, service, method, args) => {
  const target = ctx.get(service);
  if (target === undefined) {
    throw remoteError('gateway/unavailable',
      `${service} service is not mounted (boot with the matching option)`, {});
  }
  return target[method](...args);
};

/** skills/list: the USER-invocable skills of one session's composition —
 * the same filter and wire projection the upstream session skill catalog
 * applies (packages/api/session-controller/src/skill-catalog.ts). */
export const makeSkillsHandlers = (ctx) => ({
  'skills/list': async (args) => {
    const agent = liveAgent(ctx, args?.request?.sessionId);
    const registry = ctx.get('skills');
    if (registry === undefined) {
      throw remoteError('gateway/internal',
        'skill registry is absent: the host composition does not mount @deepseek-ai/dsh-skill', {});
    }
    const isUserInvocable = await userInvocableFilter();
    const cwd = agent.session?.header?.cwd;
    const rows = (await registry.list({ cwd, scope: agent })).filter(isUserInvocable);
    return {
      skills: rows.map((skill) => ({
        name: skill.name,
        ...(skill.path === undefined ? {} : { path: skill.path }),
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        modelInvocable: skill.invocation.modelInvocable,
      })),
    };
  },
});

/** fileReferences/list: candidates for the composer's @ mention, from the
 * vendored local discovery service (dsh-file-reference-local). */
export const makeFileReferenceHandlers = (ctx) => ({
  'fileReferences/list': (args) => forward(ctx, 'fileReferences', 'list',
    [liveAgent(ctx, args?.agentId), String(args?.query ?? ''), liveSignal()]),
});

/** goals/*: the vendored event-sourced GoalService — every method takes the
 * exact live agent; the ref-carrying mutations expect the current revision. */
export const makeGoalHandlers = (ctx) => ({
  'goals/get': (args) => forward(ctx, 'goals', 'get', [liveAgent(ctx, args?.agentId)]),
  'goals/create': (args) => forward(ctx, 'goals', 'create',
    [liveAgent(ctx, args?.agentId), args?.request]),
  'goals/edit': (args) => forward(ctx, 'goals', 'edit',
    [liveAgent(ctx, args?.agentId), args?.ref, args?.request]),
  'goals/pause': (args) => forward(ctx, 'goals', 'pause',
    [liveAgent(ctx, args?.agentId), args?.ref]),
  'goals/resume': (args) => forward(ctx, 'goals', 'resume',
    [liveAgent(ctx, args?.agentId), args?.ref]),
  'goals/complete': (args) => forward(ctx, 'goals', 'complete',
    [liveAgent(ctx, args?.agentId), args?.ref]),
  'goals/clear': (args) => forward(ctx, 'goals', 'clear',
    [liveAgent(ctx, args?.agentId), args?.ref]),
});

/** commands/*: the upstream interactive-command registry — list answers the
 * wire descriptor array; execute runs the real command lifecycle (command/run
 * → handler → command/done in the session log). */
export const makeCommandHandlers = (ctx) => ({
  'commands/list': (args) => forward(ctx, 'commands', 'list',
    [liveAgent(ctx, args?.agentId)]),
  'commands/execute': (args) => forward(ctx, 'commands', 'execute',
    [liveAgent(ctx, args?.agentId), String(args?.line ?? ''),
      args?.submittedAttachments ?? [], liveSignal()]),
});

/** The model rows one llm route serves: the staged credential's roster
 * (`llmRoute.models`, entries `{id, name}`) when it carries one, else the
 * single configured model. Both the session/modelCatalog group and
 * session/selectModel's routability check read this ONE shape
 * (ModelCatalogModel — the generated wire type dsh-client-ui-model-selection
 * renders). */
const routeModelRows = (llmRoute) => (
  Array.isArray(llmRoute.models) && llmRoute.models.length > 0
    ? llmRoute.models
    : [{ id: llmRoute.model, name: llmRoute.model }]);

/** The settings 内置插件 SHELL's loads, from the boot's llm route: ONE
 * provider with the staged credential's model roster (the single configured
 * model when no roster is staged). The catalog's `default` IS the route the
 * agent loop uses; nothing is invented. `credentials/describe` here answers
 * the staged route only — the coverage plane (web-write-llm.js) OVERRIDES it
 * with the ref-keyed store-backed answer and claims the set/unset write
 * half; this historical row stays for the non-coverage boots whose delivered
 * manifests pin it byte-identical. */
export const shellLoadHandlers = (llmRoute) => ({
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
      models: routeModelRows(llmRoute),
    }],
  }),
});

/** session/selectModel: the composer model dialog's commit leg
 * (dsh-client-ui-model-selection calls sessions.selectModel). The desktop
 * controller's semantics at the pin, narrowed to this host's ONE routable
 * route (the boot route the write surface was built from): the provider must
 * equal it and the model must be one the route serves (the staged roster
 * when present, else the single configured model) — an unroutable pick fails
 * with the upstream vocabulary (`session/model-unavailable`, the code
 * commands.selectModel itself throws). A routable selection commits exactly
 * like the controller's selectForNextRequest: the `model/selection` intent
 * rides the live session journal AND the session's installed selection
 * holder's `current` (upstream/model-selection-holder.js, the vendored
 * installModelSelection's coupling) takes the pick — the next turn's
 * request/header carries it and the modelSelection projection folds
 * `lastUsed` from that header. The holder is reached through a DYNAMIC
 * import (this file's header note: a static @deepseek-ai/dsh-agent edge
 * would drag the spine into the compose-only embed's bundle). Like the
 * controller's selectionFor, the lookup is INSTALL-OR-RETURN per agent: the
 * dialog names ANY live session — the boot-configured agent whose holder
 * boot.js installed AND the sessions the page created through
 * session/create, whose agents mount nothing at boot. The lazy install's
 * fallback is the agent's own creation route (the write surface's llm route,
 * effort omitted — makeCreateSession passed exactly {provider, model}), so a
 * created session's first request stays byte-identical whether or not a
 * holder was installed. Refusing here instead would kill the interactive
 * spine on the first dialog commit (measured 2026-10-02: the configured
 * agent's holder left every page-created session unanswered and the spine
 * dead). Returns the desktop's `{selected}` envelope. */
export const makeModelSelectionHandlers = (ctx, llmRoute) => ({
  'session/selectModel': async (args) => {
    const agent = liveAgent(ctx, args?.sessionId);
    const provider = args?.provider;
    const model = args?.model;
    const reasoningEffort = args?.reasoningEffort;
    if (typeof provider !== 'string' || provider.length === 0
      || typeof model !== 'string' || model.length === 0) {
      throw remoteError('gateway/bad-request',
        'selectModel needs a provider and a model', {});
    }
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw remoteError('gateway/bad-request',
        'reasoningEffort must be a non-empty string when given', {});
    }
    const routable = routeModelRows(llmRoute).some((row) => row.id === model);
    if (provider !== llmRoute.provider || !routable) {
      throw remoteError('session/model-unavailable',
        `model ${JSON.stringify(model)} is not routable on this host `
          + `(provider ${JSON.stringify(llmRoute.provider)})`,
        { provider, model });
    }
    const selection = {
      provider, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const Holder = await import('upstream/model-selection-holder.js');
    const holder = Holder.sessionModelSelection(agent)
      ?? Holder.installSessionModelSelection(ctx, agent, {
        provider: llmRoute.provider, model: llmRoute.model,
      });
    agent.session.append('model/selection', selection);
    holder.current = selection;
    return { selected: selection };
  },
});
