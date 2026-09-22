/**
 * M3 completion scenario `install.full-cycle` — the four open M3 scope items in one
 * platform-neutral E2E (CLI + carrier hosts alike):
 *
 *   1. CONFIG LAYER (ARCHITECTURE.md §6 UI-plugin level 1): a cordis.patch-
 *      style layered override (base → hostFace → profile → overlay; JSON in
 *      the spike — see config-layer.js) resolves the active Web Client and
 *      the toolbar slot ALLOW-SET; the session stack's slot gate admits the
 *      configured slot and refuses one the profile override trimmed.
 *   2. FETCH-BASED INSTALLER: the package arrives through
 *      installFromFetch(fetchImpl, …) — the streaming-body → bytes → §4
 *      pipeline path. The CLI declares httpFetch unavailable (honest
 *      descriptor), so the fetch impl is a logged SCOPE-READ STUB with the
 *      gateway httpFetch response shape (`install.fetch.stub`); the iOS
 *      carrier host runs the SAME scenario code with the REAL httpFetch
 *      (scenario install.from-http).
 *   3. PENDING-RECEIPT STARTUP REPLAY (data-protocols.md §4): two crash-
 *      simulated transactions (simulateCrash: staged tree + PENDING receipt,
 *      nothing promoted) are replayed at "startup" — the verifiable staged
 *      tree completes to COMMITTED (promoted + journal), the interrupted one
 *      ROLLS BACK with the installed tree untouched.
 *   4. INSTALL-TIME CAPABILITY NEGOTIATION: a package whose manifest
 *      REQUIRES `notify` (declared unavailable by this host's descriptor)
 *      is rejected BEFORE unpack — no staging tree, no journal growth.
 *
 * Every expected step emits exactly one structured log entry, in the order
 * declared by tools/e2e/scenarios/install-full-cycle.json.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite } from 'gateway.js';
import { createRegistry } from 'registry.js';
import { installPackage, InstallRejected } from 'install-pipeline.js';
import { installFromFetch } from 'install-fetch.js';
import { readJournal, simulateCrash, replayPendingReceipts } from 'receipt-journal.js';
import { resolveConfig, slotAllowed } from 'config-layer.js';
import { sha256Hex } from 'sha256.js';
import * as fsPlugin from 'system-plugins/dsh-fs/index.js';
import { buildNotesTgz, NOTES_MANIFEST_BYTES } from 'fixtures/dsh-notes.js';
import { NOTES_PLUGIN_SOURCE } from 'fixtures/dsh-notes-source.js';
import { buildBadgeTgz, BADGE_MANIFEST_BYTES } from 'fixtures/dsh-badge.js';

const SCENARIO = 'install.full-cycle';
const log = createLogger('m3.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const onStep = (name, fields) => emit(`install.${name}`, fields);
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
const toBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const PKG = 'dsh-notes';
const VERSION = '0.1.0';
const NOTE_TEXT = 'hello from dsh-notes';
const PKG_PATH = 'packages/dsh-notes-0.1.0.tar';
const STUB_CHUNK = 512;
const notesTrust = (bytes) => ({
  blobSha256: sha256Hex(bytes),
  manifestSha256: sha256Hex(NOTES_MANIFEST_BYTES),
});

/** Phase 1: the CONFIG LAYER resolves the session stack's Web Client and
 * toolbar slot set; the slot gate enforces the resolved allow-list. */
const configPhase = () => {
  log.debug('config phase begin');
  const { config, trace } = resolveConfig([
    { name: 'base', patch: { webClient: 'dsh-web-client', slots: { allow: ['notes.toolbar', 'debug.console'] } } },
    { name: 'hostFace', patch: {} }, // the CLI launch passes no client argument
    { name: 'profile', patch: { webClient: 'dsh-web-client-mini', slots: { allow: ['notes.toolbar'] } } },
    { name: 'overlay', patch: {} },
  ]);
  for (const { layer, keys } of trace) emit('config.layer', { layer, keys });
  demand(config.webClient === 'dsh-web-client-mini', 'profile did not select the mini client');
  emit('config.resolved', {
    webClient: config.webClient, slots: config.slots.allow, format: 'cordis.patch.json',
  });
  demand(slotAllowed(config, 'notes.toolbar'), 'configured slot refused');
  emit('config.slot.allowed', { id: 'notes.toolbar' });
  demand(!slotAllowed(config, 'debug.console'), 'profile override did not trim the slot set');
  emit('config.slot.denied', { id: 'debug.console', allow: config.slots.allow });
  return config;
};

