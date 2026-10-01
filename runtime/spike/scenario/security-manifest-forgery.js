// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * Scenario `security.manifest-forgery` — the install pipeline under a
 * forgery ladder (threat model: docs/security-threat-model.md, surface
 * "marketplace supply chain"). The §7.1 SIGNED-CATALOG ladder (bad
 * signature / unknown key / hostile mirror / publisher metadata error)
 * already lives in the `marketplace.install` leg — this leg attacks the
 * faces that ladder does not: the PACKAGE (manifest) and the CATALOG'S
 * FRESHNESS.
 *
 * The pipeline ladder (forged tarballs built in-scenario with tarWrite,
 * driven through the UNCHANGED installPackage):
 *   - forge.capability.stale-manifest   — a manifest with an escalated
 *     capability requirement (notify@2) plus the HONEST catalog trust
 *     record: the manifest digest no longer matches the anchor (`integrity`,
 *     before negotiation);
 *   - forge.capability.self-consistent  — the same escalated manifest with
 *     fully recomputed trust (attacker owns the bytes end to end): the
 *     §2 negotiation refuses what the digests cannot (`capability`);
 *   - forge.entry-replaced              — byte-identical manifest, swapped
 *     entry, the catalog's honest trust record: the blob anchor refuses the
 *     repacked tarball (`integrity`, before anything unpacks);
 *   - forge.manifest-id-swap            — a manifest claiming another
 *     package's id, self-consistent trust: the id pin rejects (`manifest`);
 *   - forge.version-rollback.pipeline   — an OLD honest package (0.9.0)
 *     against the CURRENT catalog's trust record: the anchor refuses bytes
 *     the catalog never pinned (`integrity`).
 * Every rejection is audited (one event each) and leaves zero staging and
 * no receipt/journal — the transaction never reached its commit point.
 *
 * The freshness rung — forge.rollback.catalog — attacks the CATALOG'S
 * FRESHNESS: a stale-but-VALID catalog (an honestly signed old index,
 * served by the runner's loopback hosting — the model for a compromised
 * mirror serving content the publisher once published). The rung's shape:
 * the CURRENT catalog is refreshed FIRST (forge.freshness.anchor — first
 * contact anchors the monotonic generatedAt floor through the app-scope
 * freshness store; a fresh client is never bricked), THEN the stale
 * catalog replays: the freshness anchor refuses it at REFRESH — before
 * the resolver holds it as state and before any install — as
 * `catalog`/stale (forge.rollback.catalog outcome=rejected), nothing
 * stages, and the current catalog still refreshes afterward (equal floor
 * passes — the guard does not brick honest refreshes). This rung used to
 * pin the HIGH finding (the replay installed, #295); the freshness anchor
 * landing flipped the pinned expectation to `rejected` in the same
 * change, per the threat model's maintenance contract. Falsify-first
 * keeps the flip honest: with the floor check neutered the replay lands
 * again and this checker reddens.
 *
 * The control face: after the whole ladder an HONEST package installs
 * (forge.survived) — the pipeline still serves honest publishers.
 */
import { createLogger } from 'logger.js';
import { fsRead, httpFetch } from 'gateway.js';
import { installPackage, InstallRejected } from 'install-pipeline.js';
import { createResolver } from 'marketplace.js';
import { createFreshnessAnchor } from 'freshness-store.js';
import { tarWrite } from 'tar-mini.js';
import { sha256Hex } from 'sha256.js';

const SCENARIO = 'security.manifest-forgery';
const log = createLogger('security.forge');
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

// ---- the test catalog's pin (the marketplace leg's key, byte-identical) ----
const PINNED_KEYS = { 'dsh-market-1': 'yHFYEqEja90V51eEaopnHEQ1onn/aUVbiMuEMx8As5w=' };
const rawEnv = globalThis.__dshLaunchEnv?.();
demand(typeof rawEnv === 'string', 'launch env snapshot missing (CLI must pass --env)');
const INDEX_URL = JSON.parse(rawEnv).DSH_MARKET_URL;
demand(typeof INDEX_URL === 'string' && INDEX_URL.startsWith('http://127.0.0.1:'),
  `market endpoint missing from the launch env: ${JSON.stringify(INDEX_URL)}`);

/** Events carry PATHS, never the ephemeral port (the marketplace leg's rule).
 * Installer/resolver lifecycle steps stay at DEBUG: the canonical stream
 * carries one audit record per attack (forge.case), not the step plumbing. */
const urlPath = (url) => {
  const s = String(url);
  const at = s.indexOf('://');
  const slash = s.indexOf('/', at + 3);
  return slash < 0 ? '/' : s.slice(slash);
};
const onInstall = (name, fields) => {
  const out = { ...fields };
  if (typeof out.url === 'string') out.url = urlPath(out.url);
  log.debug('installer step', { name, ...out });
};

// ---- package construction --------------------------------------------------
const textBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const toText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');

const entrySource = (tag) =>
  `// dsh-echo ${tag} — honest plugin source; the pipeline stores bytes, it never runs them here.\n` +
  'export const activate = () => "echo";\n';
const manifestJson = ({ id, version, extraRequired = [] }) => JSON.stringify({
  schemaVersion: 1,
  id,
  version,
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', ...extraRequired], optional: [] },
  hooks: { activate: 'activate' },
});

/** Build the tgz bytes for one package variant. */
const buildPackage = (manifest, entry) => tarWrite([
  { path: 'manifest.json', bytes: textBytes(manifest) },
  { path: 'bundle/index.js', bytes: textBytes(entry) },
]);
const trustOf = (pkgBytes, manifest) => ({
  blobSha256: sha256Hex(pkgBytes),
  manifestSha256: sha256Hex(textBytes(manifest)),
});

const HONEST_MANIFEST = manifestJson({ id: 'dsh-echo', version: '1.0.1' });
const OLD_MANIFEST = manifestJson({ id: 'dsh-echo', version: '0.9.0' });
const ESCALATED_MANIFEST = manifestJson({
  id: 'dsh-echo', version: '1.0.1', extraRequired: ['notify@2'],
});
const ID_SWAPPED_MANIFEST = manifestJson({ id: 'dsh-rootkit', version: '1.0.1' });

const HONEST_PKG = buildPackage(HONEST_MANIFEST, entrySource('v1.0.1'));
const HONEST_TRUST = trustOf(HONEST_PKG, HONEST_MANIFEST);
const OLD_PKG = buildPackage(OLD_MANIFEST, entrySource('v0.9.0'));

// ---- the pipeline ladder ----------------------------------------------------
let rejectedCount = 0;
/** One rung: attempt must reject with `expect`, the rejection must be
 * audited, and nothing may stage. */
const rung = async (name, expect, attempt) => {
  log.debug('forgery rung', { name, expect });
  let code = null;
  let detail = null;
  try {
    await attempt();
  } catch (err) {
    if (!(err instanceof InstallRejected)) {
      fail(`${name}: rejected with a non-pipeline error: ${err}`);
      throw err;
    }
    code = err.code;
    detail = err.message;
  }
  if (code === null) {
    fail(`attack landed: ${name} installed instead of ${expect}`);
    throw new Error(name);
  }
  demand(code === expect, `${name}: expected ${expect}, got ${code} (${detail})`);
  rejectedCount += 1;
  emit('forge.case', { attack: name, expect, code });
};

const stagingAbsent = async (txId) => {
  try {
    await fsRead('app', `plugins/.staging-${txId}/manifest.json`);
    demand(false, `a rejected install staged a tree: ${txId}`);
  } catch (err) {
    demand(err.code === 'io', `expected io for staging-${txId}, got ${err.code}`);
  }
};

const main = async () => {
  if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
    fail('gateway negotiation failed');
    return;
  }
  emit('forge.started', { pipeline: 5, freshness: 1 });

  await pipelineLadder();
  const rollbackLanded = await freshnessRung();
  await controlInstall();
  emit('forge.finding', {
    severity: rollbackLanded ? 'high' : 'none',
    surface: 'catalog freshness',
    outcome: rollbackLanded ? 'catalog-replay-installed' : 'catalog-replay-rejected',
  });
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
};

