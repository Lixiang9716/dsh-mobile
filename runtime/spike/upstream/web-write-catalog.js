// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-catalog.js — the CATALOG COVERAGE adapters (decision D9,
 * api-full-coverage work stream): the session-scoped catalog faces the
 * official page drives — skills/list (the composer's "/" skill candidates),
 * fileReferences/list (the @-mention lexicon), goals/* (the goal panel), and
 * commands/list + commands/execute (the "/" command palette). Each handler
 * FORWARDS to the real vendored service boot.js mounted (ctx.skills /
 * fileReferences / goals / commands) — they do not reimplement; the wire
 * argument names are the generated TypertRemoteMap spellings, and the live
 * agent each catalog addresses resolves exactly like agentPresets/select
 * does (ctx.agents.get).
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
