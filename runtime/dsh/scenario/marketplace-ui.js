// dsh:logging-exempt (probe: its verdict output IS the product)
/** marketplace-ui.js — the CLI proof for the plugin marketplace panel
 * (scenario `marketplace.ui.flow`): the page's own wire against a REAL
 * loopback catalog, end to end:
 *
 *   browse      → marketplace/index: the resolver fetches the mock's
 *                 index.json over the REAL gateway httpFetch, verifies its
 *                 ed25519 signature (node:crypto/OpenSSL-signed — an
 *                 independent implementation our pure-JS verifier must agree
 *                 with), and answers the bilingual browse view;
 *   install     → the marketplace/install STREAM: one real transaction —
 *                 index.verified → resolved → the pipeline's own steps
 *                 (fetch.start → … → committed) → receipt — every step
 *                 folded, the package bytes over real loopback HTTP, the
 *                 catalog's trust record driving the installer unchanged;
 *   installed   → marketplace/installed: the receipts journal's committed
 *                 install;
 *   remove      → marketplace/remove: the tree unlinked, the §4 remove
 *                 receipt appended, both views refreshed (the browse view's
 *                 `installed` annotation returns to null).
 *
 * Everything rides the write surface exactly as the page drives it
 * (fullCoverage: true + the marketplace opt-in — the coverage-plane rows).
 * Expected events are declared one-to-one in
 * test/e2e/scenarios/marketplace-ui-flow.json; artifacts land under
 * runtime/dsh/artifacts/macos-cli-marketplace-ui/.
 */
import { createLogger } from 'logger.js';
import { httpFetch, keychainGet } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWriteSurface } from 'upstream/web-write.js';
import { fetchIndex, MarketplaceRejected } from 'marketplace-resolver.js';

const SCENARIO = 'marketplace.ui.flow';
const log = createLogger(SCENARIO);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const ROOT = '/marketplace-ws';
const PKG_ID = 'dsh-market-demo';
let verdict = false;
const fail = (reason) => {
  log.error('probe failed', { reason });
  if (!verdict) { verdict = true; globalThis.__dshComplete(false, reason); }
  throw new Error(reason);
};
const demand = (ok, why) => { if (!ok) fail(why + ' @ ' + (new Error().stack ?? '').slice(0, 300)); };

/** The launch env snapshot (--env on the CLI) — the loopback catalog's URL. */
const launchEnv = () => {
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};
const ENV = launchEnv();
const MARKET_URL = ENV.DSH_MARKET_URL;
const MARKET_PUBKEY = ENV.DSH_MARKET_PUBKEY_B64;

/** The mobile profile boot — the shape a marketplace user's launch delivers. */
const boot = async () => {
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: 'mkt', sessionId: 's-marketplace-boot',
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    llm: { baseURL: 'http://127.0.0.1:1', apiKey: 'unused', provider: 'mock', model: 'mock-1' },
  });
  let guard = 0;
  while ((ctx.agents.get('s-marketplace-boot') === undefined) && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get('s-marketplace-boot') !== undefined, 'the boot agent never appeared');
  return ctx;
};

/** The surface's frame plumbing: one capturing post (the onboarding shape).
 * A stream's terminal frame is observed by POLLING with settle-yield waits
 * (rule 8's condition poll, bounded below). */
const makeFrameHub = () => {
  const frames = [];
  return { frames, post: (frame) => { frames.push(frame); } };
};

const settleYield = async () => { await keychainGet('dsh.marketplace/poll'); };

/** One install stream through the surface's open leg; resolves the raw
 * frames at the stream's terminal (bounded, fail loud). */
const runInstallStream = async (surface, hub, streamId, id) => {
  surface.openStream({
    endpoint: 'marketplace/install', streamId, payload: { args: { id } },
  });
  const mine = () => hub.frames.filter((f) => f.streamId === streamId);
  for (let guard = 0; guard < 4000; guard++) {
    const error = mine().find((f) => f.type === 'mux.error');
    if (error !== undefined) return { error, items: [] };
    const end = mine().find((f) => f.type === 'mux.end');
    if (end !== undefined) {
      return {
        error: undefined,
        items: mine().filter((f) => f.type === 'mux.item').map((f) => f.value),
      };
    }
    await settleYield();
  }
  fail(`install stream ${streamId} never ended`);
};

/** The tamper ladder's signature family (the proposal's verification plan),
 * driven through the SAME resolver the face uses: a flipped-summary index
 * under the real key's signature must refuse as `signature`, and a foreign
 * keys+index+signature wholesale swap — self-consistent, exactly what a
 * hosting attacker ships — must refuse against the HOST-SIDE PIN as
 * `unknown-key`. The digest-mismatch half of the ladder is the pipeline's
 * own trust-record enforcement (install.full-cycle's tampered leg). */
const tamperPhase = async () => {
  const fetchGet = (url) => httpFetch(url, { method: 'GET' });
  const attempts = [
    { url: `${MARKET_URL}/index-tampered.json`, want: 'signature',
      event: 'marketplace.tamper.signature' },
    { url: `${MARKET_URL}/index-foreign.json`, want: 'unknown-key',
      event: 'marketplace.tamper.foreign-key' },
  ];
  for (const attempt of attempts) {
    let rejected;
    try {
      await fetchIndex({ url: attempt.url, fetchImpl: fetchGet,
        pinnedKey: MARKET_PUBKEY, force: true });
      rejected = null;
    } catch (err) {
      rejected = err;
    }
    demand(rejected instanceof MarketplaceRejected
      && rejected.code === attempt.want,
      `the tamper leg ${attempt.url} did not refuse as ${attempt.want}:`
      + ` ${JSON.stringify(rejected?.code ?? 'accepted')}`);
    emit(attempt.event, { code: rejected.code, url: attempt.url.slice(MARKET_URL.length) });
  }
};