/** One chunk of the stub's streaming body per runtime-queue tick (D8) —
 * extracted so the response shape below stays a flat literal. */
const chunkIterator = (chunks) => {
  let next = 0;
  return {
    next: async () => {
      await null; // each chunk settles on its own runtime-queue tick (D8)
      log.debug('stub chunk yield', { index: next });
      return next < chunks.length
        ? { value: chunks[next++], done: false }
        : { value: undefined, done: true };
    },
  };
};

/** The CLI's fetch implementation: a logged SCOPE-READ STUB with the exact
 * gateway httpFetch response shape (status + streaming AsyncIterable body).
 * The desktop smoke backend declares httpFetch unavailable, honestly — the
 * streaming path is still exercised, chunk by chunk. */
const scopeFetchStub = async (uri) => {
  log.debug('stub fetch', { uri });
  const match = /^scope:\/\/app\/(.+)$/.exec(uri);
  demand(match, `stub fetch cannot handle ${uri}`);
  const { bytes } = await fsRead('app', match[1]);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += STUB_CHUNK) {
    chunks.push(bytes.subarray(at, Math.min(at + STUB_CHUNK, bytes.length)));
  }
  log.debug('stub fetch body ready', { chunks: chunks.length });
  return {
    status: 200,
    body: { [Symbol.asyncIterator]: () => chunkIterator(chunks) },
  };
};

/** Phase 2: FETCH-BASED INSTALL — the package bytes ride the streaming body
 * into the §4 pipeline, with the receipt journal recording pending →
 * committed. Then the installed plugin is loaded and exercised. */
const fetchInstallPhase = async (registry, packageBytes) => {
  log.debug('fetch install phase begin');
  registry.install({ manifest: fsPlugin.manifest, module: fsPlugin });
  emit('fs.ready', { service: 'fs' });

  emit('fixture.built', { members: 2, bytes: packageBytes.length });
  await fsWrite('app', PKG_PATH, packageBytes); // the "server" side of the stub
  emit('install.fetch.stub', {
    via: 'scope-read', path: PKG_PATH, chunks: Math.ceil(packageBytes.length / STUB_CHUNK),
  });
  const result = await installFromFetch({
    fetchImpl: scopeFetchStub,
    url: `scope://app/${PKG_PATH}`,
    id: PKG,
    trust: notesTrust(packageBytes),
    txId: 'm3-c001',
    on: onStep,
    journal: true,
  });

  const receipt = JSON.parse(toText((await fsRead('app', result.receiptPath)).bytes));
  demand(receipt.status === 'committed' && receipt.id === PKG && receipt.version === VERSION
    && receipt.blobSha256 === result.digest, 'receipt fields drifted');
  const journal = await readJournal();
  demand(journal.length === 2 && journal[0].txId === 'm3-c001'
    && journal[0].receipt.status === 'pending' && journal[1].receipt.status === 'committed',
  'journal pending→committed order drifted');
  emit('install.receipt.asserted', {
    status: receipt.status, id: receipt.id, version: receipt.version,
    blobSha256: receipt.blobSha256, journalLines: journal.length,
  });

  globalThis.__dshModuleDefine(result.moduleId, toText(result.entrySource));
  registry.install({ manifest: result.manifest, module: await import(result.moduleId) });
  emit('installed.loaded', { id: result.manifest.id, moduleId: result.moduleId });
  const notes = registry.service('notes');
  const wrote = await notes.write('app', 'notes/first.txt', NOTE_TEXT);
  demand(wrote.written === NOTE_TEXT.length, 'note write byte count drifted');
  emit('notes.write.ok', { path: 'install-verified-tarball/notes/first.txt', written: wrote.written });
  const got = await notes.read('app', 'notes/first.txt');
  demand(got.text === NOTE_TEXT, 'note roundtrip drifted');
  emit('notes.read.ok', { text: got.text });
  return result;
};

/** Phase 3: INSTALL-TIME CAPABILITY NEGOTIATION — a package requiring
 * `notify` (declared unavailable by this host) is rejected BEFORE unpack. */
