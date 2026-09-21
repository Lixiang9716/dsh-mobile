// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * harmony-session-live.js — the ON-DEVICE SESSION-LIVE runtime half behind
 * b-harmony.session.live (decision D9, the W-HARMONY3 leg): the harmony twin
 * of b3-web-live.js. The FULL upstream agent spine boots inside the embedded
 * runtime (upstream/boot.js over the vendored closure — ctx.sessions /
 * agents / agentLoop / tools / systemPrompt / sessionProjections / settings
 * and the vendored dsh-llm LlmRuntime whose transport is the REAL gateway
 * httpFetch against the carrier's SCRIPTED chat-completions endpoint), and
 * the web-boot producer (upstream/web-boot.js) mounts the OFFICIAL boot wire
 * on the SAME context — so the carrier's `/api/session.list` and the mux
 * `session/journal` streams are CLAIMED and answered with REAL data from the
 * spine. Nothing is faked: endpoints the spine does not implement stay
 * structured-unavailable.
 *
 * LLM boundary (determinism): the transport is the REAL gateway adapter
 * (upstream/llm-transport.js) over gateway httpFetch, pointed at the
 * carrier's loopback SCRIPTED chat-completions endpoint — real HTTP + SSE,
 * scripted model output, logged as such (mirrors the CLI's node
 * dsh-llm-mock-server semantics).
 *
 * bus (all dispatches onto the one serial runtime queue):
 *   host → runtime : runtime.config {mockLlmUrl, apiKey, containerRoot},
 *                    web.plugins, api.request, mux.open, mux.cancel
 *   runtime → host : web.boot, api.claim, mux.claim, api.respond,
 *                    mux.item | mux.error | mux.end
 *
 * Sequence: boot (spine) → turn 1 'Say hello' through the REAL agent loop
 * (the session log gains the upstream turn vocabulary) → web.plugins (the
 * boot wire + claims posted; the carrier opens the page origin only after
 * this) → the probe's journal open attaches the REAL session log (baseline
 * frames) → turn 2 streams LIVE journal frames toward the attached page.
 * The scenario stays RESIDENT (never __dshComplete): the verdict is the
 * carrier-side probe's (SessionLiveProbe.ets), exactly like iOS.
 */
import { createLogger } from 'logger.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';
import { CLAIMED_ENDPOINTS, createWebBootRuntime } from 'upstream/web-boot.js';

const SCENARIO = 'b-harmony.session.live';
const AGENT_ID = 'main';
const SESSION_ID = 's-harmony-live-0001';
const TURN_1_TEXT = 'Say hello';
const TURN_2_TEXT = 'Say more';
const EXPECTED_TEXT = 'Hello from upstream'; // the scripted endpoint's successText


const log = createLogger('b3.web');
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
  fail(reason);
  throw new Error(reason);
};

/** Bus deliveries may arrive before the awaiting half exists (the drive
 * injects right after eval), so the subscription is module-scope, buffers,
 * and wakes pending `take()` waiters — never a poll. Once `dispatch` is
 * installed, deliveries go straight to it. */
const queue = [];
let wake = null;
let dispatch = null;
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  if (dispatch !== null) return dispatch(msg);
  queue.push(msg);
  wake?.();
};
const post = (msg) => globalThis.__dshBusPost?.(JSON.stringify(msg));

/** Wait for (and remove) the next delivery of one type. */
const take = async (type) => {
  for (;;) {
    const at = queue.findIndex((msg) => msg.type === type);
    if (at >= 0) return queue.splice(at, 1)[0];
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
};

/** Wait (bounded, microtask-granular — no timers) for the configured agent
 * and its session to appear in the registries (async past the mount). */
const awaitAgent = async (ctx) => {
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 100000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get(SESSION_ID) !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  demand(ctx.sessions.get(SESSION_ID) !== undefined, `session "${SESSION_ID}" never appeared in the store`);
  return ctx.agents.get(SESSION_ID);
};

/** One REAL upstream turn through the agent loop; resolves when idle. */
const runTurn = async (agent, text) => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

/** Boot the spine: the profile container is the host-granted root from the
 * runtime.config delivery (the staged bundle root — the caller-provided
 * $DSH_HOME/cwd collapse per upstream/README.md), the llm route the
 * carrier's scripted endpoint. */
const bootPhase = async (cfg) => {
  const root = cfg.containerRoot;
  demand(typeof root === 'string' && root.startsWith('/'),
    `profile container not granted by the host: ${JSON.stringify(root)}`);
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
      env: { DSH_MOCK_LLM_URL: cfg.mockLlmUrl, DSH_MOCK_LLM_KEY: cfg.apiKey },
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: cfg.mockLlmUrl,
      apiKey: cfg.apiKey,
      provider: 'mock',
      model: 'mock-1',
      adapterName: 'scripted loopback chat-completions (carrier mock-llm endpoint)',
      transportLabel: 'gateway httpFetch → carrier scripted chat-completions '
        + '(E2E determinism boundary, mirrors the CLI mock server)',
      onWire: (info) => emit('llm/request/built', info),
      onSse: (info) => emit('llm/sse', info),
    },
  });
  emit('session/created', { sessionId: SESSION_ID });
  emit('agent/created', { id: AGENT_ID, sessionId: SESSION_ID });
  return ctx;
};