/** Rungs 1–5: the pipeline forgery ladder, each rejection audited and each
 * transaction proven to have staged nothing; the journal must not exist. */
const pipelineLadder = async () => {
  // 1. escalated capability requirement + the honest (stale) trust record
  const escPkg = buildPackage(ESCALATED_MANIFEST, entrySource('v1.0.1'));
  await rung('forge.capability.stale-manifest', 'integrity', () => installPackage({
    id: 'dsh-echo', bytes: escPkg,
    trust: { blobSha256: sha256Hex(escPkg), manifestSha256: HONEST_TRUST.manifestSha256 },
    txId: 'sec-f001', on: onInstall,
  }));
  await stagingAbsent('sec-f001');

  // 2. the same escalation with fully recomputed trust — the negotiation face
  await rung('forge.capability.self-consistent', 'capability', () => installPackage({
    id: 'dsh-echo', bytes: escPkg, trust: trustOf(escPkg, ESCALATED_MANIFEST),
    txId: 'sec-f002', on: onInstall,
  }));
  await stagingAbsent('sec-f002');

  // 3. swapped entry under an identical manifest, catalog's honest anchor
  const swappedPkg = buildPackage(HONEST_MANIFEST, entrySource('ATTACKER-REPLACED'));
  await rung('forge.entry-replaced', 'integrity', () => installPackage({
    id: 'dsh-echo', bytes: swappedPkg, trust: HONEST_TRUST,
    txId: 'sec-f003', on: onInstall,
  }));
  await stagingAbsent('sec-f003');

  // 4. another package's id, self-consistent trust — the id pin
  const idPkg = buildPackage(ID_SWAPPED_MANIFEST, entrySource('v1.0.1'));
  await rung('forge.manifest-id-swap', 'manifest', () => installPackage({
    id: 'dsh-echo', bytes: idPkg, trust: trustOf(idPkg, ID_SWAPPED_MANIFEST),
    txId: 'sec-f004', on: onInstall,
  }));
  await stagingAbsent('sec-f004');

  // 5. the OLD honest package against the CURRENT catalog's trust record
  await rung('forge.version-rollback.pipeline', 'integrity', () => installPackage({
    id: 'dsh-echo', bytes: OLD_PKG, trust: HONEST_TRUST,
    txId: 'sec-f005', on: onInstall,
  }));
  await stagingAbsent('sec-f005');

  try {
    await fsRead('app', 'receipts/journal.jsonl');
    demand(false, 'the ladder wrote a receipts journal');
  } catch (err) {
    demand(err.code === 'io', `expected io for the journal, got ${err.code}`);
  }
  emit('forge.pipeline.rejected', { cases: rejectedCount });
};