/** Browse: the resolver's verified index, annotated with install state. */
const browsePhase = async (api, tag) => {
  const view = await api['marketplace/index']({});
  const entries = view?.entries ?? [];
  demand(Array.isArray(entries) && entries.length === 1, `browse ${tag}: expected 1 entry`);
  const entry = entries[0];
  demand(entry.id === PKG_ID && entry.version === '0.1.0', `browse ${tag}: wrong entry`);
  demand(view.signature.key === 'dsh-market-1', 'the browse view lost the signing key');
  demand(typeof entry.summary.zh === 'string' && entry.summary.zh.length > 0,
    'the bilingual summary lost its zh side');
  demand(entry.capabilities.required.includes('gateway@1'), 'the caps summary lost required');
  emit(`marketplace.browse${tag}`, {
    entries: entries.length, id: entry.id, version: entry.version,
    key: view.signature.key, installed: entry.installed,
  });
  return entry;
};

/** Install: one stream, one transaction, every step folded. */
const installPhase = async (surface, hub) => {
  emit('marketplace.install.start', { id: PKG_ID });
  const { error, items } = await runInstallStream(surface, hub, 's-mkt-install', PKG_ID);
  demand(error === undefined, `the install stream errored: ${JSON.stringify(error)}`);
  const kinds = items.map((v) => v?.kind);
  const receipt = items.at(-1);
  demand(receipt?.kind === 'receipt' && receipt.status === 'committed',
    `the fold never reached the receipt: ${JSON.stringify(kinds)}`);
  demand(kinds[0] === 'index.verified', 'the fold never verified the index');
  demand(kinds.includes('fetch.start') && kinds.includes('fetch.status'),
    'the fold lost the fetch legs');
  demand(kinds.includes('digest.verified'), 'the fold lost the digest verify');
  demand(kinds.includes('negotiated'), 'the fold lost the capability negotiation');
  demand(kinds.includes('committed'), 'the fold lost the commit');
  emit('marketplace.install.progress', { steps: kinds.length });
  const committed = items.find((v) => v?.kind === 'committed');
  emit('marketplace.install.committed', {
    id: receipt.id, version: receipt.version, status: committed.status,
  });
  emit('marketplace.install.receipt', { status: receipt.status });
  return receipt;
};

/** Installed view → remove → empty view → the browse annotation resets. */
const lifecyclePhase = async (api) => {
  const before = await api['marketplace/installed']({});
  const items = before?.items ?? [];
  demand(items.length === 1 && items[0].id === PKG_ID && items[0].version === '0.1.0',
    `the installed view is wrong: ${JSON.stringify(items)}`);
  demand(typeof items[0].dir === 'string' && items[0].dir.startsWith('plugins/'),
    'the installed row lost its directory');
  emit('marketplace.installed', { id: items[0].id, version: items[0].version, items: items.length });
  // Unary handlers take payload.args directly (the deliverApiRequest
  // unwrap); the page's rpc wraps {args} on the wire.
  const removed = await api['marketplace/remove']({ id: PKG_ID });
  demand(removed?.removed === '0.1.0', `the remove leg answered ${JSON.stringify(removed)}`);
  emit('marketplace.removed', { id: PKG_ID, version: removed.removed });
  const after = await api['marketplace/installed']({});
  demand((after?.items ?? []).length === 0, 'the removed plugin still lists as installed');
  emit('marketplace.installed.empty', { items: (after?.items ?? []).length });
  const view = await api['marketplace/index']({});
  const entry = (view?.entries ?? []).find((e) => e.id === PKG_ID);
  demand(entry !== undefined && entry.installed === null,
    'the browse annotation did not reset after removal');
  emit('marketplace.browse.after', { installed: entry.installed });
};

/** Main: boot → browse → install (one streamed transaction) → installed →
 * remove → empty → the annotation reset → complete. */
try {
  demand(typeof MARKET_URL === 'string' && MARKET_URL.startsWith('http://127.0.0.1:'),
    'DSH_MARKET_URL must be the runner\'s loopback catalog');
  demand(typeof MARKET_PUBKEY === 'string' && MARKET_PUBKEY.length >= 43,
    'DSH_MARKET_PUBKEY_B64 must carry the host-side pin (proposal rule 2)');
  const ctx = await boot();
  const hub = makeFrameHub();
  const surface = createWriteSurface(ctx, hub.post, {
    root: ROOT, provider: 'mock', model: 'mock-1',
    baseURL: 'http://127.0.0.1:1', routeKind: 'mock',
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
    marketplace: { indexUrl: `${MARKET_URL}/index.json`, publicKey: MARKET_PUBKEY },
  });
  const { api, dispose } = surface;
  await browsePhase(api, '');
  await tamperPhase();
  await installPhase(surface, hub);
  await lifecyclePhase(api);
  dispose?.();
  emit('marketplace.flow/completed', {
    status: 'pass',
    surface: 'marketplace: browse (signed catalog) → install (streamed fold) → installed → remove → empty',
  });
  if (!verdict) { verdict = true; globalThis.__dshComplete(true, 'marketplace ui flow verified'); }
} catch (e) {
  fail((e?.message ?? String(e)) + ' @ ' + (e?.stack ?? '').slice(0, 300)
    + ' | code=' + (e?.code ?? '-'));
}