/** Turn 1 evidence: the REAL session log the journal baseline will carry. */
const assertTurn = (ctx) => {
  const session = ctx.sessions.get(SESSION_ID);
  const events = session.snapshotEvents();
  const types = events.map((record) => record.type);
  emit('session.log', { count: types.length, types });
  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, 'no assistant/message in the session log');
  const text = assistant.data?.message?.content
    ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
  demand(text === EXPECTED_TEXT, `assistant text is "${text}"`);
  emit('assistant/text/asserted', { text });
  return session;
};

/** Turn 2 (once): its session records stream LIVE to every attached
 * session/journal stream — the deltas the page receives after attaching. */
const driveTurn2 = (ctx, agent) => {
  const before = ctx.sessions.get(SESSION_ID).seq;
  runTurn(agent, TURN_2_TEXT).then(() => {
    const after = ctx.sessions.get(SESSION_ID).seq;
    demand(after > before, 'turn 2 appended no session events');
    emit('journal/live', {
      turn: 2,
      events: after - before,
      note: 'streamed live to every attached session/journal stream',
    });
  }).catch(fail);
};

/** The runtime half for the OFFICIAL boot wire, mounted on the SPINE ctx:
 * claims + api.request + journal streams all answer from ctx.sessions. The
 * FIRST journal attach drives turn 2 — its records stream LIVE to every
 * attached page stream. */
const installRuntimeHalf = (ctx, agent) => {
  let turn2Driven = false;
  const onFirstAttach = () => {
    if (turn2Driven) return;
    turn2Driven = true;
    emit('session.journal.attached', { sessionId: SESSION_ID });
    driveTurn2(ctx, agent);
  };
  const onHandler = (msg, outcome) => {
    outcome.run().then(
      (value) => post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } }),
      (error) => post({
        type: 'api.respond', rpcId: msg.rpcId,
        result: { ok: false, error: { code: 'gateway/unavailable',
          message: error instanceof Error ? error.message : String(error), details: {} } },
      }),
    ).catch(fail);
  };
  const runtime = createWebBootRuntime({ ctx, post });
  const busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'booted') {
      emit('runtime.booted', {
        entries: outcome.entries,
        source: 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
      emit('session.services.claimed', {
        endpoints: CLAIMED_ENDPOINTS,
        stream: 'session/journal',
        source: 'the on-device spine (ctx.sessions)',
      });
    } else if (outcome.kind === 'handler') {
      onHandler(msg, outcome);
    } else if (outcome.kind === 'attached') {
      onFirstAttach();
    }
  };
  // `dispatch` installs BEFORE the buffer drains: a delivery racing the swap
  // goes direct or is still in the queue — never stranded, never doubled.
  dispatch = busHandler;
  for (const msg of queue.splice(0)) busHandler(msg);
};

const main = async () => {
  log.debug('main begin', {});
  const cfg = await take('runtime.config');
  demand(typeof cfg.mockLlmUrl === 'string' && cfg.mockLlmUrl.startsWith('http://127.0.0.1:'),
    `runtime.config mock endpoint missing: ${JSON.stringify(cfg.mockLlmUrl)}`);

  const ctx = await bootPhase(cfg);
  const agent = await awaitAgent(ctx);
  await runTurn(agent, TURN_1_TEXT);
  assertTurn(ctx);
  installRuntimeHalf(ctx, agent);
  log.debug('harmony session-live runtime resident (claims live; awaiting the page attach)', {});
};

main().catch(fail);
