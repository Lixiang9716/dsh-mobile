// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-catalog.js — the CATALOG COVERAGE adapters (decision D9,
 * api-full-coverage work stream): the session-scoped catalog faces the
 * official page drives — skills/list (the composer's "/" skill candidates),
 * fileReferences/list (the @-mention lexicon), goals/* (the goal panel), and
 * commands/list + commands/execute (the "/" command palette) — plus the
 * MODEL-CATALOG plane that rides the HISTORICAL claim set (web-write.js
 * spreads it on every boot): session/modelCatalog (the settings 内置插件
 * shell's load, from the boot's llm route), session/selectModel (the
 * composer model dialog's commit leg), and session/fork (the Fork E2E's
 * server-side half — the child session the dialog's "Fork session" posts
 * for). Each handler FORWARDS to the real
 * vendored service boot.js mounted (ctx.skills / fileReferences / goals /
 * commands) or answers the boot route's honest facts — they do not
 * reimplement; the wire argument names are the generated TypertRemoteMap
 * spellings, and the live agent each catalog handler addresses resolves
 * exactly like agentPresets/select does (ctx.agents.get).
 */
import { remoteError, mintUUID, errorOf } from 'upstream/web-write.js';

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
  // In-band errors (the #312 feedback-handler precedent): a thrown
  // RemoteError escalates through the interactive seat's fail-loud contract
  // and kills the whole spine — measured 2026-10-02 (a probe's unknown
  // sessionId took the seat down). The handler answers the wire's error
  // union instead.
  'session/selectModel': async (args) => {
    try {
      return await selectModelOnce(ctx, llmRoute, args);
    } catch (error) {
      const wire = errorOf(error);
      return { ok: false, error: { code: wire.code, message: wire.message,
        details: wire.details ?? {} } };
    }
  },
});

/** One validated selectModel commit (the body of the in-band-wrapped
 * handler). */
const selectModelOnce = async (ctx, llmRoute, args) => {
  const request = args?.request ?? args ?? {};
  const agent = liveAgent(ctx, request.sessionId);
  const provider = request.provider;
  const model = request.model;
  const reasoningEffort = request.reasoningEffort;
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
  return selection;
};

/** sessionFeedback/*: the composer feedback dialog's record leg
 * (dsh-command-feedback's wire face). The mobile seat records the feedback
 * into the live session journal — the `feedback/record` event type is in
 * the session vocabulary — and answers the vendored service's OWN result
 * union (dsh-command-feedback SessionFeedbackService.record at the pin):
 * `{ok: true, value: {recorded: true}}` on success, the IN-BAND
 * `{ok: false, error: {code: 'session-not-found', sessionId}}` for an
 * unknown session (resolved, never thrown — the page's recordSession reads
 * `carried.value.ok` / `carried.value.error.code`, so a thrown remoteError
 * or a bare `{recorded: true}` both leave the dialog's submit path
 * unanswered; measured 2026-10-02). The handler is ASYNC — every handler
 * in the surface's map must return a thenable (the seats' onHandler does
 * `outcome.run().then(...)`); this row shipped sync once and the seat died
 * on `TypeError: not a function` before any api.respond, answered 30s
 * later by the carrier's unimplemented envelope. The generated remote's
 * ONE parameter is wire-named `request`, so the page's frozen envelope
 * nests the fields (`{args: {request: {sessionId, text?, category?}}}`) —
 * the same unwrap session/selectModel takes (the top-level read answered
 * the synthesized probes and refused every REAL dialog submit). The
 * text/category projection is recordFeedback's own (trim, blank text
 * absent, category absent when undefined). */
export const makeSessionFeedbackHandlers = (ctx) => ({
  'sessionFeedback/record': async (args) => {
    const request = args?.request ?? args ?? {};
    const agent = ctx.agents.get(request.sessionId);
    if (agent === undefined) {
      return {
        ok: false,
        error: { code: 'session-not-found', sessionId: request.sessionId },
      };
    }
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    const record = {
      ...(text.length === 0 ? {} : { text }),
      ...(request.category === undefined ? {} : { category: request.category }),
    };
    agent.session.append('feedback/record', record);
    return { ok: true, value: { recorded: true } };
  },
});

/** The fork boundary scans, in plain loops (the desktop controller's
 * compiled `findLast`/`at(-1)` are not a given on the embedded engine for
 * adapter-authored code): the LAST completed turn's end, and the FIRST
 * turn/end at or after a sequence position. */
