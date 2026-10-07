/**
 * M2 real-LLM scenario `llm.live-stream` — one streaming chat turn against an
 * OpenAI-compatible backend THROUGH the gateway, closing the "mock LLM"
 * gap the session.mock-llm scenario left open. The scenario is 100%
 * platform-neutral; the LEG is negotiated from the RuntimeDescriptor
 * (capability negotiation, never a hostType branch):
 *
 *   - descriptor offers `httpFetch` (iOS / Android carriers) → REAL leg:
 *     the turn streams from the configured backend. Credentials come from
 *     `llm-live-stream/config.json` in fs scope "app" ({baseUrl, apiKey, model} —
 *     written by the E2E runner before launch; MISSING config fails loud,
 *     rule 5). The served model name is logged as the server reports it
 *     (it may differ from the requested one).
 *   - descriptor declares `httpFetch` unavailable (the desktop CLI smoke
 *     backend) → SCRIPTED leg: a scripted SSE transport (the install-fetch
 *     stub's production twin) feeds the SAME client code path — partial
 *     lines, odd chunk boundaries, a reasoning delta before the content
 *     deltas — with a NON-SECRET fixture key, so the key-leak audit itself
 *     is under test in CI.
 *
 * Event shapes are the session.mock-llm vocabulary, byte-for-byte: agent.started,
 * llm.stream.started, llm.delta {index, text}, llm.stream.completed — plus
 * llm.reasoning.delta for reasoning_content and leg/config/audit evidence
 * events. The API key NEVER enters a log line: every log-sink line is
 * audited for the active key string (the leg's real key, or the fixture
 * key on the scripted leg) and a leak fails the scenario (rule 5); the
 * runners re-check the captured platform log out of band.
 *
 * Expected events, in order, live in tools/e2e/scenarios/llm-live-stream.json
 * (scripted leg) / llm-live-stream-device.json (real leg, delta-count-agnostic via
 * the checker's repeat expectations); carrier-side evidence rides scenario
 * `llm.live-stream.carrier` (llm-live-stream-carrier.json).
 */
import { createLogger } from 'logger.js';
import { fsRead, httpFetch, onEvent } from 'gateway.js';
import { streamChat, utf8Decode, utf8Encode } from 'llm.js';

const SCENARIO = 'llm.live-stream';
const CONFIG_PATH = 'llm-live-stream/config.json';
const SESSION_ID = 's-llm-live-stream-0001';
const PROMPT = 'Reply with a two-sentence greeting and nothing else.';
const SCRIPT_KEY = 'sk-scripted-fixture-key-not-a-secret';
const SCRIPT_BASE = 'scripted://llm-live-stream';
const SCRIPT_MODEL = 'scripted';
const SCRIPT_SERVED = 'scripted-fixture';
const THINKING = 'Pondering the greeting.';
const GREETING = ['Hello', ' from', ' the', ' real', ' LLM', ' backend.'];
const EXPECTED_TEXT = GREETING.join('');
const CHUNK_SIZES = [9, 23, 5, 61, 17]; // odd byte boundaries — partial lines by design

