/**
 * upstream/web-write-cordis.js — the `dynamicCordisRunner` Remote
 * namespace's two RUNTIME-SIDE legs (issue #335 B3): the answers the page
 * halves need so every page load stops reporting `gateway/unimplemented`.
 * The callers (measured in the vendored sources at the pin):
 *
 *   - `dsh-client-ui-cordis` calls `inventory()` once per mount (its
 *     sidebar panel's refresh) and throws the raw error code into the
 *     console on `answered.ok === false`;
 *   - `dsh-cordis-client-runner` calls `syncInspectManifest(providers)`
 *     once per inspect provider registration and throws on `!answered.ok`.
 *
 * The shapes are the frozen cordis-host-runner descriptor
 * (vendor/dsh/cordis-host-runner@0.1.6-alpha.2/lib/typert.host.js):
 *   inventory()          → DynamicCordisInventoryRow[]
 *   syncInspectManifest(providers) → null
 *
 * The HONEST mobile answers, from real runtime state (never faked):
 *   - inventory: the runner half (vendor cordis-host-runner's
 *     `dynamicCordisRunner` service) is NOT mounted by the mobile spine —
 *     boot.js mounts no dynamic package runner, and nothing on this host
 *     defines a dynamic cordis package. The real roster is empty: `[]`.
 *     When a future boot DOES mount the service, the handler forwards to
 *     its own inventory() instead of inventing rows here. Filling spine
 *     services into the dynamic-package row shape would make the panel
 *     render static mounts as retractable dynamic plugins — that would be
 *     fabrication, not adaptation.
 *   - syncInspectManifest: validates the manifest (fail loud, rule 5 — a
 *     malformed array answers the gateway bad-request envelope, the only
 *     error channel a null-only result has) and RECORDS it: the accepted
 *     manifest is real runtime state (the last synced client provider
 *     directory), exactly what the desktop's inspect registry stores. No
 *     mobile consumer queries it yet — tool-cordis stays absent pending
 *     the carrier's full inspect bridge (issue #335 B; the recorded
 *     manifest is the state that work reads first).
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.web.cordis');

/** One method's structural check (the typert shape: name/description
 * strings). Returns a problem string or null. */
const methodProblem = (method, providerId) => (method === null || typeof method !== 'object'
  || typeof method.name !== 'string' || method.name === ''
  || typeof method.description !== 'string'
  ? `provider ${providerId} has a method without name/description strings`
  : null);

/** One provider's structural check (id/description strings, methods[]).
 * Returns a problem string or null. */
const providerProblem = (provider) => {
  log.debug('provider validate', { id: provider?.id ?? null });
  if (provider === null || typeof provider !== 'object') {
    return 'each provider must be an object';
  }
  if (typeof provider.id !== 'string' || provider.id === '') {
    return 'each provider needs a non-empty id string';
  }
  if (typeof provider.description !== 'string') {
    return `provider ${provider.id} needs a description string`;
  }
  if (!Array.isArray(provider.methods)) {
    return `provider ${provider.id} needs a methods array`;
  }
  for (const method of provider.methods) {
    const problem = methodProblem(method, provider.id);
    if (problem !== null) return problem;
  }
  return null;
};

/** Structural validation of one syncInspectManifest providers array (the
 * typert shape: id/description strings, methods[] with name/description
 * strings and nullable JSON schemas). Returns a problem string or null. */
const manifestProblem = (providers) => {
  log.debug('manifest validate', { providers: Array.isArray(providers)
    ? providers.length : String(providers) });
  if (!Array.isArray(providers)) return 'providers must be an array';
  for (const provider of providers) {
    const problem = providerProblem(provider);
    if (problem !== null) return problem;
  }
  return null;
};

/**
 * The two runtime-side dynamicCordisRunner legs over one spine ctx, plus
 * the synced-manifest accessor (the runtime state the carrier's future
 * inspect bridge reads first — the panel battery asserts it).
 * @param ctx - the spine context (read for the runner service's presence).
 * @returns { api, syncedManifest } — api keyed by the two wire names.
 */
/** The bad-request envelope for a refused manifest (the module doc names
 * why this one leg throws). */
const badRequest = (problem) => ({
  remote: true,
  code: 'gateway/bad-request',
  message: `dynamicCordisRunner/syncInspectManifest: ${problem}`,
  details: {},
});

/** The inventory leg: the real state read — no runner service → no dynamic
 * packages; a mounted runner answers for itself (forward, never re-invent). */
const inventoryLeg = (ctx) => async () => {
  const runner = ctx.get('dynamicCordisRunner');
  log.debug('inventory read', { runnerMounted: runner !== undefined });
  if (runner?.inventory !== undefined) return runner.inventory();
  return [];
};

/** The manifest-sync leg: validate, record, answer the null result. The
 * null-only result has no in-band failure member — the gateway RemoteError
 * envelope IS this call's designed error channel (the page reads
 * answered.ok === false and surfaces the code). */
const syncInspectLeg = (record) => async (args) => {
  const providers = args?.providers;
  const problem = manifestProblem(providers);
  if (problem !== null) {
    log.warn('manifest refused', { problem });
    throw badRequest(problem);
  }
  record(providers);
  log.debug('manifest synced', { providers: providers.length });
  return null;
};

export const makeCordisRunnerFace = (ctx) => {
  log.debug('cordis legs assembled', {});
  let syncedManifest = null;
  return {
    api: {
      'dynamicCordisRunner/inventory': inventoryLeg(ctx),
      'dynamicCordisRunner/syncInspectManifest':
        syncInspectLeg((providers) => (syncedManifest = providers)),
    },
    syncedManifest: () => syncedManifest,
  };
};

/** The wire entries for the write surface's api map (web-write.js). */
export const makeCordisRunnerApiEntries = (ctx) => makeCordisRunnerFace(ctx).api;
