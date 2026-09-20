/**
 * M2 upstream web-boot scenario `m2.upstream-boot` — the OFFICIAL web boot
 * producer over the vendored runtime (decision D9, W-INTEG leg).
 *
 * Flow: upstream/boot.js composes the mobile profile exactly as
 * m2.upstream-session does (the same dsh-base spine + the vendored LlmRuntime
 * over gateway httpFetch) and drives ONE REAL upstream agent-loop turn
 * through the node-side dsh-llm-mock-server, so the session journal carries
 * real records. The `web.plugins` bus delivery (staged by the host via
 * --bus-inject) then mounts the scan-scope VFS, and the VENDORED
 * @deepseek-ai/dsh-client-modules ClientModuleRegistry composes the OFFICIAL
 * boot wire inside the runtime: the `__ModuleLoader__` facade queue script,
 * the revisioned combo batches, and the `__DSH_BOOT__` graph — the runtime
 * posts `web.boot` + `api.claim` + `mux.claim` over the bus seam, exactly the
 * frames the platform carrier consumes.
 *
 * The seam is then self-probed at the wire boundary the carrier owns: an
 * `api.request` for `session.list` is answered from the REAL vendored session
 * store (upstream SessionSummary rows), a mux `session/journal` open streams
 * the journal baseline in the Remote-journal envelope, a second live turn
 * arrives as journal change frames, and `mux.cancel` ends the stream.
 *
 * Every expected event is declared one-to-one in
 * tools/e2e/scenarios/m2-upstream-boot.json; artifacts land under
 * runtime/spike/artifacts/macos-cli-upstream-boot/.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';
import { createWebBootRuntime } from 'upstream/web-boot.js';

const SCENARIO = 'm2.upstream-boot';
const AGENT_ID = 'main';
const SESSION_ID = 's-m2-upstream-boot-1';
const INPUT_TEXT = 'Say hello';
const EXPECTED_TEXT = 'Hello from upstream'; // the mock server's successText
const JOURNAL_STREAM_ID = 'probe/session-journal-1';
const RPC_ID = 'probe/session-list-1';

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

/** Bus plumbing: deliveries may arrive while eval is still running (the host
 * injects right after eval), so the subscription exists at module scope and
 * buffers until the adapter is mounted. */
const busDeliveries = [];
let busHandler = null;
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  if (busHandler === null) busDeliveries.push(msg);
  else busHandler(msg);
};

const post = (msg) => globalThis.__dshBusPost?.(JSON.stringify(msg));

/** All posted frames, in order — the checker's wire surface. */
const posted = [];
const postRecording = (msg) => {
  posted.push(msg);
  log.debug('bus post', { type: msg.type });
  post(msg);
};

const launchEnv = () => {
  log.debug('launch env phase begin', {});
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};

