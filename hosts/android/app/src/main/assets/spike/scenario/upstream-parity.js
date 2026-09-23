/**
 * upstream parity scenario `upstream.parity` — the PORT LEG of the
 * differential consistency check against the upstream DSH packages.
 *
 * The same vendored spine that the Node reference leg
 * (runtime/spike/ci/parity-reference.mjs) composes under plain Node runs here
 * inside quickjs through the real mobile profile boot (upstream/boot.js,
 * decision D9): the scenario drives TWO scripted turns through the REAL
 * upstream agent loop — a plain success turn, then a TOOL-CALL round (the
 * mock streams a todo_write tool-call, the loop dispatches it through the
 * real ToolRuntime, the result feeds the next step) — plus the 401
 * transport-error leg. The authoritative session log is normalized by the
 * SHARED projector (scenario/parity-projector.js) and emitted one record per
 * line; the runner (ci/run-upstream-parity.sh) extracts these lines and the
 * comparator diffs them against the reference leg's projection of the same
 * turns. Parity passing means: same vendored packages, same scripted wire,
 * same session log on both hosts.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';
import { projectSessionEvents } from 'scenario/parity-projector.js';

const SCENARIO = 'upstream.parity';
const AGENT_ID = 'main';
const SESSION_ID = 's-upstream-parity-0001';
const TURN1_TEXT = 'Say hello';
const TURN2_TEXT = 'Track the parity check';
const EXPECTED_TEXT = 'Hello from upstream'; // the mock server's successText

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

/** Host adaptation — both shapes name the same mock endpoint facts:
 *  - CLI: the launch-env snapshot (--env KEY=VALUE) carries
 *    DSH_MOCK_LLM_URL/KEY (the node-side vendored mock server).
 *  - Android: the host delivers `runtime.config` {mockLlmUrl, apiKey,
 *    containerRoot} over the bus seam — the same handoff the session-live
 *    drives use — pointing at the carrier's on-device scripted route. */
const queue = [];
let wake = null;
globalThis.__dshBusOnMessage = (line) => {
  queue.push(JSON.parse(line));
  wake?.();
};

const takeRuntimeConfig = async () => {
  log.debug('take runtime config', {});
  for (;;) {
    const at = queue.findIndex((msg) => msg.type === 'runtime.config');
    if (at >= 0) return queue.splice(at, 1)[0];
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
};

const hostFacts = async () => {
  log.debug('host facts begin', {});
  // The shared C host defines __dshLaunchEnv on EVERY platform; the branch
  // key is whether the snapshot carries the mock facts (the CLI passes them
  // with --env — an Android launch env is an empty snapshot).
  const raw = globalThis.__dshLaunchEnv?.();
  let cliEnv = null;
  if (typeof raw === 'string') {
    try { cliEnv = JSON.parse(raw); } catch { cliEnv = null; }
  }
  if (cliEnv !== null && typeof cliEnv.DSH_MOCK_LLM_URL === 'string') {
    return { env: cliEnv, mockLlmUrl: cliEnv.DSH_MOCK_LLM_URL, mockLlmKey: cliEnv.DSH_MOCK_LLM_KEY, root: null };
  }
  const cfg = await takeRuntimeConfig();
  demand(typeof cfg.mockLlmUrl === 'string' && cfg.mockLlmUrl.startsWith('http://127.0.0.1:'),
    `runtime.config mock endpoint missing: ${JSON.stringify(cfg.mockLlmUrl)}`);
  return {
    env: { DSH_MOCK_LLM_URL: cfg.mockLlmUrl, DSH_MOCK_LLM_KEY: cfg.apiKey },
    mockLlmUrl: cfg.mockLlmUrl,
    mockLlmKey: cfg.apiKey,
    root: cfg.containerRoot ?? null,
  };
};

const bootPhase = async (facts) => {
  log.debug('boot phase begin', {});
  let root = facts.root;
  if (root === null) {
    const resolved = await fsScope.resolve('scope://app/');
    root = resolved?.path;
  }
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(root)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root,
    onEvent: emit,
    container: {
      cwd: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      env: facts.env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: facts.mockLlmUrl,
      apiKey: facts.mockLlmKey,
      provider: 'mock',
      model: 'mock-1',
    },
  });
  log.debug('boot phase done', {});
  return ctx;
};

