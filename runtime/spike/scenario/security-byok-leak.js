// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * Scenario `security.byok-leak` — the BYOK credential's leak surface,
 * attacked (threat model: docs/security-threat-model.md, surface "BYOK
 * credential flow"). A CANARY credential — a value that must never appear
 * outside the keychain and the wire — is driven through every runtime face
 * a key touches:
 *
 *   1. the save (keychainSet under the frozen `dsh.llm/byok-route` ref) and
 *      the read-back roundtrip — byte-equal, ref-only events;
 *   2. the RELAUNCH route resolution (upstream/llm-route.js — the one home
 *      of route resolution): the resolved route CARRIES the canary in
 *      memory (that is its job) and the emitted event carries only
 *      kind/provider — the route fact is loggable, the key is not;
 *   3. one REAL turn over the gateway httpFetch transport (the canary rides
 *      the Authorization header — wire-only by contract, llm.js "the API
 *      key NEVER enters a log line");
 *   4. the AUTH-FAILURE face: a 401 scripted by the vendored mock, driven
 *      with the canary key AND a separate wrong-key probe value — the
 *      error's message is asserted IN RUNTIME to carry neither value (an
 *      error face that echoed a credential would be the leak).
 *
 * The runtime assertions above are the in-memory half; the RUNNER greps the
 * RAW captured log (stdout + stderr + audit stream) for BOTH values — the
 * #280 key-audit discipline — after first proving its matcher fires on a
 * seeded line (a grep that cannot match is an audit that cannot catch).
 * A leak here is a HIGH finding, reported not absorbed.
 */
import 'upstream/shims/globals.js';
import { createLogger } from 'logger.js';
import { keychainSet, keychainGet, httpFetch } from 'gateway.js';
import { resolveLlmRoute, BYOK_REF, encodeCredential } from 'upstream/llm-route.js';
import { streamChat } from 'llm.js';

const SCENARIO = 'security.byok-leak';
const log = createLogger('security.byok');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason: String(reason).slice(0, 200) });
  emit('scenario.failed', { reason: String(reason).slice(0, 300) });
  globalThis.__dshComplete(false, String(reason).slice(0, 300));
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

const rawEnv = globalThis.__dshLaunchEnv?.();
demand(typeof rawEnv === 'string', 'launch env snapshot missing (CLI must pass --env)');
const ENV = JSON.parse(rawEnv);
const MOCK_URL = ENV.DSH_MOCK_LLM_URL;
const CANARY = ENV.DSH_BYOK_CANARY;
const WRONG_KEY = ENV.DSH_BYOK_WRONG;
demand(typeof MOCK_URL === 'string' && MOCK_URL.startsWith('http://127.0.0.1:'),
  'mock endpoint missing from the launch env');
demand(typeof CANARY === 'string' && CANARY.length >= 16 && !CANARY.includes("'"),
  'canary missing from the launch env');
demand(typeof WRONG_KEY === 'string' && WRONG_KEY.length >= 16,
  'wrong-key probe missing from the launch env');

const bytesEqual = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

const CREDENTIAL = {
  provider: 'deepseek', baseURL: MOCK_URL, apiKey: CANARY, model: 'mock-1',
};

const turn = (route) => streamChat({
  fetchImpl: httpFetch,
  baseUrl: route.baseURL,
  apiKey: route.apiKey,
  model: route.model,
  messages: [{ role: 'user', content: 'answer with one short line' }],
  maxTokens: 24,
  on: (name, fields) => log.debug('stream step', { name, ...fields }),
});

const main = async () => {
  if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
    fail('gateway negotiation failed');
    return;
  }
  await savePhase();
  const route = await routePhase();
  await turnPhase(route);
  await authPhase(route);
  await cleanupPhase();
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
};

/** 1. the save: the frozen keychain primitive, the frozen ref. The event
 *    carries the REF, never the value. */
const savePhase = async () => {
  await keychainSet(BYOK_REF, encodeCredential(CREDENTIAL));
  emit('leak.saved', { ref: BYOK_REF });
  const stored = await keychainGet(BYOK_REF);
  demand(stored !== null, 'the keychain lost the credential immediately');
  const roundtrip = bytesEqual(stored.secret, encodeCredential(CREDENTIAL));
  demand(roundtrip, 'the keychain roundtrip drifted');
  emit('leak.keychain.roundtrip', { match: true });
};

/** 2. the relaunch resolution: no staged credential in the config → byok.
 *    The route carries the canary IN MEMORY; the event carries the kind. */
const routePhase = async () => {
  const route = await resolveLlmRoute({});
  demand(route.kind === 'byok', `route resolution ignored the credential: ${route.kind}`);
  demand(route.apiKey === CANARY, 'the resolved route lost the credential');
  emit('leak.route.resolved', { route: route.kind, provider: route.provider });
  return route;
};

/** 3. one real turn: the canary rides the Authorization header — wire-only. */
const turnPhase = async (route) => {
  const done = await turn(route);
  demand(typeof done?.text === 'string' && done.text.length > 0,
    'the byok turn produced nothing');
  emit('leak.turn.completed', { chars: done.text.length, deltas: done.deltas });
};

/** 4. the auth-failure face: the mock scripts the 401; the error message
 *    must carry neither credential value. */
const authPhase = async (route) => {
  let authError = null;
  try {
    await turn({ ...route, apiKey: WRONG_KEY });
  } catch (err) {
    authError = err;
  }
  demand(authError !== null, 'the 401 leg did not reject');
  const message = String(authError.message ?? '');
  demand(!message.includes(CANARY) && !message.includes(WRONG_KEY),
    'the auth-error message echoed a credential value');
  emit('leak.auth-error.redacted', {
    code: authError.code ?? 'unknown', keyInMessage: false, chars: message.length,
  });
};

/** cleanup: the ref is cleared so the dev host's tmpdir carries no canary. */
const cleanupPhase = async () => {
  await keychainSet(BYOK_REF, null);
  const gone = await keychainGet(BYOK_REF);
  demand(gone === null, 'the cleanup did not clear the ref');
  emit('leak.cleanup', { cleared: true });
};

await main();
