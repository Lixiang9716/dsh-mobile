/**
 * M2 upstream session scenario `m2.upstream-session` — ONE REAL upstream
 * agent-loop turn over the vendored DSH runtime (decision D9).
 *
 * Flow: upstream/boot.js composes the mobile profile (the dsh-base bundle
 * equivalent over the pinned vendor closure: sessions → agents → system-prompt
 * → tools → session-projection → settings → agent-loop, with `llm` mounted
 * scripted) → the AgentLoop config creates agent "main" on session
 * "s-m2-upstream-0001" → the scenario sends ONE user message through
 * ctx.agents' upstream handle → the loop assembles the system prompt, streams
 * the scripted model turn, appends the assistant message, and closes the turn
 * → the scenario walks ctx.sessions' session log (the upstream event
 * vocabulary, one structured log line per record) and asserts the turn
 * boundary projection. Every expected event is declared one-to-one in
 * tools/e2e/scenarios/m2-upstream-session.json.
 *
 * The scripted model service (`model.scripted`) is the only non-upstream
 * runtime component: the agent spine stays upstream, the driver stays
 * swappable; the real dsh-llm transport lands with W-LLM's vendor.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'm2.upstream-session';
const AGENT_ID = 'main';
const SESSION_ID = 's-m2-upstream-0001';
const INPUT_TEXT = 'Say hello';

const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  const withStack = error?.stack
    ? `${message} | ${error.stack.split('\n').slice(0, 4).join(' / ')}`
    : message;
  log.debug('scenario failed', { reason: withStack });
  emit('scenario.failed', { reason: withStack });
  globalThis.__dshComplete(false, withStack);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/** Minimal deterministic fields per upstream session-log record type
 * (record payloads live under `data`): a per-type projector table keeps each
 * mapper a pure expression. */
const SESSION_EVENT_FIELDS = {
  'turn/start': (data) => ({ turn: data.turn }),
  'step/start': (data) => ({ turn: data.turn, step: data.step }),
  'step/end': (data) => ({ turn: data.turn, step: data.step }),
  'system/message': (data, seq) => ({ seq, plugin: data.message?.source?.plugin }),
  'user/message': (data, seq) => ({ seq, source: data.message?.source?.kind }),
  'assistant/message': (data, seq) => ({
    seq,
    blocks: data.message?.content?.map((block) => block.type),
    text: data.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    provider: data.message?.source?.provider,
    model: data.message?.source?.model,
  }),
  'turn/end': (data) => ({ turn: data.turn, reason: data.reason?.kind ?? null }),
};
const fallbackFields = (data, seq) => ({ seq });
const sessionEventFields = (record) =>
  (SESSION_EVENT_FIELDS[record.type] ?? fallbackFields)(record.data ?? {}, record.seq);

/** Boot + capture boot-time lifecycle flags (the log lines themselves are
 * emitted post-turn in a fixed order so the expected log is stable). */
const bootPhase = async (captures) => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(resolved)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root, // absolute POSIX: the profile container root (upstream validates)
    onEvent: emit,
    container: {
      cwd: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      env: {},
      argv: ['dsh', '--profile', 'mobile'],
    },
    listeners: {
      'session/created': () => { captures.sessionCreated = true; },
      'agent/created': (id) => { captures.agentCreated = typeof id === 'string' ? id : AGENT_ID; },
      'agent/status': (status) => { captures.agentStatuses.push(typeof status === 'string' ? status : status?.status); },
      'agent/error': (info) => { captures.agentStatuses.push(`error:${JSON.stringify(info)?.slice(0, 200)}`); },
      'agent/disposed': () => { captures.agentStatuses.push('disposed'); },
      'session/disposed': () => { captures.agentStatuses.push('session-disposed'); },
    },
    onModelStream: (info) => { captures.requestHeader = info; },
  });
  log.debug('boot phase done', {});
  return ctx;
};

/** Wait (bounded, fail loud) for the configured agent, then drive one turn. */
const turnPhase = async (ctx) => {
  log.debug('turn phase begin', {});
  // Upstream identity: the agent id IS the session id (registry invariant);
  // creation is async past the AgentLoop mount, so poll the registry.
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get(SESSION_ID) !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  demand(ctx.sessions.get(SESSION_ID) !== undefined, `session "${SESSION_ID}" never appeared in the store`);

  const agent = ctx.agents.get(SESSION_ID);
  demand(agent !== undefined, `agent "${SESSION_ID}" not in the registry`);
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: INPUT_TEXT }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  log.debug('turn phase done', {});
  return ctx.sessions.get(SESSION_ID);
};

/** Walk the authoritative session log + assert the turn-boundary projection. */
const assertPhase = (ctx, session, captures) => {
  log.debug('assert phase begin', {});
  const events = session.snapshotEvents();
  for (const record of events) {
    emit(record.type, sessionEventFields(record));
  }
  const types = events.map((record) => record.type);
  emit('session/log/asserted', { count: types.length, types });

  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, 'no assistant/message in the session log');
  const text = assistant.data?.message?.content
    ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
  demand(text === 'Hello from upstream', `assistant text is "${text}"`);
  emit('assistant/text/asserted', { text });

  demand(captures.requestHeader !== null, 'scripted model saw no request');
  emit('model/request', {
    provider: captures.requestHeader.provider,
    model: captures.requestHeader.model,
    tools: captures.requestHeader.tools,
    messages: captures.requestHeader.messages,
  });
  for (const status of captures.agentStatuses) {
    emit('agent/status', { status: typeof status === 'string' ? status : String(status) });
  }

  const turnBoundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
  demand(turnBoundary !== undefined, 'turnBoundary projection missing');
  demand(turnBoundary.lastTurn === 1, `turnBoundary.lastTurn is ${turnBoundary.lastTurn}`);
  emit('projection/turn-boundary', { lastTurn: turnBoundary.lastTurn });
};

const main = async () => {
  log.debug('main begin', {});
  const captures = { sessionCreated: false, agentCreated: null, agentStatuses: [], requestHeader: null };
  const ctx = await bootPhase(captures);

  // The scoped session/created emission may not reach a root-context listener
  // (cordis scope filtering); the store is the truth, the flag is evidence.
  emit('session/created', { sessionId: SESSION_ID, observed: captures.sessionCreated });
  emit('agent/created', { id: captures.agentCreated ?? AGENT_ID, sessionId: SESSION_ID });

  const session = await turnPhase(ctx);
  assertPhase(ctx, session, captures);

  emit('upstream/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    scripted: 'model.scripted (dsh-llm transport lands with W-LLM)',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
