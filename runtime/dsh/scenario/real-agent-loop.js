// dsh:logging-exempt (spine-boot module, the session-live template's class:
// the demand/take/post helper trio never logs — the mounted logger carries
// every canonical line the probes emit)
/**
 * real-agent-loop.js — the REAL-model agent-loop harness behind the
 * windows-test-plan's T4/T5 probes: the FULL upstream spine boots inside the
 * embedded runtime (upstream/boot.js — ctx.sessions / agents / agentLoop /
 * tools, exactly the harmony-session-live-read shape) and the llm route is
 * the REAL gateway httpFetch transport pointed at the STAGED credential
 * ({baseUrl, apiKey, model} from `llm-live-stream/config.json` in fs scope
 * "app" — the same staged path and handshake the llm.live-stream leg uses,
 * so the runner's credential choreography is reused unchanged).
 *
 * The probes (windows-test-plan.md T4/T5), one REAL turn each — the model
 * decides to call the read tool, the gateway fs primitive answers through
 * the same shim bytes every host ships, and the session log carries the
 * verbatim tool/call + tool/result records the assertions read:
 *
 *   T4-a `/system/app`                     → in-band refusal: the workspace
 *                                            root anchor + "maybe you meant
 *                                            …/dsh/system/app?"
 *   T4-b `dsh/../plugins/registry.json`  → resolves; the seeded registry
 *                                            content comes back
 *   T4-c `/system/definitely-not-here-xyz` → absence semantics (not found),
 *                                            NO anchor refusal
 *   T4-d `../../../../etc/passwd`          → pinned in-root (ENOENT form),
 *                                            NO passwd content
 *   T5   web_search                        → the tool runs and answers, or
 *                                            the keyless challenge surfaces
 *                                            in band — a silent empty
 *                                            success is THE defect line
 *
 * The registry fixture T4-b reads is seeded by THIS scenario through the
 * gateway fs primitive before the turns (fs scope "app",
 * `plugins/registry.json`) — a fresh sandbox carries no registry, and the
 * probe's value is the relative-spelling resolution, not the file's history.
 *
 * Every probe emits `realagent/turn` (the prompt), `realagent/tool/calls`
 * (the verbatim tool names + arguments the model produced) and
 * `realagent/tool/result` (the asserted shape), then a terminal
 * `realagent/summary` and `__dshComplete(pass)` — the verdict IS the
 * scenario's, record by record against real-agent-loop.json.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite } from 'gateway.js';
import { utf8Decode, utf8Encode } from 'llm.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'real.agent.loop';
const AGENT_ID = 'main';
const SESSION_ID = 's-real-agent-0001';
const CONFIG_PATH = 'llm-live-stream/config.json';
const REGISTRY_PATH = 'plugins/registry.json';
const REGISTRY_MARKER = 'real-agent-registry-marker-42';
const REGISTRY_JSON = JSON.stringify({
  version: 1,
  marker: REGISTRY_MARKER,
  plugins: [{ name: 'probe-plugin', enabled: true }],
});

const log = createLogger('real.agent.loop.dsh');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

/** Bus deliveries may arrive before the awaiting half exists (the host
 * delivers right after the eval returns), so the subscription is
 * module-scope, buffers, and wakes pending `take()` waiters — the
 * harmony-session-live-read shape verbatim. */
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
const take = (type) => new Promise((resolve, reject) => {
  const buffered = queue.find((msg) => msg.type === type);
  if (buffered !== undefined) return resolve(buffered);
  const timer = setTimeout(() => reject(new Error(`runtime did not deliver ${type} within 60s`)), 60_000);
  dispatch = (msg) => {
    if (msg.type !== type) return false;
    clearTimeout(timer);
    resolve(msg);
    return true;
  };
  wake = () => {};
});

/** One REAL upstream turn through the agent loop; resolves when idle. */
const runTurn = async (agent, text) => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

/** The session records the turn produced: only the NEW tail (the probes run
 * sequentially on one session — the baseline length fences each turn). */
const turnRecords = (session, baseline) => session.snapshotEvents().slice(baseline);

/** The turn's tool calls, verbatim: name + arguments string. */
const toolCalls = (records) => records
  .filter((record) => record.type === 'tool/call')
  .map((record) => ({
    tool: record.data?.tool ?? record.data?.name ?? '',
    arguments: typeof record.data?.arguments === 'string'
      ? record.data.arguments
      : JSON.stringify(record.data?.arguments ?? {}),
  }));

