// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-llm.js — the LLM + credential legs of the COVERAGE
 * plane (decision D9, api-full-coverage work stream): the 设置 → 模型 page
 * store's provider join (`llm/listProviders` × `llm/listConfigurableProviders`
 * × `credentials/describe`, measured on device 2026-09-24 — the unclaimed
 * trio left the page's generic unavailable banner up).
 *
 * Every handler answers from the real mount:
 *   - The provider directory IS the vendored LlmRuntime's own registry
 *     (`ctx.llm`) — the wire shapes are the service's own @Remote results,
 *     so the handlers forward, they do not reshape.
 *   - The credential store is a REAL ref→value file in the profile container
 *     (`profiles/default/llm/credentials.json`, the staged config's app
 *     scope) written through the gateway fs primitives. This supersedes the
 *     earlier `credentials/set stays unclaimed` stance (web-write.js, the
 *     shell-load comment): the page's configure/remove flow needs the write
 *     half, and a stored ref shadows the staged route value for describe.
 *     Values never cross the wire back — describe answers state facts only.
 *   - The desktop directory-opener gate answers the platform truth (this
 *     host has no desktop window), so the page hides the affordance instead
 *     of toasting.
 */
import { encodeUtf8, decodeUtf8 } from 'node:buffer';
import { fsRead, fsWrite } from '../gateway.js';

/** The store: one JSON object `{ref: value}` at the app scope ROOT — flat,
 * so every host that grants the v1.1.0 fs write primitives can hold it (the
 * minimal CLI smoke backend implements no mkdir; nesting the file beside the
 * staged config would need fsMkdir before the first write). Durable in the
 * profile container either way. */
const STORE_PATH = 'credentials.json';

/** The credential-ref grammar, @deepseek-ai/dsh-credentials REF_PATTERN. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** upstream settings-models deriveKeyRef: the profile's ref for one provider
 * route (`openai-compatible` → `OPENAI_COMPATIBLE_API_KEY`). Mirrored, not
 * imported — it lives in the page bundle, not a vendored lib. */
export const deriveKeyRef = (provider) =>
  `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

const badRequest = (message) => (
  { remote: true, code: 'gateway/bad-request', message, details: {} });
const unavailable = (message) => (
  { remote: true, code: 'gateway/unavailable', message, details: {} });

/** Read the store. An absent file is an empty store (nothing configured
 * through the wire yet); a file that fails to PARSE fails loud — rule 5, a
 * misconfiguration discovered late is a defect now. */
const readStore = async () => {
  let raw;
  try {
    raw = (await fsRead('app', STORE_PATH)).bytes;
  } catch {
    return {};
  }
  try {
    const store = JSON.parse(decodeUtf8(raw));
    if (store === null || typeof store !== 'object' || Array.isArray(store)) {
      throw new Error('the store is not a JSON object');
    }
    return store;
  } catch (error) {
    throw unavailable(`the credential store ${STORE_PATH} is unreadable: ${error.message}`);
  }
};

const writeStore = async (store) => {
  await fsWrite('app', STORE_PATH, encodeUtf8(`${JSON.stringify(store, null, 2)}\n`));
};

/** The provider directory legs: the mounted LlmRuntime's own answers, or a
 * loud RemoteError when no runtime is mounted (never a TypeError). */
const makeLlmHandlers = (ctx) => {
  const demandLlm = () => {
    if (ctx.get('llm') === undefined) {
      throw unavailable('no llm runtime is mounted on this spine');
    }
    return ctx.get('llm');
  };
  return {
    'llm/listProviders': async () => demandLlm().listProviders(),
    'llm/listConfigurableProviders': async () => demandLlm().listConfigurableProviders(),
  };
};

/** One describe row: a wire-configured ref reads from the store; the staged
 * route's ref names the staged credential; anything else is absent. */
const describeOne = (routeRef, ref, store) => {
  if (store[ref] !== undefined) return { configured: true, writable: true };
  if (ref === routeRef) {
    return {
      configured: true,
      source: 'staged profile credential (profiles/default/llm)',
      writable: true,
    };
  }
  return { configured: false, writable: true };
};

const demandRef = (ref, endpoint) => {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw badRequest(`${endpoint} ref must match ${REF_PATTERN}`);
  }
  return ref;
};

/** The credential READ leg (wire: describe → Record<ref, {configured,
 * source?, writable}>). Values never cross the wire back. */
const makeCredentialDescribeHandler = (llmRoute) => {
  const routeRef = deriveKeyRef(llmRoute.provider);
  return async (args) => {
    const refs = args?.refs;
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')) {
      throw badRequest('credentials/describe needs refs: string[]');
    }
    const store = await readStore();
    return Object.fromEntries(
      refs.map((ref) => [ref, describeOne(routeRef, ref, store)]));
  };
};

/** The credential WRITE legs (wire: set/unset → void). */
const makeCredentialWriteHandlers = () => ({
  'credentials/set': async (args) => {
    const ref = demandRef(args?.ref, 'credentials/set');
    const value = args?.value;
    if (typeof value !== 'string' || value.length === 0) {
      throw badRequest('credentials/set needs a non-empty string value');
    }
    const store = await readStore();
    store[ref] = value;
    await writeStore(store);
    return {};
  },
  'credentials/unset': async (args) => {
    const ref = demandRef(args?.ref, 'credentials/unset');
    const store = await readStore();
    if (store[ref] !== undefined) {
      // Write the emptied store back rather than removing the file: the
      // write primitives are the only fs legs every granting host shares.
      delete store[ref];
      await writeStore(store);
    }
    return {};
  },
});

/** The desktop opener's gate: the page asks before rendering the affordance;
 * `false` is the honest platform fact (iOS opens no desktop directory). */
const OPEN_GATE = {
  'settings/canOpenAgentPresetDirectory': async () => false,
};

/** The coverage api rows this module owns (spread into buildCoverageApi). */
export const buildLlmCoverageApi = (ctx, deps) => ({
  ...makeLlmHandlers(ctx),
  'credentials/describe': makeCredentialDescribeHandler(deps.llmRoute),
  ...makeCredentialWriteHandlers(),
  ...OPEN_GATE,
});
