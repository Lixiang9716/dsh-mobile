// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-onboarding.js — the BYOK onboarding legs of the
 * COVERAGE plane (2026-09-30): the first-run credential panel's wire, grown
 * ENTIRELY on existing mechanisms. No new gateway primitive: the credential
 * persists through the frozen keychainGet/keychainSet (contract v1.0.0 rows
 * 8-9), the connection test streams one minimal real chat-completions over
 * the frozen httpFetch (runtime/spike/llm.js streamChat — the same transport
 * path a turn takes), and the route rebind is the vendored LlmRuntime's own
 * registry API through upstream/llm-route.js.
 *
 *   onboarding/status → {mode: 'byok'|'staged'|'mock', provider?, baseURL?,
 *                        model?} — the panel's detect leg. NEVER the key:
 *                        values do not cross the wire back (the credential
 *                        management plane's own rule, web-write-llm.js).
 *   onboarding/test   (mux stream) → one probe turn over the caller-given
 *                        {provider, baseURL, apiKey, model}; progress rides
 *                        mux.item events (open/delta/done), failures one
 *                        mux.error with the wire's own code + message. The
 *                        key lives in the args only — it is not logged and
 *                        not echoed.
 *   onboarding/save   → keychainSet(BYOK_REF, credential bytes) THEN the
 *                        live rebind (dispose boot adapter → register the
 *                        user's) THEN the surface's llmRoute mutation, so
 *                        NEW sessions route to the user's endpoint. A host
 *                        without a keychain fails loud (gateway/unavailable)
 *                        — the CLI's honest pre-2026-09-30 shape, never a
 *                        plaintext fallback.
 *   onboarding/clear  → the inverse (the B29 round, 2026-10-01): keychainSet
 *                        (BYOK_REF, null) — the frozen delete half — THEN
 *                        restoreBootRoute (dispose the byok adapter,
 *                        re-derive the boot route through the registered
 *                        factory) THEN the surface's llmRoute mutation back.
 *                        The #280-era stance ("an in-process un-rebind would
 *                        be a lie") named the SURFACE's route view, which
 *                        deliberately carries no credential facts; the leg
 *                        lives RUNTIME-side like save does, so the honest
 *                        shape is the installer handing the boot-route
 *                        factory to upstream/llm-route.js — no key crosses
 *                        the wire in either direction (the call takes NO
 *                        arguments, returns {}). A surface whose installer
 *                        registered no factory fails loud at the call
 *                        (restoreBootRoute throws; the save leg's own
 *                        fail-loud precedent), never a silent fake restore.
 */
import { keychainSet, httpFetch } from '../gateway.js';
import { streamChat } from '../llm.js';
import {
  BYOK_REF, BYOK_PROVIDERS, decodeCredential, encodeCredential,
  validateCredential, rebindLlmRoute, restoreBootRoute,
} from 'upstream/llm-route.js';

const badRequest = (message) => (
  { remote: true, code: 'gateway/bad-request', message, details: {} });

/** The wire error triple for an arbitrary thrown value. The web-write.js
 * errorOf does exactly this, but importing it here would close the module
 * cycle web-write → web-write-coverage → HERE → web-write — and the error
 * legs would touch an uninitialized binding (measured: an unhandled
 * rejection the engine reports as an empty error). Local copy, same shape. */
const wireOf = (error) => (
  error !== null && typeof error === 'object'
  && (error.remote === true || error.isDSHRemoteError === true)
    ? { code: error.code, message: error.message, details: error.details ?? {} }
    : {
      code: 'gateway/unavailable',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    });

/** One status row: the keychain is the source of truth for 已配过 (a saved
 * credential outlives boots); the route kind answers for staged/mock. */
const makeStatusHandler = (llmRoute) => async () => {
  const credential = await decodeCredential();
  if (credential !== null) {
    return {
      mode: 'byok', provider: credential.provider,
      baseURL: credential.baseURL, model: credential.model,
    };
  }
  if (llmRoute.kind === 'staged') {
    return {
      mode: 'staged', provider: llmRoute.provider,
      baseURL: llmRoute.baseURL, model: llmRoute.model,
    };
  }
  return { mode: 'mock', provider: llmRoute.provider, model: llmRoute.model };
};

/** The save leg: persist into the keychain, then rebind, then point the
 * surface's route (read at session/CREATE time) at the user's endpoint. */
const makeSaveHandler = (ctx, llmRoute) => async (args) => {
  const invalid = validateCredential(args);
  if (invalid !== null) {
    throw badRequest(`onboarding/save: ${invalid.error.field} — ${invalid.error.why}`);
  }
  await keychainSet(BYOK_REF, encodeCredential(args));
  rebindLlmRoute(ctx, args);
  llmRoute.provider = args.provider;
  llmRoute.model = args.model;
  llmRoute.baseURL = args.baseURL;
  llmRoute.kind = 'byok';
  return {};
};

/** The clear leg: delete the keychain ref (the frozen delete half), then
 * restore the boot route through the registered factory, then point the
 * surface's route back. Idempotent by construction — clearing an unset ref
 * deletes nothing and the restored route IS the boot route. The key never
 * crosses the wire: the call takes no arguments and the answer is {}.
 * Sessions created while the byok route was live keep their provider
 * binding (session/CREATE reads the route then); their next turn fails loud
 * on the disposed adapter — the same live-session semantics a save's
 * rebind has always had, in reverse. */
const makeClearHandler = (ctx, llmRoute) => async () => {
  await keychainSet(BYOK_REF, null);
  const route = restoreBootRoute(ctx);
  llmRoute.provider = route.provider;
  llmRoute.model = route.model;
  llmRoute.baseURL = route.baseURL;
  llmRoute.kind = route.kind;
  return {};
};

/** The connection test: ONE minimal real request over the gateway transport
 * (streamChat), streamed as mux items. A 24-token cap keeps the probe cheap;
 * the mock server's script answers in full either way. */
const runProbe = async (post, msg, args) => {
  const invalid = validateCredential(args);
  if (invalid !== null) {
    const wire = badRequest(`onboarding/test: ${invalid.error.field} — ${invalid.error.why}`);
    post({ type: 'mux.error', streamId: msg.streamId,
      code: wire.code, message: wire.message, details: wire.details });
    return;
  }
  try {
    await streamChat({
      fetchImpl: httpFetch,
      baseUrl: args.baseURL, apiKey: args.apiKey, model: args.model,
      messages: [{ role: 'user', content: 'ping' }], maxTokens: 24,
      on: (event, fields) => {
        if (event === 'open') post({ type: 'mux.item', streamId: msg.streamId,
          value: { kind: 'probe.open', status: fields.status } });
        else if (event === 'delta') post({ type: 'mux.item', streamId: msg.streamId,
          value: { kind: 'probe.delta', index: fields.index } });
        else if (event === 'done') post({ type: 'mux.item', streamId: msg.streamId,
          value: { kind: 'probe.done', deltas: fields.deltas, chars: fields.chars } });
      },
    });
    post({ type: 'mux.end', streamId: msg.streamId });
  } catch (error) {
    const wire = wireOf(error);
    post({ type: 'mux.error', streamId: msg.streamId,
      code: wire.code, message: wire.message, details: wire.details });
  }
};

/** The coverage api rows this module owns (spread into buildCoverageApi). */
export const buildOnboardingApi = (ctx, deps) => ({
  'onboarding/status': makeStatusHandler(deps.llmRoute),
  'onboarding/save': makeSaveHandler(ctx, deps.llmRoute),
  'onboarding/clear': makeClearHandler(ctx, deps.llmRoute),
});

/** The onboarding mux stream open leg (one endpoint: onboarding/test). The
 * probe outlives the open call — items post as they happen; a late cancel
 * finds the stream already ended (the extra mux.end is benign, the page's
 * mux closes idempotently). */
export const openOnboardingStream = (ctx, deps, post, msg) => {
  if (msg.endpoint !== 'onboarding/test') return undefined;
  runProbe(post, msg, msg.payload?.args).catch((error) => {
    const wire = wireOf(error);
    post({ type: 'mux.error', streamId: msg.streamId,
      code: wire.code, message: wire.message, details: wire.details });
  });
  return { kind: 'attached', endpoint: msg.endpoint };
};

/** The provider presets the panel renders (re-exported so the wire facts
 * stay in one runtime home; the page mirrors them for inline UI). */
export const onboardingProviders = BYOK_PROVIDERS;