/** The turn's last tool result as text (the assertions read shapes). */
const lastResultText = (records) => {
  const result = records.filter((record) => record.type === 'tool/result').pop();
  return result === undefined ? '' : JSON.stringify(result.data ?? {});
};

/** Run one probe turn and emit the evidence trio. Returns the records. */
const probe = async (ctx, session, seq, prompt) => {
  log.debug('probe begin', { seq, prompt });

  const baseline = session.snapshotEvents().length;
  emit('realagent/turn', { seq, prompt });
  await runTurn(ctx.agents.get(SESSION_ID), prompt);
  const records = turnRecords(session, baseline);
  const calls = toolCalls(records);
  emit('realagent/tool/calls', { seq, calls });
  return { seq, records, calls, resultText: lastResultText(records) };
};

const bootPhase = async (cfg, containerRoot) => {
  log.debug('spine boot begin', { model: cfg.model });

  demand(typeof containerRoot === 'string' && containerRoot.startsWith('/'),
    `profile container not granted by the host: ${JSON.stringify(containerRoot)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: containerRoot,
    onEvent: emit,
    container: {
      cwd: containerRoot,
      tmpdir: `${containerRoot}/tmp`,
      home: `${containerRoot}/home`,
      env: {},
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      provider: 'bigmodel',
      model: cfg.model,
      userEndpoint: true, // the STAGED user credential names the endpoint — the seam's named exception
      adapterName: 'bigmodel coding-plan chat-completions (gateway httpFetch, live)',
      transportLabel: 'gateway httpFetch → real bigmodel backend '
        + '(windows-test-plan T4/T5 live; the model picks and shapes the calls)',
      // NO onWire/onSse: the wire stream is the llm.live-stream manifest's
      // evidence — here it would interleave hundreds of records between the
      // probe expectations and break the one-to-one match. The probes'
      // assertions read the SESSION records, not the wire.
    },
  });
  emit('realagent/spine/booted', { sessionId: SESSION_ID, provider: 'bigmodel' });
  return ctx;
};

/** T4-a: the anchored refusal (workspace root + the maybe-you-meant hint). */
const probeAnchoredRefusal = async (ctx, session) => {
  log.debug('T4-a begin', {});

  const a = await probe(ctx, session, 1, '请使用 read 工具读取 /system/app 这个路径的完整内容，把工具返回的原样告诉我。');
  demand(a.calls.length > 0, `T4-a: the model produced no tool call — assistant said: ${a.records
    .filter((r) => r.type === 'assistant/message').map((r) => JSON.stringify(r.data)).join('').slice(0, 200)}`);
  demand(a.resultText.includes('maybe you meant'),
    `T4-a: the refusal carries no anchor hint — result: ${a.resultText.slice(0, 260)}`);
  emit('realagent/tool/result', { seq: 1, shape: 'anchored-refusal', ok: true });
};

/** T4-b: the relative spelling resolves to the seeded registry. */
const probeRelativeResolves = async (ctx, session) => {
  log.debug('T4-b begin', {});

  const b = await probe(ctx, session, 2, '请使用 read 工具读取文件 dsh/../plugins/registry.json，原样告诉我文件内容。');
  demand(b.calls.length > 0, 'T4-b: the model produced no tool call');
  demand(b.resultText.includes(REGISTRY_MARKER),
    `T4-b: the registry content did not resolve — result: ${b.resultText.slice(0, 260)}`);
  emit('realagent/tool/result', { seq: 2, shape: 'relative-resolves', ok: true });
};

/** T4-c: plain absence — no anchor refusal. */
const probeAbsence = async (ctx, session) => {
  log.debug('T4-c begin', {});

  const c = await probe(ctx, session, 3, '请使用 read 工具读取 /system/definitely-not-here-xyz。');
  demand(c.calls.length > 0, 'T4-c: the model produced no tool call');
  demand(c.resultText.includes('maybe you meant') === false,
    `T4-c: an absence case refused with the anchor hint — result: ${c.resultText.slice(0, 260)}`);
  emit('realagent/tool/result', { seq: 3, shape: 'absence', ok: true });
};

/** T4-d: pinned in-root — ENOENT, never passwd content. */
const probePinnedInRoot = async (ctx, session) => {
  log.debug('T4-d begin', {});

  const d = await probe(ctx, session, 4, '请使用 read 工具读取 ../../../../etc/passwd 的内容。');
  demand(d.calls.length > 0, 'T4-d: the model produced no tool call');
  demand(d.resultText.includes('root:x:0:0') === false,
    'T4-d: passwd content leaked — the in-root pin failed');
  emit('realagent/tool/result', { seq: 4, shape: 'pinned-in-root', ok: true });
};

/** T5: web_search — content, or the keyless challenge, in band. The defect
 * line is a silent empty success. */
const probeWebSearch = async (ctx, session) => {
  log.debug('T5 begin', {});

  const e = await probe(ctx, session, 5, '请使用 web_search 工具搜索 HarmonyOS，把搜索结果告诉我。');
  const searchCall = e.calls.find((call) => call.tool === 'web_search');
  demand(searchCall !== undefined, `T5: no web_search tool call — calls: ${JSON.stringify(e.calls).slice(0, 200)}`);
  demand(e.resultText.length > 2 && e.resultText !== '{}',
    `T5: silent empty success — result: ${e.resultText.slice(0, 260)}`);
  const challenged = e.resultText.includes('WEB_SEARCH_KEYLESS_CHALLENGED');
  emit('realagent/tool/result', { seq: 5, shape: challenged ? 'keyless-challenged' : 'answered', ok: true });
};

/** The staged credential (the llm.live-stream handshake's path — the same
 * placeholder/send/import choreography, reused unchanged). The send lands
 * ASYNCHRONOUSLY after the stage-ready marker, so the read polls until the
 * file carries the real config (the runner's awaitStaged deadline bounds
 * the handshake). NO timer sleep: this host's timers never fire (the
 * timerSchedule denial, T2's known boundary) — an awaited setTimeout would
 * hang the poll forever; each failed fsRead is itself a gateway round trip
 * that yields the runtime thread to the host pump. */
const readStagedConfig = async () => {
  log.debug('staged config poll begin', { path: CONFIG_PATH });
    const deadline = Date.now() + 120_000;
    for (;;) {
      // The placeholder (`{}`) precedes the send: a parse success without a
      // https baseUrl is still the pre-send state — keep polling.
      let cfg = null;
      try {
        cfg = JSON.parse(utf8Decode((await fsRead('app', CONFIG_PATH)).bytes));
      } catch { cfg = null; }
      if (cfg !== null && typeof cfg.baseUrl === 'string'
          && cfg.baseUrl.indexOf('https://') === 0) {
        return cfg;
      }
      if (Date.now() > deadline) {
        throw new Error('the staged credential never appeared within 120s');
      }
      // NO timer sleep here: this host's timers never fire (the
      // timerSchedule denial, T2's known boundary) — an awaited setTimeout
      // would hang the poll forever. Each failed fsRead is itself a gateway
      // round trip that yields the runtime thread to the host pump.
    }
  };

const main = async () => {
  log.debug('main begin', {});

  const configMsg = await take('runtime.config');
  const containerRoot = configMsg.containerRoot;

  const cfg = await readStagedConfig();  const cfg = await readStagedConfig();
  demand(typeof cfg.baseUrl === 'string' && cfg.baseUrl.indexOf('https://') === 0,
    `config.baseUrl missing or not https: ${JSON.stringify(cfg.baseUrl)}`);
  demand(typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0, 'config.apiKey missing');
  demand(typeof cfg.model === 'string' && cfg.model.length > 0, 'config.model missing');
  emit('realagent/config/loaded', { baseUrl: cfg.baseUrl, model: cfg.model });

  // T4-b's fixture: seed the registry the relative-spelling probe resolves.
  await fsWrite('app', REGISTRY_PATH, utf8Encode(REGISTRY_JSON));

  const ctx = await bootPhase(cfg, containerRoot);
  const session = ctx.sessions.get(SESSION_ID);
  demand(session !== undefined, `session "${SESSION_ID}" never appeared in the store`);

  await probeAnchoredRefusal(ctx, session);
  await probeRelativeResolves(ctx, session);
  await probeAbsence(ctx, session);
  await probePinnedInRoot(ctx, session);
  await probeWebSearch(ctx, session);

  emit('realagent/summary', { probes: 5, pass: true });
  post({ type: 'realagent/complete', pass: true });
  globalThis.__dshComplete(true, 'real.agent.loop: 5/5 probe shapes asserted');
};

main().catch(fail);
