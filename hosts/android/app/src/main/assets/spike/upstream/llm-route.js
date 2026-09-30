// dsh:logging-exempt (adapter seam: all emission rides caller-provided hooks)
/**
 * upstream/llm-route.js — the ONE home of the llm route resolution and the
 * adapter rebind seam (the BYOK onboarding round, 2026-09-30).
 *
 * Three route sources, resolved in order — the first present wins:
 *
 *   1. staged  — the host seat's runtime.config llmBaseUrl (the
 *              `<appScope>/profiles/default/llm/config.json` credential the
 *              SessionServe seats deliver; the shape the llm.live-stream
 *              runner stages). Unchanged behavior, byte-identical boots.
 *   2. byok    — the onboarding panel's credential in the KEYCHAIN under
 *              BYOK_REF (contract v1.0.0 rows 8-9 — never a plaintext file,
 *              never a log line). Read at boot through the gateway, so a
 *              saved credential resurrects across relaunch with zero host
 *              changes. A host that declares no keychain (or a corrupt
 *              entry) resolves to no credential — the seat's own precedent
 *              for malformed stored credentials (SessionServe.loadCredential
 *              yields nil, never a half-configured transport).
 *   3. mock    — the carrier's scripted loopback endpoint (the E2E
 *              determinism boundary composer.live-write pins).
 *
 * The REBIND seam: boot.js registers its adapter's disposer here
 * (registerRouteDisposer), so onboarding/save can swap the live transport
 * (dispose → registerAdapter with the user's credential) and mutate the
 * write surface's llmRoute — new sessions then route to the user's
 * endpoint. All through the vendored LlmRuntime's own registry API; no
 * gateway primitive is touched beyond the frozen set.
 */
import { encodeUtf8, decodeUtf8 } from 'node:buffer';
import { keychainGet } from '../gateway.js';
import { createLogger } from '../logger.js';
import { createGatewayLlmAdapter } from './llm-transport.js';

const log = createLogger('dsh.llm-route');

/** The keychain ref the onboarding panel stores its credential under. */
export const BYOK_REF = 'dsh.llm/byok-route';

/** The panel's provider rows (mirrored in the page bundle — see
 * presentation/web-client-next/web/js/onboarding-core.js; this repo mirrors
 * page-side vocabulary deliberately, it never imports runtime code). */
export const BYOK_PROVIDERS = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  'openai-compatible': { baseURL: '', model: '' },
};

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** The credential-ref grammar, @deepseek-ai/dsh-credentials REF_PATTERN
 * (mirrored in web-write-llm.js — same wire vocabulary). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Pure validation for one onboarding credential {provider, baseURL, apiKey,
 * model} → {error: {field, why}} | null. Shared by the coverage save leg
 * and usable in probes; the PAGE keeps its own mirror for inline feedback. */
export const validateCredential = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: { field: 'credential', why: 'the credential is not an object' } };
  }
  const { provider, baseURL, apiKey, model } = value;
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    return { error: { field: 'provider', why: `provider must match ${PROVIDER_PATTERN}` } };
  }
  if (REF_PATTERN.test(deriveByokRef(provider)) === false) {
    return { error: { field: 'provider', why: 'provider has no expressible credential ref' } };
  }
  if (typeof baseURL !== 'string' || !/^https?:\/\/[^\s]+$/.test(baseURL)) {
    return { error: { field: 'baseURL', why: 'baseURL must be an http(s) URL' } };
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 512) {
    return { error: { field: 'apiKey', why: 'apiKey must be 1..512 chars' } };
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > 128) {
    return { error: { field: 'model', why: 'model must be 1..128 chars' } };
  }
  return null;
};

/** upstream settings-models deriveKeyRef, byok-spelled: the credential ref
 * one provider route names (deepseek → DEEPSEEK_API_KEY). Mirrored, not
 * imported — the original lives in the page bundle. */
