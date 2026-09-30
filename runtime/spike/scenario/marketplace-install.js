/**
 * Marketplace scenario `marketplace.install` — the signed catalog E2E
 * (data-protocols.md §7, proposal 2026-10-01-plugin-marketplace.md ADOPTED),
 * one platform-neutral stream per the house pattern (CLI --http loopback
 * carrier host; the same code rides the real httpFetch on a device):
 *
 *   1. HAPPY PATH: the resolver fetches the catalog over the REAL gateway
 *      httpFetch (loopback mock hosting), verifies the ed25519 signature in
 *      PURE JS (ed25519.js — RFC 8032 vectors first; zero new gateway
 *      primitives), looks up `dsh-fs@^0.1.0`, and installs through the
 *      UNCHANGED installFromFetch, passing the entry's signed trust record
 *      {blobSha256, manifestSha256} THROUGH — the committed receipt's
 *      blobSha256 must equal the catalog entry's (the passthrough proof) —
 *      then loads the installed plugin and exercises its fs service.
 *   2. KEY ROTATION DRILL (§7.2): the dual-signed window index is accepted
 *      under the pinned outgoing key and the incoming key is LEARNED; the
 *      post-window single-signed index is then accepted by the SAME resolver
 *      (rotation completed) and REFUSED by a fresh stale pin
 *      (rotated-key-outside-window) — keys are learned only through a
 *      verified dual-signed index, never from a bare catalog.
 *   3. TAMPER LADDER (§7.1): bad signature / unknown (attacker) key / blob
 *      digest mismatch (hostile MIRROR — the catalog stays honest, the
 *      served bytes flip behind a control endpoint) / manifest digest
 *      mismatch (publisher metadata error, catalog re-signed honestly) —
 *      every rung rejects InstallRejected with its own code, audits through
 *      the log, and leaves ZERO staging trees, no journal growth and the
 *      installed tree byte-identical.
 *
 * URLs are normalized to their PATH in emitted events: the mock hosting's
 * port is runner-local ephemera and must never enter the deterministic log.
 *
 * The pinned key below is the test catalog's dsh-market-1 public key
 * (seed a7b0c9…d7e8, fixed; derivation: tools/gen-marketplace-index.mjs).
 * It stands in for the repo-config pin a real host embeds out-of-band —
 * the production key lives only in the signing CI, never in this repo.
 */
import { createLogger } from 'logger.js';
import { fsRead, httpFetch } from 'gateway.js';
import { createRegistry } from 'registry.js';
import { InstallRejected } from 'install-pipeline.js';
import { readJournal } from 'receipt-journal.js';
import { createResolver } from 'marketplace.js';
import { ed25519SelfTest } from 'ed25519.js';