const log = createLogger('llm.live-stream.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/* Key-leak audit: sits ON the log sink from the first scenario line and
 * counts every line carrying the audited secret. Assigned straight to the
 * global (no `const`), and LOGGING INSIDE WOULD RECURSE — the wrapper is
 * deliberately silent; `leaked` is demanded at the end. */
const audit = { secret: '', lines: 0, leaked: false };
const rawSink = globalThis.__DSH_LOG_SINK__;
globalThis.__DSH_LOG_SINK__ = (line) => {
  audit.lines += 1;
  if (audit.secret && line.indexOf(audit.secret) >= 0) audit.leaked = true;
  rawSink?.(line);
};

/* Announce the bus subscription: the Android carrier host gates the Web
 * Client page load on this line (its host.hello carries the loopback port);
 * hosts without a bus sink (CLI, iOS session flow) drop it silently. */
globalThis.__dshBusPost?.(JSON.stringify({ type: 'bus.ready' }));

/* Bridge events arrive in host order; consumed by name, buffered meanwhile
 * (the session-mock-llm pattern). */
const buffered = [];
const waiters = [];
onEvent((ev) => {
  const wake = waiters.shift();
  if (wake) wake(ev);
  else buffered.push(ev);
});
const nextEvent = async (name) => {
  log.debug('wait for event', { name });
  for (;;) {
    const at = buffered.findIndex((ev) => ev.event === name);
    if (at >= 0) return buffered.splice(at, 1)[0];
    const ev = await new Promise((resolve) => waiters.push(resolve));
    buffered.push(ev);
  }
};

/** The leg the descriptor negotiates: hosts offering httpFetch run the real
 * backend; hosts honestly declaring it unavailable (the CLI smoke backend)
 * get the scripted transport through the same client code. */
const descriptorLeg = () => {
  log.debug('descriptor leg probe');
  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor?.() ?? 'null');
  const available = descriptor?.available ?? [];
  return available.indexOf('httpFetch') >= 0 ? 'real' : 'scripted';
};

/** One SSE chunk line of the scripted stream (expression-bodied on purpose:
 * the logging gate exempts single-expression arrows and this is pure data). */
const sseChunk = (delta, finish) => 'data: ' + JSON.stringify({
  id: 'chatcmpl-scripted', model: SCRIPT_SERVED,
  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
}) + '\n\n';

/** The scripted stream: reasoning delta FIRST (this backend's shape), then
 * the content deltas, then finish_reason stop + [DONE]. */
const buildScriptedSse = () => {
  log.debug('scripted sse build', { deltas: GREETING.length + 1 });
  let out = sseChunk({ role: 'assistant', reasoning_content: THINKING });
  for (const piece of GREETING) out += sseChunk({ content: piece });
  return out + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
};

/** Splits bytes at deliberately odd boundaries (mid-line, mid-JSON) so the
 * parser's tolerance to partial lines is under test, not just well-framed
 * chunks. */
const splitBytes = (bytes) => {
  log.debug('scripted chunking', { bytes: bytes.length, sizes: CHUNK_SIZES.length });
  const chunks = [];
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const n = CHUNK_SIZES[i % CHUNK_SIZES.length];
    chunks.push(bytes.subarray(at, Math.min(at + n, bytes.length)));
    at += n;
    i += 1;
  }
  return chunks;
};

/** Yields one scripted chunk per runtime-queue tick (D8) — the m3 stub's
 * iterator, feeding raw SSE bytes instead of a file body. */
const chunkIterator = (chunks) => {
  let next = 0;
  return {
    next: async () => {
      await null; // each chunk settles on its own runtime-queue tick (D8)
      log.debug('scripted chunk yield', { index: next });
      return next < chunks.length
        ? { value: chunks[next++], done: false }
        : { value: undefined, done: true };
    },
  };
};

/** The SCRIPTED transport: exact gateway httpFetch response shape, status +
 * streaming AsyncIterable body + abort. */
const scriptedFetch = async (url) => {
  log.debug('scripted fetch', { url });
  const chunks = splitBytes(utf8Encode(buildScriptedSse()));
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: { [Symbol.asyncIterator]: () => chunkIterator(chunks) },
    abort: () => { log.debug('scripted abort (no-op)'); },
  };
};

/** REAL-leg credentials from fs scope "app" — written by the E2E runner.
 * Anything missing/malformed fails loud with the offending field (rule 5);
 * the key is armed into the audit, never logged. */
const loadRealConfig = async () => {
  log.debug('real config load begin', { path: CONFIG_PATH });
  const { bytes } = await fsRead('app', CONFIG_PATH);
  const config = JSON.parse(utf8Decode(bytes));
  demand(typeof config.baseUrl === 'string' && config.baseUrl.indexOf('https://') === 0,
    `config.baseUrl must be an https URL (${CONFIG_PATH})`);
  demand(typeof config.apiKey === 'string' && config.apiKey.length >= 20,
    `config.apiKey missing or implausibly short (${CONFIG_PATH})`);
  demand(typeof config.model === 'string' && config.model.length > 0,
    `config.model missing (${CONFIG_PATH})`);
  audit.secret = config.apiKey;
  return { source: 'app-scope', baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model };
};