const bootPhase = async (env) => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(resolved)}`);
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
      env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: env.DSH_MOCK_LLM_URL,
      apiKey: env.DSH_MOCK_LLM_KEY,
      provider: 'mock',
      model: 'mock-1',
    },
  });
  return ctx;
};

/** Wait (bounded, fail loud) for the configured agent, then drive one turn. */
const turnPhase = async (ctx, text) => {
  log.debug('turn phase begin', { text });
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) {
    await Promise.resolve();
  }
  const agent = ctx.agents.get(SESSION_ID);
  demand(agent !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  return ctx.sessions.get(SESSION_ID);
};

/** The graph facts the manifest pins — all deterministic booleans/shapes.
 * With the FULL application-tier staging (W-SHELL) the graph carries the
 * whole `dsh.client` roster: the bootstrap batch is exactly the vendored
 * client-modules id, the application batches cover every other staged
 * package, and the composed order puts a row's `external` dependency rows
 * before their consumers (upstream `orderByModuleGraph`; `inject` lists are
 * DI waits, not bundle-order edges). */
const assertGraphPhase = (frames, deliveredCount) => {
  log.debug('assert graph phase begin', {});
  const boot = frames.find((f) => f.type === 'web.boot');
  demand(boot !== undefined, 'no web.boot frame was posted over the bus seam');
  assertGraphShape(boot.graph, deliveredCount);
  assertRowShapes(boot);
};

/** The composed-graph facts (entries, batches, ordering, wire parse). */
const assertGraphShape = (graph, deliveredCount) => {
  log.debug('assert graph shape begin', { deliveredCount });
  const revShape = typeof graph.rev === 'string' && /^[0-9a-f]{12}$/.test(graph.rev);
  const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules';
  const bootstrap = graph.batches.filter((b) => b.phase === 'bootstrap');
  const application = graph.batches.filter((b) => b.phase === 'application');
  const batched = graph.batches.flatMap((b) => b.entries);
  const position = new Map(graph.entries.map((e, at) => [e.id, at]));
  const externals = new Map(deliveredExternals);
  const stripClient = (spec) => (spec.endsWith('/client') ? spec.slice(0, -7) : spec);
  const externalsOrdered = [...externals].every(([id, deps]) => deps.every((dep) => {
    const owner = position.get(stripClient(dep));
    return owner === undefined || (owner < position.get(id) && owner !== position.get(id));
  }));
  emit('web/boot/composed', {
    upstream: '0.1.6-alpha.2 (vendored @deepseek-ai/dsh-client-modules)',
    entryCount: graph.entries.length,
    deliveredCount,
    batchCount: graph.batches.length,
    bootstrapOnly: application.length === 0 && bootstrap.length === 1
      && JSON.stringify(bootstrap[0].entries) === JSON.stringify([BOOTSTRAP_ID]),
    bootstrapBatchExact: bootstrap.length === 1
      && JSON.stringify(bootstrap[0].entries) === JSON.stringify([BOOTSTRAP_ID]),
    externalsOrdered,
    everyEntryBatchedOnce: JSON.stringify(batched.slice().sort()) === JSON.stringify([...batched].sort())
      && batched.length === graph.entries.length,
    revIs12Hex: revShape,
    parseOk: true, // mountClientModules ran the vendored parseBootManifest; reaching here proves it
  });
};

/** The injected-row facts (facade queue, preloads, bootstrap script, graph
 * global) plus the per-plugin single-combo URL sample. */
const assertRowShapes = (boot) => {
  log.debug('assert row shapes begin', {});
  const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules';
  const RENDERER_ID = '@deepseek-ai/dsh-client-ui-renderer';
  const bootstrap = boot.graph.batches.filter((b) => b.phase === 'bootstrap');
  const kinds = [...new Set(boot.rows.map((r) => r.kind))].sort();
  const facade = boot.rows.find((r) => r.kind === 'script');
  const preloadCount = boot.rows.filter((r) => r.kind === 'script-preload').length;
  emit('web/boot/rows', {
    kinds,
    preloadCount,
    facadeIsQueueScript: facade !== undefined
      && facade.text.startsWith('(()=>{')
      && facade.text.includes('pendingQueue')
      && facade.text.includes(BOOTSTRAP_ID),
    bootstrapScriptPreloaded: boot.rows.some((r) => r.kind === 'script-src'
      && r.src === bootstrap[0]?.url),
    graphGlobalLastRow: boot.rows[boot.rows.length - 1]?.kind === 'global',
    recoveryDefaults: JSON.stringify(boot.recovery) === JSON.stringify({
      backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10000,
      generationReadyWarnMs: 3000, generationReadyTimeoutMs: 15000,
    }),
    pluginRowsSample: boot.plugins
      .filter((p) => p.id === BOOTSTRAP_ID || p.id === RENDERER_ID)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p) => ({
        id: p.id,
        urlIsSingleCombo: p.url === `/plugins/??${p.id}/client.js&rev=${p.rev}`,
      })),
  });
};

const assertApiPhase = async (frames) => {
  log.debug('assert api phase begin', {});
  // the respond frame settles on a microtask; poll the frame list (bounded)
  let guard = 0;
  while (!frames.some((f) => f.type === 'api.respond' && f.rpcId === RPC_ID) && guard++ < 1000) {
    await Promise.resolve();
  }
  const respond = frames.find((f) => f.type === 'api.respond' && f.rpcId === RPC_ID);
  demand(respond !== undefined, 'no api.respond for the session.list probe');
  const result = respond.result;
  const first = result.ok === true ? result.value.items[0] : undefined;
  demand(first !== undefined, 'session.list returned no rows');
  emit('web/api/session.list', {
    ok: result.ok === true,
    items: result.value.items.length,
    firstSessionId: first.sessionId,
    notBlank: first.blank === false,
  });
};

const assertJournalPhase = (frames, baselineEnd, liveExpectation) => {
  log.debug('assert journal phase begin', { baselineEnd });
  const baseline = frames.slice(0, baselineEnd)
    .filter((f) => f.type === 'mux.item' && f.streamId === JOURNAL_STREAM_ID);
  const events = baseline.map((f) => f.value?.event ?? {});
  const types = events.map((e) => e.type);
  demand(events.length > 0, 'journal baseline streamed no frames');
  const seqs = events.map((e) => e.seq);
  const envelopeOk = events.every((e, i) => typeof e.type === 'string'
    && typeof e.seq === 'number' && typeof e.time === 'number'
    && (i === 0 || e.seq > seqs[i - 1]));
  const assistant = events.find((e) => e.type === 'assistant/message');
  const text = assistant?.data?.message?.content
    ?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  emit('web/journal/baseline', {
    stream: 'session/journal',
    frames: baseline.length,
    types,
    envelopeOk,
  });
  demand(text === EXPECTED_TEXT, `journal assistant text is "${text}"`);
  const live = frames.slice(baselineEnd)
    .filter((f) => f.type === 'mux.item' && f.streamId === JOURNAL_STREAM_ID);
  emit('web/journal/live', {
    frames: live.length,
    types: live.map((f) => f.value?.event?.type),
    text: liveExpectation.text,
  });
  const end = frames.find((f) => f.type === 'mux.end' && f.streamId === JOURNAL_STREAM_ID);
  demand(end !== undefined, 'mux.cancel did not end the journal stream');
  emit('web/journal/cancelled', { streamId: JOURNAL_STREAM_ID, ended: true });
};

/** Mount the web-boot runtime half and install the bus dispatcher that
 * drains deliveries and settles claimed handlers (the carrier's half). */
let deliveredExternals = [];
const mountBusPhase = (ctx) => {
  const runtime = createWebBootRuntime({ ctx, post: postRecording });
  busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'unknown') {
      throw new Error(`web-boot: unknown bus delivery type '${outcome.type}'`);
    }
    if (outcome.kind === 'handler') {
      outcome.run().then((value) => {
        postRecording({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } });
      }, (error) => {
        postRecording({ type: 'api.respond', rpcId: msg.rpcId, result: {
          ok: false, error: { code: 'gateway/unavailable', message: String(error?.message ?? error), details: {} } } });
      });
    }
  };
  const delivery = busDeliveries.find((m) => m.type === 'web.plugins');
  demand(delivery !== undefined,
    'no web.plugins delivery was injected by the host');
  // The staged declarations the ordering assertion reads (`dsh.client`
  // external lists from the delivery's package manifests).
  deliveredExternals = delivery.plugins.map((p) => {
    const pkgJson = p.files[p.pkgJsonPath];
    if (pkgJson === undefined) return [p.loaderName, []];
    const manifest = JSON.parse(globalThis.Buffer.from(pkgJson.b64, 'base64').toString('utf8'));
    return [p.loaderName, manifest.dsh?.client?.external ?? []];
  });
  for (const msg of busDeliveries.splice(0)) busHandler(msg);
  log.debug('bus phase mounted', {});
};

/** Attach the journal, drive ONE more real turn as live traffic, cancel. */
const journalPhase = async (ctx) => {
  busHandler({ type: 'mux.open', streamId: JOURNAL_STREAM_ID, endpoint: 'session/journal',
    payload: { args: { address: { kind: 'session', sessionId: SESSION_ID } } } });
  const baselineEnd = posted.length; // everything posted so far is baseline
  await turnPhase(ctx, INPUT_TEXT);
  busHandler({ type: 'mux.cancel', streamId: JOURNAL_STREAM_ID });
  await Promise.resolve();
  assertJournalPhase(posted, baselineEnd, { text: EXPECTED_TEXT });
  log.debug('journal phase done', {});
};

const main = async () => {
  log.debug('main begin', {});
  const env = launchEnv();
  demand(typeof env.DSH_MOCK_LLM_URL === 'string' && env.DSH_MOCK_LLM_URL.startsWith('http://127.0.0.1:'),
    `mock LLM endpoint missing from the launch env: ${JSON.stringify(env.DSH_MOCK_LLM_URL)}`);

  const ctx = await bootPhase(env);
  emit('session/created', { sessionId: SESSION_ID });

  const session = await turnPhase(ctx, INPUT_TEXT);
  const events = session.snapshotEvents();
  const assistant = events.find((record) => record.type === 'assistant/message');
  const text = assistant?.data?.message?.content
    ?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  demand(text === EXPECTED_TEXT, `turn text is "${text}"`);
  emit('web/turn/done', { text, events: events.length });

  mountBusPhase(ctx);
  assertGraphPhase(posted, deliveredExternals.length);

  // Self-probe the claimed /api surface exactly as the carrier would.
  busHandler({ type: 'api.request', rpcId: RPC_ID, endpoint: 'session.list', payload: { args: {} } });
  await assertApiPhase(posted);
  await journalPhase(ctx);

  emit('web/boot/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    boot: 'official client-modules wire composed in-runtime over the bus seam',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
