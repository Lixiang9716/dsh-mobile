// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * b4-web-live.js — the ON-DEVICE SESSION-WRITE runtime half behind
 * b4.write.live (decision D9, the W-RPC leg): the upstream spine answers the
 * official app's WRITE surface. The composer send is `POST /api/session/prompt`
 * (frozen envelope, args.request {requestId, sessionId, mode, content}); the
 * reply streams back over the mux `session/follow` journal (snapshot opening
 * frame → live event entries → assistant-stream notification frames with
 * monotonic revisions). This scenario boots the FULL spine, mounts the
 * web-boot producer COMPOSED WITH THE WRITE SURFACE (upstream/web-write.js —
 * real session/create + prompt admission + the follow streams + the settings
 * describe + the workspace feed over the profile container), and then goes
 * RESIDENT: the page's own composer message drives a REAL upstream agent-loop
 * turn — nothing here pre-plays it.
 *
 * LLM boundary (determinism): the transport is the REAL gateway adapter over
 * gateway httpFetch, pointed at the carrier's loopback SCRIPTED
 * chat-completions endpoint (real HTTP + SSE, scripted model output) — same
 * boundary as b3.
 *
 * bus (all dispatches onto the one serial runtime queue):
 *   host → runtime : runtime.config {mockLlmUrl, apiKey, containerRoot},
 *                    web.plugins, api.request, mux.open, mux.cancel
 *   runtime → host : web.boot, api.claim, mux.claim, api.respond,
 *                    mux.item | mux.error | mux.end
 */
import { createLogger } from 'logger.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWebBootRuntime } from 'upstream/web-boot.js';
import { WRITE_ENDPOINTS, WRITE_STREAMS, errorOf } from 'upstream/web-write.js';

const SCENARIO = 'b4.write.live';
const AGENT_ID = 'main';
const SESSION_ID = 's-b4-ondevice-0001'; // the configured agent; the page creates its own session
const EXPECTED_TEXT = 'Hello from upstream'; // the scripted endpoint's successText

/** The llm route for this boot, from the host's runtime.config. TWO shapes,
 * and which one is live decides whether the turn text is asserted:
 *
 *   llmBaseUrl present → a REAL user-supplied OpenAI-compatible endpoint (the
 *     user-facing serving boot). The turn is a genuine model call, so its text
 *     is nondeterministic and NOT asserted — the settled event carries whatever
 *     the model said (the m2.llm leg's honesty: a served turn is reported, not
 *     predicted).
 *   otherwise → the carrier's scripted loopback endpoint (the E2E determinism
 *     boundary b4.write.live pins). The loopback demand is what keeps a drive
 *     from silently reaching the network, so it stays fail-loud.
 *
 * The key never reaches a record: it rides apiKey only, and the transport
 * labels name the endpoint's HOST, never the credential. */
const resolveLlmRoute = (cfg) => {
  if (typeof cfg.llmBaseUrl === 'string' && cfg.llmBaseUrl.length > 0) {
    demand(typeof cfg.llmApiKey === 'string' && cfg.llmApiKey.length > 0,
      'runtime.config llmBaseUrl given without llmApiKey');
    demand(typeof cfg.llmModel === 'string' && cfg.llmModel.length > 0,
      'runtime.config llmBaseUrl given without llmModel');
    const provider = typeof cfg.llmProvider === 'string' && cfg.llmProvider.length > 0
      ? cfg.llmProvider : 'openai-compatible';
    let host = 'the configured endpoint';
    try { host = new URL(cfg.llmBaseUrl).host; } catch { /* keep the generic label */ }
    return {
      baseURL: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, provider,
      model: cfg.llmModel, scripted: false, userEndpoint: true,
      adapterName: `user-supplied OpenAI-compatible endpoint (${provider})`,
      transportLabel: `gateway httpFetch → ${host} (user-supplied endpoint)`,
    };
  }
  demand(typeof cfg.mockLlmUrl === 'string' && cfg.mockLlmUrl.startsWith('http://127.0.0.1:'),
    `runtime.config mock endpoint missing: ${JSON.stringify(cfg.mockLlmUrl)}`);
  return {
    baseURL: cfg.mockLlmUrl, apiKey: cfg.apiKey, provider: 'mock',
    model: 'mock-1', scripted: true, userEndpoint: false,
    adapterName: 'scripted loopback chat-completions (carrier mock-llm endpoint)',
    transportLabel: 'gateway httpFetch → carrier scripted chat-completions '
      + '(E2E determinism boundary, mirrors the CLI mock server)',
  };
};