/** The replay attempt against one already-built stale resolver: installs
 * (and proves the 0.9.0 tree) when the guard is absent, emits the
 * rejection code when the floor refuses it. Returns whether it landed. */
const replayAttempt = async (stale) => {
  try {
    await stale.refresh();
    const done = await stale.install({ spec: 'dsh-echo@*', txId: 'sec-f006', on: onInstall });
    const staged = await fsRead('app', 'plugins/dsh-echo@0.9.0/manifest.json');
    demand(toText(staged.bytes).includes('"version": "0.9.0"')
      || toText(staged.bytes).includes('"version":"0.9.0"'),
    'the rollback receipt names a different tree');
    emit('forge.rollback.catalog', {
      outcome: 'installed', version: done.manifest.version, via: 'catalog-replay',
    });
    return true;
  } catch (err) {
    emit('forge.rollback.catalog', {
      outcome: 'rejected', code: err.code ?? 'unknown', via: 'catalog-replay',
    });
    return false;
  }
};

/** Rung 6: the freshness face — the CURRENT catalog anchors the monotonic
 * generatedAt floor on first contact (never a brick), then the
 * stale-but-VALID catalog replays against the SAME anchor store: the floor
 * refuses it at refresh, before any install. After the rejection the
 * current catalog refreshes again — equal floor passes, the guard holds
 * no grudge. (fetchImpl is the typed httpFetch — install-fetch drains the
 * body stream.) */
const freshnessRung = async () => {
  // One anchor per device, not per resolver: BOTH resolvers share the same
  // app-scope floor — that shared floor IS the replay defense.
  const anchor = createFreshnessAnchor();
  const makeWith = (indexUrl) => {
    const fetchGet = (url) => httpFetch(url, { method: 'GET' });
    const on = (name, fields) => {
      const out = { ...fields };
      if (typeof out.url === 'string') out.url = urlPath(out.url);
      log.debug('resolver step', { name, ...out });
    };
    return createResolver({
      fetchImpl: fetchGet, indexUrl, pinnedKeys: PINNED_KEYS, anchor, on,
    });
  };
  const current = makeWith(`${INDEX_URL}/index.json`);
  const stale = makeWith(`${INDEX_URL}/index-rollback.json`);

  // First contact: no floor yet — the current catalog anchors it.
  const cur = await current.refresh();
  emit('forge.freshness.anchor', { anchored: cur.generatedAt, via: 'first-contact' });

  // The replay: older than the floor, honestly signed — refused at refresh.
  const rollbackLanded = await replayAttempt(stale);
  if (!rollbackLanded) {
    await stagingAbsent('sec-f006'); // the refused replay staged nothing
    // and the guard does not brick: the current catalog still refreshes
    const again = await current.refresh();
    demand(again.generatedAt === cur.generatedAt, 'the current catalog drifted mid-rung');
    emit('forge.freshness.honest-refresh', {
      generatedAt: again.generatedAt, outcome: 'accepted',
    });
  }
  return rollbackLanded;
};

/** The control face: honest bytes, honest trust — the pipeline serves. */
const controlInstall = async () => {
  const honest = await installPackage({
    id: 'dsh-echo', bytes: HONEST_PKG, trust: HONEST_TRUST,
    txId: 'sec-f007', on: onInstall,
  });
  emit('forge.survived', { installed: `${honest.manifest.id}@${honest.manifest.version}` });
};

await main();