/** One streamed turn (D8): emits stream.started / per-delta events /
 * stream.completed, projects content deltas into the mounted Web Client,
 * and returns the stream result for the leg's assertions. */
const runTurn = async (config) => {
  log.debug('turn begin', { model: config.model });
  emit('llm.stream.started', { turn: 1 });
  const result = await streamChat({
    fetchImpl: config.source === 'app-scope' ? httpFetch : scriptedFetch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    messages: [{ role: 'user', content: PROMPT }],
    maxTokens: config.source === 'app-scope' ? 256 : 64,
    on: (name, fields) => {
      if (name === 'reasoning') emit('llm.reasoning.delta', { index: fields.index, text: fields.text });
      if (name === 'delta') {
        emit('llm.delta', { index: fields.index, text: fields.text });
        project({ kind: 'token-delta', index: fields.index, text: fields.text });
      }
    },
  });
  demand(result.deltas >= 1, `no content deltas streamed (finish ${result.finishReason})`);
  demand(result.text.length > 0, 'aggregated assistant text is empty');
  emit('llm.stream.completed', {
    turn: 1, deltas: result.deltas, reasoningDeltas: result.reasoningDeltas,
    chars: result.text.length, finishReason: result.finishReason,
  });
  emit('llm.served-model', { requested: config.model, served: result.served });
  return result;
};

const main = async () => {
  log.debug('main begin');
  project({ kind: 'slot.register', id: 'notes.toolbar', label: 'llm', by: 'llm-live-stream' });
  await nextEvent('host.info');
  emit('host.ready', { signalled: true });

  const leg = descriptorLeg();
  emit('llm.leg', { leg, transport: leg === 'real' ? 'gateway.httpFetch' : 'scripted-sse' });
  const config = leg === 'real'
    ? await loadRealConfig()
    : { source: 'scripted-fixture', baseUrl: SCRIPT_BASE, apiKey: SCRIPT_KEY, model: SCRIPT_MODEL };
  emit('llm.config.loaded', { source: config.source, model: config.model });
  if (leg === 'scripted') audit.secret = SCRIPT_KEY;

  emit('session.created', { sessionId: SESSION_ID, scope: 'app' });
  project({ kind: 'session', id: SESSION_ID, scope: 'app' });
  emit('agent.started', { model: config.model, tools: 0 });
  project({ kind: 'agent', model: config.model, tools: 0 });

  const result = await runTurn(config);
  if (leg === 'scripted') {
    demand(result.text === EXPECTED_TEXT, `aggregated text drifted: "${result.text}"`);
    demand(result.deltas === GREETING.length, `delta count drifted: ${result.deltas}`);
    demand(result.reasoningDeltas === 1, 'reasoning delta count drifted');
    demand(result.served === SCRIPT_SERVED, `served model drifted: ${result.served}`);
  } else {
    demand(typeof result.served === 'string' && result.served.length > 0,
      'server reported no model name');
  }
  emit('llm.content.asserted', { text: result.text, chars: result.text.length });
  demand(!audit.leaked, 'THE API KEY APPEARED IN THE LOG STREAM');
  emit('llm.key.audit', { lines: audit.lines, leaked: false });
  emit('session.completed', {
    sessionId: SESSION_ID, status: 'pass', deltas: result.deltas, chars: result.text.length,
  });
  project({
    kind: 'complete', status: 'pass', deltas: result.deltas, chars: result.text.length,
  });
  globalThis.__dshComplete(true, 'ok');
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });
  // An uncaught rejection would otherwise die silently between pumps —
  // route every failure through the scenario verdict (fail loud, rule 5).
  await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
}
