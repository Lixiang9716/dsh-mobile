// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * b-android-write-live.js — the ON-DEVICE SESSION-WRITE runtime half behind
 * b-android.write.live (decision D9, the Android W-DROID leg): the Android
 * sibling of b4-web-live.js — the FULL upstream agent spine boots inside the
 * embedded runtime (upstream/boot.js) and the web-boot producer mounts the
 * official boot wire COMPOSED WITH THE WRITE SURFACE (upstream/web-write.js
 * — real session/create + prompt admission + the session/follow /
 * workspace/follow / session/control / $events streams + the settings
 * describe), and then goes RESIDENT: the official UI's own composer message
 * drives a REAL upstream agent-loop turn — nothing here pre-plays it.
 *
 * LLM boundary (determinism): the transport is the REAL gateway adapter
 * (upstream/llm-transport.js) over gateway httpFetch, pointed at the
 * carrier's loopback SCRIPTED chat-completions endpoint — real HTTP + SSE,
 * scripted model output, logged as such (mirrors the CLI mock server).
 *
 * bus (all dispatches onto the one serial runtime queue):
 *   host → runtime : runtime.config {mockLlmUrl, apiKey, containerRoot},
 *                    web.plugins, api.request, mux.open, mux.cancel
 *   runtime → host : web.boot, api.claim, mux.claim, api.respond,
 *                    mux.item | mux.error | mux.end
 *
 * One Android transport fact (the session-live sibling's): logcat truncates
 * lines at ~4KB, so `runtime.booted` emits `entryCount` instead of the 58-id
 * list (the iOS sibling logs the full array — no such cap there).
 */
import { createLogger } from 'logger.js';
import { bootUpstream, spineInventory } from 'upstream/boot.js';
import { createWebBootRuntime } from 'upstream/web-boot.js';
import { WRITE_ENDPOINTS, WRITE_STREAMS, errorOf } from 'upstream/web-write.js';

const SCENARIO = 'b-android.write.live';
const AGENT_ID = 'main';
const SESSION_ID = 's-android-write-0001'; // the configured agent; the page creates its own
const EXPECTED_TEXT = 'Hello from upstream'; // the scripted endpoint's successText

const log = createLogger('b-android.write');
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

/** Boot the spine: the profile container is the host-granted root from the
 * runtime.config delivery (the staged bundle root — the seeded workspace's
 * REAL directory), the llm route the carrier's scripted endpoint. */
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
  return ctx;
};

/** The assistant text of one assistant/message event (upstream message shape:
 * data.message.content blocks; text blocks joined). */
const assistantTextOf = (event) => (event?.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text').map((block) => block.text).join('');

/** Turn evidence for the PAGE-driven session: the runtime never prompts —
 * the user/message event can only come from the composer's admitted prompt.
 * On turn/end the assistant text is asserted against the scripted stream. */
const installTurnEvidence = (ctx) => {
  const turns = new Map(); // sessionId → {prompt, events, text, settled}
  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || event === undefined) return;
    let turn = turns.get(session.id);
    if (turn === undefined) {
      turn = { prompt: false, events: 0, text: '', settled: false };
      turns.set(session.id, turn);
    }
    turn.events++;
    if (event.type === 'user/message' && !turn.prompt) {
      turn.prompt = true;
      emit('write.prompt.observed', { sessionId: session.id, seq: event.seq });
    }
    if (event.type === 'assistant/message') turn.text = assistantTextOf(event);
    if (event.type === 'turn/end' && !turn.settled) {
      turn.settled = true;
      demand(turn.text === EXPECTED_TEXT,
        `page session "${session.id}" assistant text is "${turn.text}"`);
      emit('write.turn.settled', {
        sessionId: session.id, events: turn.events, text: turn.text,
      });
    }
  });
};

/** The resident runtime half: claims + api.request + the follow streams all
 * answer from the spine, WITH the write surface composed. Evidence is
 * fail-loud: a claimed endpoint failing is a defect and kills the drive. */
const installRuntimeHalf = (ctx, cfg) => {
  const onHandler = (msg, outcome) => {
    outcome.run().then(
      (value) => post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } }),
      (error) => {
        // A claimed-endpoint failure is a real defect, never a structured
        // shrug: kill the drive naming the wire error triple (fail loud).
        const wire = errorOf(error);
        fail(`claimed endpoint ${msg.endpoint} failed: ${wire.code}: ${wire.message}`);
      },
    ).catch(fail);
  };
  const runtime = createWebBootRuntime({
    ctx, post,
    write: {
      root: cfg.containerRoot,
      provider: 'mock',
      model: 'mock-1',
      // The 插件 inventory's spine plane: the REAL mounts, read from ctx.
      spine: () => spineInventory(ctx),
    },
  });
  const busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'booted') {
      // entryCount, not the 58-id list: logcat's ~4KB line budget truncates
      // the full array mid-JSON and the E2E capture loses the record (the
      // iOS sibling logs the full list — no such transport cap there).
      emit('runtime.booted', {
        entryCount: outcome.entries.length,
        source: 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
      emit('write.surface.claimed', {
        endpoints: WRITE_ENDPOINTS, streams: WRITE_STREAMS,
        source: 'the on-device spine (ctx.sessions/agents/settings)',
      });
    } else if (outcome.kind === 'handler') {
      onHandler(msg, outcome);
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
  await awaitAgent(ctx);
  installTurnEvidence(ctx);
  installRuntimeHalf(ctx, cfg);
  log.debug('b-android write-live runtime resident (write surface live; awaiting the page)', {});
};

main().catch(fail);
