// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-marketplace.js — the MARKETPLACE legs of the COVERAGE
 * plane (2026-10-01): the phone-side dsh plugin marketplace's wire, grown
 * entirely on existing mechanisms (the web-write-onboarding.js pattern). No
 * new gateway primitive: the catalog rides the frozen httpFetch (the
 * resolver verifies its ed25519 signature — the proposal's one new seam),
 * installs run the UNCHANGED installFromFetch/install-pipeline with the
 * catalog entry's blobSha256/manifestSha256 trust record passed through,
 * and the installed view + removal read the profile's receipts journal —
 * the data plane data-protocols.md §4 already froze.
 *
 *   marketplace/index     → {marketplace, generatedAt, signature,
 *                            entries:[{id, version, type, capabilities,
 *                            summary:{en,zh}, installed}]} — the BROWSE view;
 *                            entries verbatim from the verified index plus
 *                            each entry's installed version (journal-derived).
 *   marketplace/install   (mux stream) → ONE install transaction streamed as
 *                            it happens (D8): index.verified → resolved →
 *                            the pipeline's own steps (fetch.start → … →
 *                            committed/receipt), failures one mux.error.
 *   marketplace/installed → {items:[{id, version, committedAt, treeSha256,
 *                            dir}]} — the latest committed install per id
 *                            whose record a later committed `remove` has not
 *                            replaced (receipts/journal.jsonl is the record
 *                            of truth; §4 receipts are append-only).
 *   marketplace/remove    → fsRemove of plugins/<id>@<version> THEN the
 *                            append-only `remove` receipt (§4's symmetric
 *                            action) — the receipt lands only after the tree
 *                            is gone.
 *
 * The face is claimed ONLY when the write options carry a
 * `marketplace: {indexUrl}` (a boot without one stays byte-identical and
 * answers gateway/unimplemented — the panel treats it as a capability gap,
 * the onboarding precedent).
 */
import { httpFetch, fsRemove } from '../gateway.js';
import { installFromFetch } from '../install-fetch.js';
import { InstallRejected } from '../install-pipeline.js';
import { readJournal, appendReceipt } from '../receipt-journal.js';
import {
  fetchIndex, lookupEntry, MarketplaceRejected,
} from '../marketplace-resolver.js';

const badRequest = (message) => (
  { remote: true, code: 'gateway/bad-request', message, details: {} });

/** The marketplace's GET transport: the gateway httpFetch with the method
 * spelled out (the CLI smoke backend validates url+method; real hosts take
 * the same explicit GET). Both the resolver's index fetch and the
 * installer's package fetch ride this one impl — install-fetch.js calls
 * `fetchImpl(url)` and stays unchanged. */
const fetchGet = (url) => httpFetch(url, { method: 'GET' });

/** The wire error triple for an arbitrary thrown value (the local copy the
 * onboarding legs keep — importing web-write.js would close the module
 * cycle through web-write-coverage). MarketplaceRejected/InstallRejected
 * keep their audit code as the wire code's tail. */