export const deriveByokRef = (provider) =>
  `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

/** The stored shape: exactly the staged config.json's fields, minus nothing
 * — the key rides INSIDE the keychain bytes, never beside them. */
export const encodeCredential = (credential) =>
  encodeUtf8(JSON.stringify({
    provider: credential.provider,
    baseURL: credential.baseURL,
    apiKey: credential.apiKey,
    model: credential.model,
  }));

/** keychain bytes → credential | null. A gateway error (the primitive is
 * unavailable), an unset ref (null), a parse failure, or a shape violation
 * all resolve null — corruption degrades to "no BYOK credential", it never
 * bricks the boot (the seat's loadCredential precedent). Corruption at the
 * parse/shape level is logged at warn (the level release builds keep). */
export const decodeCredential = async () => {
  let stored;
  try {
    stored = await keychainGet(BYOK_REF);
  } catch (error) {
    log.debug('keychain read unavailable — no byok credential', { code: error?.code });
    return null;
  }
  if (stored === null || stored === undefined) return null;
  try {
    const credential = JSON.parse(decodeUtf8(stored.secret));
    if (validateCredential(credential) !== null) throw new Error('shape');
    return credential;
  } catch (error) {
    log.warn('the stored byok credential is unreadable — ignoring it', {
      ref: BYOK_REF, reason: error?.message ?? 'parse failed',
    });
    return null;
  }
};

/** One resolution outcome: the route fields boot.js's mountLlm consumes plus
 * `kind` (the honest source fact the onboarding status answers from) and the
 * scripted flag composer.live-write pins its determinism on. */
export const stagedRoute = (cfg) => {
  if (typeof cfg.llmBaseUrl === 'string' && cfg.llmBaseUrl.length > 0) {
    if (typeof cfg.llmApiKey !== 'string' || cfg.llmApiKey.length === 0) {
      throw new Error('runtime.config llmBaseUrl given without llmApiKey');
    }
    if (typeof cfg.llmModel !== 'string' || cfg.llmModel.length === 0) {
      throw new Error('runtime.config llmBaseUrl given without llmModel');
    }
    const provider = typeof cfg.llmProvider === 'string' && cfg.llmProvider.length > 0
      ? cfg.llmProvider : 'openai-compatible';
    let host = 'the configured endpoint';
    try { host = new URL(cfg.llmBaseUrl).host; } catch { /* keep the generic label */ }
    return {
      kind: 'staged',
      baseURL: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, provider,
      model: cfg.llmModel, scripted: false, userEndpoint: true,
      adapterName: `user-supplied OpenAI-compatible endpoint (${provider})`,
      transportLabel: `gateway httpFetch → ${host} (user-supplied endpoint)`,
    };
  }
  return null;
};

export const mockRoute = (cfg) => {
  if (typeof cfg.mockLlmUrl !== 'string' || !cfg.mockLlmUrl.startsWith('http://127.0.0.1:')) {
    throw new Error(`runtime.config mock endpoint missing: ${JSON.stringify(cfg.mockLlmUrl)}`);
  }
  return {
    kind: 'mock',
    baseURL: cfg.mockLlmUrl, apiKey: cfg.apiKey, provider: 'mock',
    model: 'mock-1', scripted: true, userEndpoint: false,
    adapterName: 'scripted loopback chat-completions (carrier mock-llm endpoint)',
    transportLabel: 'gateway httpFetch → carrier scripted chat-completions '
      + '(E2E determinism boundary, mirrors the CLI mock server)',
  };
};

export const byokRoute = (credential) => {
  let host = 'the configured endpoint';
  try { host = new URL(credential.baseURL).host; } catch { /* keep the generic label */ }
  return {
    kind: 'byok',
    baseURL: credential.baseURL, apiKey: credential.apiKey, provider: credential.provider,
    model: credential.model, scripted: false, userEndpoint: true,
    adapterName: `BYOK onboarding endpoint (${credential.provider})`,
    transportLabel: `gateway httpFetch → ${host} (BYOK onboarding credential)`,
  };
};

/** The boot-side resolver (composer-web-live): staged → byok → mock. Async
 * ONLY because the byok leg reads the keychain; the staged/mock legs stay
 * synchronous shapes. */
export const resolveLlmRoute = async (cfg) =>
  stagedRoute(cfg) ?? byokOrMock(cfg);

const byokOrMock = async (cfg) => {
  const credential = await decodeCredential();
  return credential === null ? mockRoute(cfg) : byokRoute(credential);
};

// ---- the rebind seam -------------------------------------------------------

const routeDisposers = new WeakMap();

/** boot.js hands its adapter registration's disposer over at mount, so a
 * rebind can replace the boot route's adapter (the vendored registry throws
 * DUPLICATE_ADAPTER on a plain second registration). */
export const registerRouteDisposer = (runtime, disposer) => {
  routeDisposers.set(runtime, disposer);
};

/** Swap the live transport to one user credential. Returns the adapter
 * labels the caller may emit; NEVER the credential. Throws (fail loud) when
 * no llm runtime is mounted or the vendored registry rejects — a save that
 * cannot rebind must not report success. */
export const rebindLlmRoute = (ctx, credential) => {
  const runtime = ctx.get('llm');
  if (runtime === undefined) {
    throw new Error('llm-route: no llm runtime is mounted — cannot rebind');
  }
  const route = byokRoute(credential);
  const previous = routeDisposers.get(runtime);
  if (previous !== undefined) previous();
  routeDisposers.set(runtime, runtime.registerAdapter([route.provider], createGatewayLlmAdapter({
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    provider: route.provider,
    name: route.adapterName,
    userEndpoint: route.userEndpoint,
    onWire: route.onWire,
    onSse: route.onSse,
    onRequestBody: route.onRequestBody,
  })));
  return route;
};