const lastTurnEnd = (events) => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/end') return events[i];
  }
  return undefined;
};
const nextTurnEndFrom = (events, atSeq) => {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].type === 'turn/end' && events[i].seq >= atSeq) return events[i];
  }
  return undefined;
};

/** The next event's sequence number on a snapshot (the log-end offset; -1
 * on an empty journal — the desktop controller's `lastSeq` convention). */
const lastSeqOf = (events) =>
  (events.length > 0 ? events[events.length - 1].seq : -1);

/** The desktop controller's fork boundary: with `atSeq`, the first
 * turn/end at or after it; a position past the journal's end falls back to
 * the LAST completed turn; without `atSeq`, the last completed turn.
 * Undefined when the ask has no completed turn covering it. */
const forkBoundary = (events, atSeq) => {
  const covering = atSeq === undefined ? undefined : nextTurnEndFrom(events, atSeq);
  if (covering !== undefined) return covering;
  return atSeq === undefined || atSeq > lastSeqOf(events)
    ? lastTurnEnd(events) : undefined;
};

/** The desktop controller's fork-unavailable message: a position inside a
 * still-open turn names the event; a journal with no completed turn says
 * so. Both carry the wire details' sessionId. */
const forkUnavailable = (sessionId, atSeq, lastSeq) => remoteError(
  'session/fork-unavailable',
  atSeq !== undefined && atSeq <= lastSeq
    ? `session ${JSON.stringify(sessionId)} has not completed `
      + `the turn containing event ${String(atSeq)}`
    : `session ${JSON.stringify(sessionId)} has no completed `
      + 'turn to fork from',
  { sessionId });

/** session/fork: the Fork E2E's server-side half — the composer dialog's
 * "Fork session" POSTs `{args: {request: {sessionId, atSeq?}}}` and this
 * handler answers `{sessionId: childId}`. The desktop controller's commands
 * .fork semantics at the pin, narrowed to v0 per-conversation fork: resolve
 * the source like every session-addressing handler (ctx.agents.get), cut at
 * the LAST completed turn's end — or, when `atSeq` names a position, the
 * first turn/end at or after it (a position past the log's end falls back
 * to the last; one inside an uncompleted turn refuses with the wire's
 * `session/fork-unavailable`, the controller's own code and message
 * shapes) — then create the child as a LIVE agent seeded with that exact
 * prefix: `agents.create({sessionId, seed, inheritedEventCount, meta:
 * {cwd?, parentSession, isSeeded: true}, agentOptions})`, the same
 * prepare() facts the session store's own fork primitive writes (the
 * isSeeded/inherited-prefix equality the store validates holds by
 * construction: seed = events.slice(0, cut), cut = boundary.seq + 1). The
 * child inherits the parent's cwd and the boot route's {provider, model}
 * (the facts session/create gives every new session; the replayed
 * request/header events keep the dialog's model view honest). The child
 * shares the parent's registry workspace (the profile's ONE seeded
 * workspace, session/create's attach) — NO desktop forkWorkspace copy
 * orchestration. The event scans read `snapshotEvents()` (the live
 * session's frozen log; the same read the store's fork primitive takes). */
export const makeSessionForkHandlers = (ctx, deps) => ({
  'session/fork': async (args) => {
    const request = args?.request ?? args ?? {};
    if (request.atSeq !== undefined && (typeof request.atSeq !== 'number'
      || !Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) {
      throw remoteError('gateway/bad-request',
        'atSeq must be a non-negative safe integer', {});
    }
    const agent = liveAgent(ctx, request.sessionId);
    const events = agent.session.snapshotEvents();
    const boundary = forkBoundary(events, request.atSeq);
    if (boundary === undefined) {
      throw forkUnavailable(request.sessionId, request.atSeq, lastSeqOf(events));
    }
    const cut = boundary.seq + 1;
    const childId = `session-${mintUUID()}`;
    const cwd = agent.session?.header?.cwd;
    await ctx.agents.create({
      sessionId: childId,
      seed: events.slice(0, cut),
      inheritedEventCount: cut,
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
        parentSession: agent.session.header.id,
        isSeeded: true,
      },
      agentOptions: {
        provider: deps.llmRoute.provider, model: deps.llmRoute.model,
      },
    });
    deps.streams.attachWorkspace(
      deps.workspaces.get(deps.seeded.workspaceId), childId);
    return { sessionId: childId };
  },
});