const wireOf = (error) => {
  if (error !== null && typeof error === 'object'
    && (error.remote === true || error.isDSHRemoteError === true)) {
    return { code: error.code, message: error.message, details: error.details ?? {} };
  }
  if (error instanceof MarketplaceRejected) {
    return { code: `marketplace/${error.code}`, message: error.message, details: error.detail ?? {} };
  }
  if (error instanceof InstallRejected) {
    return { code: `install/${error.code}`, message: error.message, details: error.detail ?? {} };
  }
  return {
    code: 'gateway/unavailable',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
};

/** The installed view from the journal: the latest record per id wins; a
 * committed install is live unless a committed remove superseded it. */
export const installedFromJournal = (entries) => {
  const latest = new Map();
  const order = [];
  for (const { receipt } of entries) {
    if (!latest.has(receipt.id)) order.push(receipt.id);
    latest.set(receipt.id, receipt);
  }
  const items = [];
  for (const id of order) {
    const r = latest.get(id);
    if (r.action === 'install' && r.status === 'committed') {
      items.push({
        id, version: r.version, committedAt: r.committedAt,
        treeSha256: r.treeSha256, blobSha256: r.blobSha256,
        dir: `plugins/${id}@${r.version}`,
      });
    }
  }
  return items;
};

/** The marketplace/index handler: the verified index's browse view, each
 * entry annotated with its installed version (never the tgzUrl — the page
 * installs by id; the resolver owns the URL). `args.force` bypasses the
 * resolver's cache (the panel's refresh). */
const makeIndexHandler = (deps) => async (args) => {
  const doc = await fetchIndex({
    url: deps.marketplace.indexUrl, fetchImpl: fetchGet,
    force: args?.force === true,
  });
  const installed = installedFromJournal(await readJournal());
  const byId = new Map(installed.map((i) => [i.id, i.version]));
  return {
    marketplace: doc.marketplace,
    generatedAt: doc.generatedAt,
    signature: { key: doc.signature.key },
    entries: doc.entries.map((e) => ({
      id: e.id,
      version: e.version,
      type: e.type,
      capabilities: e.capabilities,
      summary: e.summary,
      installed: byId.get(e.id) ?? null,
    })),
  };
};

/** The installed list handler (the journal is the record of truth). */
const makeInstalledHandler = () => async () => ({
  items: installedFromJournal(await readJournal()),
});

/** The remove handler: fsRemove the tree, THEN append the §4 remove receipt
 * (the receipt lands only after the tree is actually gone; the removed
 * install's blobSha256 rides the receipt for audit). */
const makeRemoveHandler = () => async (args) => {
  const id = args?.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw badRequest('marketplace/remove needs the package id');
  }
  const installed = installedFromJournal(await readJournal());
  const item = installed.find((i) => i.id === id);
  if (item === undefined) {
    throw { remote: true, code: 'marketplace/missing-entry',
      message: `package "${id}" is not installed`, details: {} };
  }
  await fsRemove('app', `plugins/${id}@${item.version}`, { recursive: true });
  const startedAt = new Date().toISOString();
  await appendReceipt(`rm-${Date.now()}-${id}`, {
    receiptVersion: 1,
    action: 'remove',
    id,
    version: item.version,
    blobSha256: item.blobSha256,
    treeSha256: null,
    status: 'committed',
    previousVersion: item.version,
    startedAt,
    committedAt: startedAt,
  });
  return { removed: item.version };
};

/** The coverage api rows this module owns (spread into buildCoverageApi). */
export const buildMarketplaceApi = (deps) => ({
  'marketplace/index': makeIndexHandler(deps),
  'marketplace/installed': makeInstalledHandler(deps),
  'marketplace/remove': makeRemoveHandler(deps),
});

/** The install stream: resolve from the verified index, then the REAL
 * installFromFetch over the gateway httpFetch with the entry's trust record.
 * Every pipeline step posts one mux item `{kind: step, ...fields}`; the
 * committed step resolves the stream (mux.end). The probe outlives the open
 * call (the onboarding/test pattern). */
export const openMarketplaceStream = (ctx, deps, post, msg) => {
  if (deps.marketplace === undefined) return undefined;
  if (msg.endpoint !== 'marketplace/install') return undefined;
  runInstall(post, msg, deps, msg.payload?.args).catch((error) => {
    const wire = wireOf(error);
    post({ type: 'mux.error', streamId: msg.streamId,
      code: wire.code, message: wire.message, details: wire.details });
  });
  return { kind: 'attached', endpoint: msg.endpoint };
};

const runInstall = async (post, msg, deps, args) => {
  const id = args?.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw badRequest('marketplace/install needs the package id');
  }
  const doc = await fetchIndex({ url: deps.marketplace.indexUrl, fetchImpl: fetchGet });
  post({ type: 'mux.item', streamId: msg.streamId,
    value: { kind: 'index.verified', key: doc.signature.key, entries: doc.entries.length } });
  const entry = lookupEntry(doc, id);
  post({ type: 'mux.item', streamId: msg.streamId,
    value: { kind: 'resolved', id: entry.id, version: entry.version, type: entry.type } });
  const result = await installFromFetch({
    fetchImpl: fetchGet,
    url: entry.tgzUrl,
    id: entry.id,
    trust: { blobSha256: entry.blobSha256, manifestSha256: entry.manifestSha256 },
    txId: `mkt-${Date.now()}-${entry.id}`,
    journal: true,
    on: (step, fields) => post({ type: 'mux.item', streamId: msg.streamId,
      value: { kind: step, ...fields } }),
  });
  post({ type: 'mux.item', streamId: msg.streamId,
    value: { kind: 'receipt', id: result.receipt.id, version: result.receipt.version,
      status: result.receipt.status, receiptPath: result.receiptPath,
      pkgDir: result.pkgDir } });
  post({ type: 'mux.end', streamId: msg.streamId });
};