const SCENARIO = 'marketplace.install';
const log = createLogger('m3.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
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

const toText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');
const PINNED_KEYS = { 'dsh-market-1': 'yHFYEqEja90V51eEaopnHEQ1onn/aUVbiMuEMx8As5w=' };
const rawEnv = globalThis.__dshLaunchEnv?.();
demand(typeof rawEnv === 'string', 'launch env snapshot missing (CLI must pass --env)');
const INDEX_URL = JSON.parse(rawEnv).DSH_MARKET_URL;
demand(typeof INDEX_URL === 'string' && INDEX_URL.startsWith('http://127.0.0.1:'),
  `market endpoint missing from the launch env: ${JSON.stringify(INDEX_URL)}`);
const ENTRY_SPEC = 'dsh-fs@^0.1.0';

/** Events carry PATHS, never the ephemeral port — the runner-local base URL
 * must not enter the deterministic log. */
const urlPath = (url) => {
  const s = String(url);
  const at = s.indexOf('://');
  const slash = s.indexOf('/', at + 3);
  return slash < 0 ? '/' : s.slice(slash);
};
const onMarket = (name, fields) => emit(`market.${name}`, fields);
/** The installer's lifecycle events, port-normalized. */
const onInstall = (name, fields) => {
  const out = { ...fields };
  if (typeof out.url === 'string') out.url = urlPath(out.url);
  emit(`install.${name}`, out);
};
/** The CLI host's httpFetch demands an explicit method; binding it here is
 * the fetchImpl-as-parameter discipline (install-fetch.js) — the gateway
 * shim and the installer stay untouched. */
const fetchGet = (url) => httpFetch(url, { method: 'GET' });
const makeResolver = (docPath) => createResolver({
  fetchImpl: fetchGet,
  indexUrl: `${INDEX_URL}${docPath}`,
  pinnedKeys: PINNED_KEYS,
  on: onMarket,
});

/** InstallAttempt → InstallRejected, or null when nothing was rejected. */
const rejectionOf = async (attempt) => {
  try {
    await attempt();
  } catch (err) {
    if (err instanceof InstallRejected) return err;
    throw err;
  }
  return null;
};

/** Fetch a control endpoint through the same real httpFetch and drain it. */
const controlFetch = async (path) => {
  const res = await fetchGet(`${INDEX_URL}${path}`);
  demand(res.status === 200, `control ${path} status ${res.status}`);
  for await (const chunk of res.body) void chunk.length; // drain (D8 deltas)
};

/** Every rejected install must leave zero staging and the installed tree
 * byte-identical; the journal only ever grew by the happy path's two lines. */
const zeroStaging = async (txIds, happyDigest) => {
  for (const txId of txIds) {
    try {
      await fsRead('app', `plugins/.staging-${txId}/manifest.json`);
      demand(false, `a rejected install staged a tree: ${txId}`);
    } catch (err) {
      demand(err.code === 'io', `expected io error for ${txId}, got ${err.code}`);
    }
  }
  const journal = await readJournal();
  demand(journal.length === 2, `journal grew to ${journal.length} on rejections`);
  const still = (await fsRead('app', 'plugins/dsh-fs@0.1.0/manifest.json')).bytes;
  demand(toText(still).includes('"dsh-fs"'), 'installed tree disturbed');
  emit('market.tamper.zero-staging', {
    rungs: 4, stagingProbed: txIds.length, journalLines: journal.length,
    installedTreeIntact: true, happyBlobSha256: happyDigest,
  });
};

const main = async () => {
  log.debug('main begin');
  emit('gateway.negotiated', { version: 'gateway@1' });

  // 0. The verifier proves itself BEFORE any catalog is trusted (rule 6).
  demand(ed25519SelfTest(), 'ed25519 self-test (RFC 8032 vectors) failed');
  emit('market.ed25519.selftest', { positives: 2, negatives: 3, standard: 'RFC 8032' });

  // 1. HAPPY PATH — fetch + verify + lookup + install through the UNCHANGED
  //    installer with the signed trust record passed through untouched.
  const resolver = makeResolver('/index.json');
  emit('market.resolver.built', { pinnedKeys: ['dsh-market-1'], indexUrlPath: '/index.json' });
  const index = await resolver.refresh();
  demand(index.entries.length === 9, 'catalog entry count drifted');
  const entry = resolver.lookup(ENTRY_SPEC);
  const office = resolver.lookup('dsh-office@*');
  emit('market.lookup.range', { spec: 'dsh-office@*', matched: office.version });
  const result = await resolver.install({ spec: ENTRY_SPEC, txId: 'mkt-c001', on: onInstall, journal: true });
  const receipt = JSON.parse(toText((await fsRead('app', result.receiptPath)).bytes));
  demand(receipt.status === 'committed' && receipt.id === entry.id, 'receipt drifted');
  // THE PASSTHROUGH PROOF: the committed blob digest IS the signed entry's.
  demand(receipt.blobSha256 === entry.blobSha256, 'trust record did not pass through');
  emit('market.install.receipt.asserted', {
    status: receipt.status, id: receipt.id, version: receipt.version,
    blobSha256: receipt.blobSha256, trustMatched: true,
  });

  // The catalog-installed plugin is a REAL plugin: load + exercise fs.
  const registry = createRegistry();
  globalThis.__dshModuleDefine(result.moduleId, toText(result.entrySource));
  registry.install({ manifest: result.manifest, module: await import(result.moduleId) });
  const fs = registry.service('fs');
  emit('market.installed.loaded', { id: result.manifest.id, moduleId: result.moduleId });
  const NOTE = 'installed from the signed catalog';
  const wrote = await fs.writeText('app', 'marketplace-e2e/note.txt', NOTE);
  demand(wrote.written === NOTE.length, 'market plugin write count drifted');
  emit('market.fs.write.ok', { written: wrote.written });
  const got = await fs.readText('app', 'marketplace-e2e/note.txt');
  demand(got.text === NOTE, 'market plugin roundtrip drifted');
  emit('market.fs.read.ok', { text: got.text });
  emit('market.happy.completed', { spec: ENTRY_SPEC, version: entry.version });

  // 2. KEY ROTATION DRILL (§7.2) — window → learn → completed → stale pin.
  const rotating = makeResolver('/index-rotation-window.json');
  await rotating.refresh(); // dual-signed: verified under the pinned K1, K2 learned
  demand(rotating.trustedKeyIds().includes('dsh-market-2'), 'rotation key not learned');
  emit('market.rotation.window.accepted', { dualSigned: true, under: 'dsh-market-1', learned: 'dsh-market-2' });
  await rotating.refresh(`${INDEX_URL}/index-rotated-final.json`); // single-signed K2 — accepted under the LEARNED key
  demand(rotating.lookup(ENTRY_SPEC).id === 'dsh-fs', 'post-window catalog not usable');
  emit('market.rotation.completed', { acceptedUnder: 'dsh-market-2' });
  const stale = makeResolver('/index-rotated-final.json');
  const staleErr = await rejectionOf(() => stale.refresh());
  demand(staleErr?.code === 'unknown-key',
    `stale pin must refuse the post-window catalog with unknown-key, got ${staleErr?.code}`);
  emit('market.rotation.stale-pin-rejected', { key: 'dsh-market-2', code: staleErr.code });

  // 3. TAMPER LADDER (§7.1) — each rung a different broken trust story.
  // rung a: bad signature — the hosting flipped a signature byte.
  const badSig = makeResolver('/index-bad-signature.json');
  const errSig = await rejectionOf(() => badSig.refresh());
  demand(errSig?.code === 'signature', `bad-signature rung: expected signature, got ${errSig?.code}`);
  emit('market.tamper.rejected', { case: 'bad-signature', code: errSig.code });

  // rung b: unknown key — a SELF-CONSISTENT catalog under an attacker key.
  const attacker = makeResolver('/index-unknown-key.json');
  const errAtk = await rejectionOf(() => attacker.refresh());
  demand(errAtk?.code === 'unknown-key', `unknown-key rung: expected unknown-key, got ${errAtk?.code}`);
  emit('market.tamper.rejected', { case: 'unknown-key', code: errAtk.code, signedBy: 'attacker-key-9' });

  // rung c: blob mismatch — the honest catalog against a hostile MIRROR:
  // the served tgz bytes flip behind the hosting's control endpoint; the
  // signed trust record catches what the transport cannot.
  const mirror = makeResolver('/index.json');
  await mirror.refresh();
  await controlFetch('/_tamper/blob');
  emit('market.tamper.armed', { via: 'control-endpoint', target: '/packages/dsh-fs@0.1.0.tgz' });
  const errBlob = await rejectionOf(() => mirror.install({ spec: ENTRY_SPEC, txId: 'mkt-c010', on: onInstall }));
  demand(errBlob?.code === 'integrity', `blob rung: expected integrity, got ${errBlob?.code}`);
  emit('market.tamper.rejected', { case: 'blob-mismatch', code: errBlob.code });
  await controlFetch('/_tamper/none');
  emit('market.tamper.disarmed', {});

  // rung d: manifest mismatch — publisher metadata error, catalog honestly
  // re-signed: the signature alone is not the whole story, the §4 trust
  // record cross-check is what refuses the install.
  const meta = makeResolver('/index-manifest-mismatch.json');
  await meta.refresh(); // the CATALOG verifies — its dsh-fs digest is wrong
  emit('market.tamper.catalog-verified', { case: 'manifest-mismatch', key: 'dsh-market-1' });
  const errMan = await rejectionOf(() => meta.install({ spec: ENTRY_SPEC, txId: 'mkt-c011', on: onInstall }));
  demand(errMan?.code === 'integrity', `manifest rung: expected integrity, got ${errMan?.code}`);
  emit('market.tamper.rejected', { case: 'manifest-mismatch', code: errMan.code });

  await zeroStaging(['mkt-c010', 'mkt-c011'], entry.blobSha256);
  emit('market.completed', { status: 'pass', rungs: 4, rotationLegs: 3, committed: 1 });
  globalThis.__dshComplete(true, 'ok');
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  // An uncaught rejection would otherwise die silently between pumps —
  // route every failure through the scenario verdict (fail loud, rule 5).
  await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
}