const awaitAgent = async (ctx) => {
  log.debug('await agent begin', { sessionId: SESSION_ID });
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) {
    await Promise.resolve(); // creation is async past the AgentLoop mount (same wait as upstream-session)
  }
  demand(ctx.agents.get(SESSION_ID) !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  demand(ctx.sessions.get(SESSION_ID) !== undefined, `session "${SESSION_ID}" never appeared in the store`);
  return ctx.agents.get(SESSION_ID);
};

const driveTurn = async (agent, text) => {
  log.debug('drive turn', { text });
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

/** Emit the normalized session log, one record per parity line (the runner
 * extracts these; the comparator diffs them against the reference leg). */
const parityPhase = (ctx, session) => {
  log.debug('parity phase begin', {});
  const projected = projectSessionEvents(session.snapshotEvents());
  for (const record of projected) {
    emit('parity/event', { i: record.seq, record });
  }
  emit('parity/projected', { count: projected.length });

  const types = projected.map((record) => record.type);
  const failedAttempt = session.snapshotEvents().find((record) => record.type === 'assistant/attempt');
  if (failedAttempt !== undefined) {
    emit('parity/attempt/debug', { data: failedAttempt.data ?? null });
  }
  demand(types.includes('tool/call'), 'no tool/call in the session log — the tool round did not run');
  const toolCall = projected.find((record) => record.type === 'tool/call');
  demand(toolCall.tool === 'todo_write', `tool/call names "${toolCall.tool}", expected todo_write`);
  demand(types.includes('tool/result'), 'no tool/result in the session log');

  // Three assistant messages: turn 1's answer, turn 2's tool-call message
  // (text-less by construction — its content is the tool-call block), and
  // turn 2's closing answer after the tool result fed the next step.
  const assistantTexts = projected
    .filter((record) => record.type === 'assistant/message')
    .map((record) => record.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  demand(assistantTexts.length === 3, `expected 3 assistant messages, got ${assistantTexts.length}`);
  demand(assistantTexts[0] === EXPECTED_TEXT, `assistant message 1 text is "${assistantTexts[0]}"`);
  demand(assistantTexts[1] === '', `assistant message 2 (the tool-call message) carries text "${assistantTexts[1]}"`);
  demand(assistantTexts[2] === EXPECTED_TEXT, `assistant message 3 text is "${assistantTexts[2]}"`);

  const turnBoundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
  demand(turnBoundary !== undefined && turnBoundary.lastTurn === 2, `turnBoundary.lastTurn is ${turnBoundary?.lastTurn}`);
  emit('projection/turn-boundary', { lastTurn: turnBoundary.lastTurn });

  const todos = ctx.sessionProjections.stateOf(session, 'todos');
  demand(todos !== undefined && Array.isArray(todos) && todos.length === 1
    && todos[0].content === 'Track the parity check', `todos projection is ${JSON.stringify(todos)}`);
  emit('projection/todos', { count: todos.length, first: todos[0] });
};

/** Transport-error leg (same shape as upstream-session): the mock's scripted
 * 401 surfaces through the real LlmRuntime as the upstream error-finish. */
const errorPhase = async (ctx) => {
  log.debug('error phase begin', {});
  const stream = ctx.llm.stream({
    provider: 'mock',
    model: 'mock-1',
    messages: [createUserMessage({ content: [{ type: 'text', text: TURN1_TEXT }], source: { kind: 'user' } })],
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
};

const main = async () => {
  log.debug('main begin', {});
  const facts = await hostFacts();
  const ctx = await bootPhase(facts);
  emit('session/created', { sessionId: SESSION_ID, observed: true });
  emit('agent/created', { id: AGENT_ID, sessionId: SESSION_ID });

  const agent = await awaitAgent(ctx);
  await driveTurn(agent, TURN1_TEXT);
  emit('turn/completed', { turn: 1, text: EXPECTED_TEXT });
  await driveTurn(agent, TURN2_TEXT);
  emit('turn/completed', { turn: 2, toolRound: true });

  parityPhase(ctx, ctx.sessions.get(SESSION_ID));
  await errorPhase(ctx);

  emit('upstream/completed', {
    status: 'pass',
    parity: 'port leg projected; comparator diffs against the Node reference',
    upstream: '0.1.6-alpha.2',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
