/**
 * M2 upstream session scenario `upstream.session` — ONE REAL upstream
 * agent-loop turn over the vendored DSH runtime (decision D9), driven by the
 * REAL vendored dsh-llm service over the gateway transport (the W-LLM leg).
 *
 * Flow: upstream/boot.js composes the mobile profile (the dsh-base bundle
 * equivalent over the pinned vendor closure: sessions → agents → system-prompt
 * → tools → session-projection → settings → agent-loop, with `llm` = the
 * vendored LlmRuntime + the gateway-transport adapter) → the AgentLoop config
 * creates agent "main" on session "s-m2-upstream-0001" → the scenario sends
 * ONE user message through ctx.agents' upstream handle → the loop assembles
 * the system prompt, prepareCall resolves through the adapter registry, the
 * adapter POSTs the wire request through gateway httpFetch to the node-side
 * dsh-llm-mock-server (real loopback HTTP/SSE), the SSE bytes parse into
 * harness StreamChunks, agent-loop's BlockAssembler appends the assistant
 * message, and the turn closes → the scenario walks ctx.sessions' session
 * log (the upstream event vocabulary) and asserts the turn boundary.
 * Explicit llm-path evidence rides the adapter hooks: the wire request built
 * against the harness request (llm.request.built) and each SSE payload as
 * decoded (llm.sse.*). A second leg re-streams the route through the REAL
 * LlmRuntime against the mock's scripted 401 behavior to prove structured
 * transport errors surface as the upstream error-finish protocol. Every
 * expected event is declared one-to-one in
 * tools/e2e/scenarios/upstream-session.json.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'upstream.session';
const AGENT_ID = 'main';
const SESSION_ID = 's-m2-upstream-0001';
const INPUT_TEXT = 'Say hello';
const EXPECTED_TEXT = 'Hello from upstream'; // the mock server's successText (ci/mock-llm-server.mjs)

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

/** The launch env snapshot (--env KEY=VALUE on the CLI) — the mock endpoint
 * facts ride the same channel upstream process.env would. */
const launchEnv = () => {
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  const env = JSON.parse(raw);
  log.debug('launch env', { keys: Object.keys(env) });
  return env;
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
const bootPhase = async (captures, env) => {
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
      env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: env.DSH_MOCK_LLM_URL,
      apiKey: env.DSH_MOCK_LLM_KEY,
      provider: 'mock',
      model: 'mock-1',
      onWire: (info) => { captures.wire = info; emit('llm/request/built', info); },
      onSse: (info) => { captures.sse.push(info); emit('llm/sse', info); },
    },
    listeners: {
      'session/created': () => { captures.sessionCreated = true; },
      'agent/created': (id) => { captures.agentCreated = typeof id === 'string' ? id : AGENT_ID; },
      'agent/status': (status) => { captures.agentStatuses.push(typeof status === 'string' ? status : status?.status); },
      'agent/error': (info) => { captures.agentStatuses.push(`error:${JSON.stringify(info)?.slice(0, 200)}`); },
      'agent/disposed': () => { captures.agentStatuses.push('disposed'); },
      'session/disposed': () => { captures.agentStatuses.push('session-disposed'); },
    },
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
  demand(text === EXPECTED_TEXT, `assistant text is "${text}"`);
  emit('assistant/text/asserted', { text });

  demand(captures.wire !== null, 'the adapter saw no wire request');
  demand(captures.wire.agentLoopMarked === true, 'the streamed request was not assembled by the upstream agent loop');

  for (const status of captures.agentStatuses) {
    emit('agent/status', { status: typeof status === 'string' ? status : String(status) });
  }

  const turnBoundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
  demand(turnBoundary !== undefined, 'turnBoundary projection missing');
  demand(turnBoundary.lastTurn === 1, `turnBoundary.lastTurn is ${turnBoundary.lastTurn}`);
  emit('projection/turn-boundary', { lastTurn: turnBoundary.lastTurn });
};

/** Transport-error leg: the mock's second scripted behavior is a 401 JSON
 * error body — streamed through the REAL LlmRuntime's public stream API, so
 * the adapter's non-2xx diagnosis surfaces as the upstream error-finish
 * protocol (terminal finish chunk carrying the provider-neutral failure). */
const errorPhase = async (ctx) => {
  log.debug('error phase begin', {});
  const stream = ctx.llm.stream({
    provider: 'mock',
    model: 'mock-1',
    messages: [createUserMessage({ content: [{ type: 'text', text: INPUT_TEXT }], source: { kind: 'user' } })],
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  demand(chunks.length === 1, `error leg yielded ${chunks.length} chunks`);
  const [finish] = chunks;
  demand(finish.type === 'finish', `error leg chunk type is ${finish.type}`);
  demand(finish.reason.kind === 'error', `error finish kind is ${finish.reason.kind}`);
  emit('llm/transport/error', {
    kind: finish.reason.kind,
    code: finish.reason.failure?.code,
    status: finish.reason.failure?.status,
  });
  log.debug('error phase done', {});
};

const main = async () => {
  log.debug('main begin', {});
  const env = launchEnv();
  demand(typeof env.DSH_MOCK_LLM_URL === 'string' && env.DSH_MOCK_LLM_URL.startsWith('http://127.0.0.1:'),
    `mock LLM endpoint missing from the launch env: ${JSON.stringify(env.DSH_MOCK_LLM_URL)}`);
  const captures = { sessionCreated: false, agentCreated: null, agentStatuses: [], wire: null, sse: [] };
  const ctx = await bootPhase(captures, env);

  // The scoped session/created emission may not reach a root-context listener
  // (cordis scope filtering); the store is the truth, the flag is evidence.
  emit('session/created', { sessionId: SESSION_ID, observed: captures.sessionCreated });
  emit('agent/created', { id: captures.agentCreated ?? AGENT_ID, sessionId: SESSION_ID });

  const session = await turnPhase(ctx);
  assertPhase(ctx, session, captures);
  await errorPhase(ctx);

  emit('upstream/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    llm: 'vendored dsh-llm over gateway httpFetch (dsh-llm-mock-server)',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