const negotiationPhase = async (result) => {
  log.debug('negotiation phase begin');
  const badgeBytes = buildBadgeTgz();
  emit('install.badge.built', { bytes: badgeBytes.length });
  let rejected = null;
  try {
    await installPackage({
      id: 'dsh-badge',
      bytes: badgeBytes,
      trust: { blobSha256: sha256Hex(badgeBytes), manifestSha256: sha256Hex(BADGE_MANIFEST_BYTES) },
      txId: 'm3-c003',
      on: onStep,
    });
  } catch (err) {
    if (err instanceof InstallRejected && err.code === 'capability') rejected = err;
    else {
      fail(`under-privileged package failed the wrong way: ${err}`);
      throw new Error('negotiation misbehaved');
    }
  }
  demand(rejected, 'under-privileged package was not rejected');
  emit('install.capability-rejected', {
    missing: rejected.detail.missing, required: 3,
  });
  // Rejected BEFORE unpack: no staging tree, and the journal never grew.
  try {
    await fsRead('app', 'plugins/.staging-m3-c003/manifest.json');
    demand(false, 'a capability-rejected package must not stage');
  } catch (err) {
    demand(err.code === 'io', `expected io error, got ${err.code}`);
  }
  demand((await readJournal()).length === 2, 'a rejected install must not touch the journal');
  const still = (await fsRead('app', `${result.pkgDir}/manifest.json`)).bytes;
  demand(sha256Hex(still) === result.integrity.manifestSha256, 'rejection touched the tree');
  emit('install.tree.intact', { verified: true });
};

/** Phase 4: PENDING-RECEIPT STARTUP REPLAY — two crash-simulated installs
 * (staged tree + pending receipt, nothing promoted), then the §4 replay:
 * the verifiable tree completes, the interrupted one rolls back. */
const replayPhase = async (result, packageBytes) => {
  log.debug('replay phase begin');
  const files = {
    'manifest.json': NOTES_MANIFEST_BYTES,
    'bundle/index.js': toBytes(NOTES_PLUGIN_SOURCE),
  };
  const common = { manifest: result.manifest, files, blobBytes: packageBytes };
  await simulateCrash({ txId: 'm3-c004', ...common });
  emit('crash.simulated', { txId: 'm3-c004', mode: 'staged-verifies', files: 2 });
  await simulateCrash({ txId: 'm3-c005', ...common, omit: ['bundle/index.js'] });
  emit('crash.simulated', { txId: 'm3-c005', mode: 'staging-incomplete', files: 1 });

  const summary = await replayPendingReceipts({
    on: (name, fields) => emit(`replay.${name}`, fields),
  });
  demand(summary.committed === 1 && summary.rolledBack === 1, 'replay summary drifted');

  const replayed = JSON.parse(toText((await fsRead(
    'app', 'plugins/dsh-notes@0.1.0/integrity.json')).bytes));
  demand(sha256Hex(NOTES_MANIFEST_BYTES) === replayed.manifestSha256,
    'replayed tree drifted');
  const journal = await readJournal();
  const lastFor = (txId) => journal.filter((e) => e.txId === txId).pop();
  demand(lastFor('m3-c004').receipt.status === 'committed',
    'replayed transaction must end committed');
  demand(lastFor('m3-c005').receipt.status === 'rolled-back',
    'interrupted transaction must roll back');
  emit('replay.receipt.asserted', {
    txId: 'm3-c004', status: 'committed', journalLines: journal.length,
  });
  const still = (await fsRead('app', `${result.pkgDir}/manifest.json`)).bytes;
  demand(sha256Hex(still) === result.integrity.manifestSha256,
    'rollback touched the installed tree');
  emit('replay.tree.intact', { verified: true });
};

const main = async () => {
  log.debug('main begin');
  emit('gateway.negotiated', { version: 'gateway@1' });
  configPhase();
  const registry = createRegistry();
  const packageBytes = buildNotesTgz();
  const result = await fetchInstallPhase(registry, packageBytes);
  await negotiationPhase(result);
  await replayPhase(result, packageBytes);
  emit('install.completed', { status: 'pass', committed: 2, rejected: 1, rolledBack: 1 });
  globalThis.__dshComplete(true, 'ok');
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  // An uncaught rejection would otherwise die silently between pumps —
  // route every failure through the scenario verdict (fail loud, rule 5).
  await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
}