const log = createLogger('b4.web');
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
 * runtime.config delivery (the seeded workspace's REAL directory), the llm
 * route the carrier's scripted endpoint. */
const bootPhase = async (cfg, route) => {
  const root = cfg.containerRoot;
  demand(typeof root === 'string' && root.startsWith('/'),
    `profile container not granted by the host: ${JSON.stringify(root)}`);
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
      // The granted scope's root: the fs shims map absolute paths onto
      // (scope, scope-relative path) through it. Absent on a host that grants
      // no scope, in which case the shims refuse rather than guess.
      scopeRoot: cfg.fsScopeRoot,
      env: { DSH_MOCK_LLM_URL: route.baseURL, DSH_MOCK_LLM_KEY: route.apiKey },
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: route.baseURL,
      apiKey: route.apiKey,
      provider: route.provider,
      model: route.model,
      userEndpoint: route.userEndpoint,
      adapterName: route.adapterName,
      transportLabel: route.transportLabel,
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
 * On turn/end the assistant text is asserted against the scripted stream —
 * ONLY on the scripted route: a real endpoint's turn is nondeterministic, so
 * it is reported verbatim and never predicted (asserting it would turn every
 * honest answer into a drive failure). */
const installTurnEvidence = (ctx, route) => {
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
      if (route.scripted) {
        demand(turn.text === EXPECTED_TEXT,
          `page session "${session.id}" assistant text is "${turn.text}"`);
      }
      emit('write.turn.settled', {
        sessionId: session.id, events: turn.events, text: turn.text,
      });
    }
  });
};

/** The resident runtime half: claims + api.request + the follow streams all
 * answer from the spine, WITH the write surface composed. Evidence is
 * fail-loud: a claimed endpoint failing is a defect and kills the drive. */
const installRuntimeHalf = (ctx, cfg, route) => {
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
    write: { root: cfg.containerRoot, provider: route.provider, model: route.model },
  });
  const busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'booted') {
      emit('runtime.booted', {
        entries: outcome.entries.length,
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


/** TEMPORARY DIAGNOSTIC (removed before landing): exercise the five contract
 * v1.1.0 filesystem primitives on the device and print what came back. Uses
 * log.debug so no canonical record is added and the manifest's one-to-one
 * match is untouched. */
const probeFsPrimitives = async () => {
  const gw = await import('gateway.js');
  const { encodeUtf8, decodeUtf8 } = await import('node:buffer');
  const out = { stage: 'start' };
  const check = async (label, fn) => {
    try {
      out[label] = await fn();
    } catch (error) {
      out[label] = `ERR ${error?.code ?? '?'}: ${error?.message ?? error}`;
    }
  };
  await check('mkdir', async () => { await gw.fsMkdir('app', 'probe/sub'); return 'ok'; });
  await check('write', async () => {
    const r = await gw.fsWrite('app', 'probe/sub/hello.txt', encodeUtf8('hello primitives'));
    return `written=${r.written}`;
  });
  await check('read', async () => {
    const r = await gw.fsRead('app', 'probe/sub/hello.txt');
    return decodeUtf8(r.bytes);
  });
  await check('stat', async () => {
    const r = await gw.fsStat('app', 'probe/sub/hello.txt');
    return `${r.kind} size=${r.size}`;
  });
  await check('list', async () => {
    const r = await gw.fsList('app', 'probe/sub');
    return r.entries.map((e) => `${e.name}:${e.kind}`).join(',');
  });
  await check('rename', async () => {
    await gw.fsRename('app', 'probe/sub/hello.txt', 'probe/sub/moved.txt');
    const r = await gw.fsList('app', 'probe/sub');
    return r.entries.map((e) => e.name).join(',');
  });
  await check('statDir', async () => {
    const r = await gw.fsStat('app', 'probe/sub');
    return r.kind;
  });
  await check('remove', async () => {
    await gw.fsRemove('app', 'probe/sub', { recursive: true });
    return 'removed';
  });
  await check('statAfterRemove', async () => {
    const r = await gw.fsStat('app', 'probe/sub');
    return `still there: ${r.kind}`;
  });
  out.stage = 'done';
  log.debug('fs primitives probe', out);
};

const main = async () => {
  log.debug('main begin', {});
  const cfg = await take('runtime.config');
  const route = resolveLlmRoute(cfg);

  const ctx = await bootPhase(cfg, route);
  await probeFsPrimitives();
  await awaitAgent(ctx);
  installTurnEvidence(ctx, route);
  installRuntimeHalf(ctx, cfg, route);
  log.debug('b4 runtime resident (write surface live; awaiting the page)', {});
};

main().catch(fail);
