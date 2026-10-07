// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * android-composer-live-write.js — the ON-DEVICE SESSION-WRITE runtime half behind
 * android.composer.live-write (decision D9, the Android W-DROID leg): the Android
 * sibling of composer-web-live.js — the FULL upstream agent spine boots inside the
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
import { stagedModels } from 'upstream/llm-route.js';
import { WRITE_ENDPOINTS, WRITE_STREAMS, errorOf } from 'upstream/web-write.js';
import { makeApiHandlerRespond } from 'web-live/api-handler-respond.js';

const SCENARIO = 'android.composer.live-write';
const AGENT_ID = 'main';
const SESSION_ID = 's-android-write-0001'; // the configured agent; the page creates its own
const EXPECTED_TEXT = 'Hello from upstream'; // the scripted endpoint's successText
const PICK_PROVIDER = 'mock'; // the drive's roster pick (the staged roster's provider)
const PICK_MODEL = 'mock-2'; // the second roster row: the pick turn B must serve

const log = createLogger('android.composer');
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
 * the user/message event can only come from the composer's admitted prompt
 * (turn A) or the drive's admitted prompt (turn B). On turn/end the
 * assistant text is asserted against the scripted stream; the SECOND settle
 * also reads the modelSelection projection's raw fold — `lastUsed` must have
 * adopted the pick and the matching request/header must have retired
 * `pending` (model-selection-projection.js's fold), the routing fact the
 * view alone cannot separate from a still-pending intent. */
const installTurnEvidence = (ctx) => {
  const turns = new Map(); // sessionId → {prompt, events, text, settled, nextSettled}
  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || event === undefined) return;
    let turn = turns.get(session.id);
    if (turn === undefined) {
      turn = { prompt: false, events: 0, text: '', settled: false, nextSettled: false };
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
    } else if (event.type === 'turn/end' && !turn.nextSettled) {
      turn.nextSettled = true;
      demand(turn.text === EXPECTED_TEXT,
        `page session "${session.id}" assistant text is "${turn.text}"`);
      emit('write.turn.settled.next', {
        sessionId: session.id, events: turn.events, text: turn.text,
      });
      const state = ctx.sessionProjections.stateOf(session, 'modelSelection');
      demand(state !== undefined, 'the modelSelection projection never registered');
      emit('write.projection.observed', {
        sessionId: session.id, lastUsed: state.lastUsed, pending: state.pending,
      });
    }
  });
};

/** The selection-plane evidence, straight off the live journal (the commit
 * evidence is the JOURNAL, never the selectModel rpc ack — a refusal
 * answers in-band and appends nothing): the `model/selection` intent, every
 * served `request/header` route (turn A's boot-route header beside turn B's
 * pick is the contrast that makes the routing fact readable), and the
 * vendored model-switch notice the pre-step inserts when the route changed
 * (the desktop-parity fact). */
const installSelectionEvidence = (ctx) => {
  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || event === undefined) return;
    if (event.type === 'model/selection') {
      emit('write.selection.observed', {
        sessionId: session.id, seq: event.seq,
        provider: event.data.provider, model: event.data.model,
      });
      return;
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config ?? {};
      emit('write.header.observed', {
        sessionId: session.id, seq: event.seq,
        provider: config.provider, model: config.model,
      });
      return;
    }
    if (event.type === 'user/message') {
      // The journal data IS the message (agent-loop :1026 appends it bare —
      // no .message envelope like assistant/message): content blocks joined.
      const blocks = event.data?.content;
      const text = Array.isArray(blocks)
        ? blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        : '';
      if (typeof text === 'string' && text.startsWith('[model changed:')) {
        emit('write.switch.notice.observed', {
          sessionId: session.id, seq: event.seq, notice: text,
        });
      }
    }
  });
};

/** The resident runtime half: claims + api.request + the follow streams all
 * answer from the spine, WITH the write surface composed. Evidence is
 * fail-loud: an UNSTRUCTURED claimed-endpoint failure is a defect and kills
 * the drive — but only after the shared guard (web-live/api-handler-respond.js,
 * loop-w2) answers the caller in band, so a structured refusal is a fast
 * in-band error, never the 30s RESPOND_TIMEOUT black-hole. */
const installRuntimeHalf = (ctx, cfg, roster) => {
  const onHandler = makeApiHandlerRespond({ post, fail, errorOf });
  const runtime = createWebBootRuntime({
    ctx, post,
    write: {
      root: cfg.containerRoot,
      provider: 'mock',
      model: 'mock-1',
      // The host-staged roster (runtime.config llmModels): the composer
      // model dialog's rows AND session/selectModel's routability check —
      // two rows are what make "the next turn serves the pick" expressible.
      models: roster,
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
  // The host-staged roster through the ONE validator (upstream/llm-route.js
  // stagedModels — fail loud on a malformed row); the drive's pick must be
  // on it, or "the next turn serves the pick" is not expressible here.
  const roster = stagedModels(cfg);
  demand(Array.isArray(roster) && roster.length >= 2
    && roster.some((row) => row.id === PICK_MODEL && row.name.length > 0),
    `runtime.config llmModels must stage the drive's pick `
      + `${JSON.stringify(PICK_MODEL)} among >= 2 rows: ${JSON.stringify(roster)}`);

  const ctx = await bootPhase(cfg);
  await awaitAgent(ctx);
  installTurnEvidence(ctx);
  installSelectionEvidence(ctx);
  installRuntimeHalf(ctx, cfg, roster);
  log.debug('b-android write-live runtime resident (write surface live; awaiting the page)', {});
};

main().catch(fail);
