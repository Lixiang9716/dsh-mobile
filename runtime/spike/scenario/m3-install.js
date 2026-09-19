/**
 * M3 install-pipeline scenario `m3.install` — proves "Install = data
 * operation" (docs/ARCHITECTURE.md §5) end to end on the frozen gateway fs
 * primitives, 100% platform-neutral (CLI + carrier hosts alike):
 *
 *   build the dsh-notes package tgz in JS (fixtures/, deterministic ustar)
 *   → installPackage: sha256 → cache/blobs/<sha256> → verify vs the trust
 *   record → untar → strict manifest validation → integrity ledger → stage
 *   → read-back verify → promote to plugins/<pkg>@<semver>/ → receipt
 *   → assert receipt fields + blob + unpacked layout through fsRead
 *   → load the INSTALLED entry through the ESM loader (__dshModuleDefine)
 *   and registry.js → exercise the notes service (write + read via dsh-fs)
 *   → tamper case: a second package whose bytes drift from the trust record
 *   is REJECTED before unpack (install.integrity-rejected), the installed
 *   tree stays byte-identical, and no receipt is written for the rejected
 *   transaction.
 *
 * Every expected step emits exactly one structured log entry, in the order
 * declared by tools/e2e/scenarios/m3-install.json.
 */
import { createLogger } from 'logger.js';
import { fsRead } from 'gateway.js';
import { createRegistry } from 'registry.js';
import { installPackage, InstallRejected } from 'install-pipeline.js';
import { sha256Hex } from 'sha256.js';
import * as fsPlugin from 'system-plugins/dsh-fs/index.js';
import { buildNotesTgz, NOTES_MANIFEST_BYTES } from 'fixtures/dsh-notes.js';

const SCENARIO = 'm3.install';
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
const PKG = 'dsh-notes';
const VERSION = '0.1.0';
const NOTE_TEXT = 'hello from dsh-notes';

/** Phase 1: fixture + trust record + the full install transaction. */
const installPhase = async (registry) => {
  log.debug('install phase begin');
  registry.install({ manifest: fsPlugin.manifest, module: fsPlugin });
  emit('fs.ready', { service: 'fs' });

  // The trust record stands in for the signed catalog a real installer
  // consults: the caller anchors BOTH digests before any bytes move.
  const packageBytes = buildNotesTgz();
  const trust = {
    blobSha256: sha256Hex(packageBytes),
    manifestSha256: sha256Hex(NOTES_MANIFEST_BYTES),
  };
  emit('fixture.built', { members: 2, bytes: packageBytes.length });
  emit('install.started', { pkg: PKG, version: VERSION });
  const result = await installPackage({
    id: PKG, bytes: packageBytes, trust, txId: 'm3-0001', on: onStep,
  });
  log.debug('install resolved', { pkgDir: result.pkgDir });
  return { result, trust };
};

/** Phase 2: receipt (commit point) + unpacked layout asserted through fsRead. */
const evidencePhase = async (result) => {
  log.debug('evidence phase begin', { pkgDir: result.pkgDir });
  const receipt = JSON.parse(toText((await fsRead('app', result.receiptPath)).bytes));
  demand(receipt.receiptVersion === 1 && receipt.action === 'install'
    && receipt.status === 'committed' && receipt.id === PKG && receipt.version === VERSION
    && receipt.blobSha256 === result.digest && receipt.previousVersion === null
    && /^[a-f0-9]{64}$/.test(receipt.treeSha256)
    && typeof receipt.startedAt === 'string' && typeof receipt.committedAt === 'string',
  'receipt fields drifted');
  emit('install.receipt.asserted', {
    status: receipt.status, id: receipt.id, version: receipt.version, blobSha256: receipt.blobSha256,
  });

  const manifestBytes = (await fsRead('app', `${result.pkgDir}/manifest.json`)).bytes;
  const entryBytes = (await fsRead('app', result.moduleId)).bytes;
  const ledgerBytes = (await fsRead('app', `${result.pkgDir}/integrity.json`)).bytes;
  demand(sha256Hex(manifestBytes) === result.integrity.manifestSha256, 'unpacked manifest drifted');
  demand(sha256Hex(entryBytes) === result.integrity.files['bundle/index.js'], 'unpacked entry drifted');
  const ledger = JSON.parse(toText(ledgerBytes));
  demand(ledger.ledgerVersion === 1 && ledger.algorithm === 'sha256'
    && receipt.treeSha256 === sha256Hex(ledgerBytes), 'integrity ledger drifted');
  emit('install.layout.asserted', { manifest: true, integrity: true, entry: true });
  return receipt;
};

/** Phase 3: load the INSTALLED plugin, exercise the notes service over dsh-fs. */
const exercisePhase = async (registry, result) => {
  log.debug('exercise phase begin', { moduleId: result.moduleId });
  globalThis.__dshModuleDefine(result.moduleId, toText(result.entrySource));
  const notesModule = await import(result.moduleId);
  registry.install({ manifest: result.manifest, module: notesModule });
  emit('installed.loaded', { id: result.manifest.id, moduleId: result.moduleId });

  const notes = registry.service('notes');
  const wrote = await notes.write('app', 'notes/first.txt', NOTE_TEXT);
  demand(wrote.written === NOTE_TEXT.length, 'note write byte count drifted');
  emit('notes.write.ok', { path: 'm3-install/notes/first.txt', written: wrote.written });
  const got = await notes.read('app', 'notes/first.txt');
  demand(got.text === NOTE_TEXT, 'note roundtrip drifted');
  emit('notes.read.ok', { text: got.text });
};

/** Phase 4: tamper case — drifting bytes rejected, nothing touched, no receipt. */
const tamperPhase = async (result, trust) => {
  log.debug('tamper phase begin');
  const tampered = buildNotesTgz({ tampered: true });
  emit('install.tampered.built', { bytes: tampered.length });
  let rejected = null;
  try {
    await installPackage({ id: PKG, bytes: tampered, trust, txId: 'm3-0002', on: onStep });
  } catch (err) {
    if (err instanceof InstallRejected && err.code === 'integrity') rejected = err;
    else {
      fail(`tampered package failed the wrong way: ${err}`);
      throw new Error('install pipeline misbehaved on the tamper case');
    }
  }
  demand(rejected, 'tampered package was not rejected');
  emit('install.integrity-rejected', {
    expected: rejected.detail.expected, actual: rejected.detail.actual,
  });

  const still = (await fsRead('app', `${result.pkgDir}/manifest.json`)).bytes;
  demand(sha256Hex(still) === result.integrity.manifestSha256, 'tamper touched the installed tree');
  let receipt2 = null;
  try {
    await fsRead('app', 'receipts/m3-0002.json');
  } catch (err) {
    receipt2 = err;
  }
  demand(receipt2 && receipt2.code === 'io', 'a rejected install must not write a receipt');
  emit('install.tree.intact', { verified: true });
};

const main = async () => {
  log.debug('main begin');
  emit('gateway.negotiated', { version: 'gateway@1' });
  const registry = createRegistry();
  const { result, trust } = await installPhase(registry);
  await evidencePhase(result);
  await exercisePhase(registry, result);
  await tamperPhase(result, trust);
  emit('install.completed', { status: 'pass', committed: 1, rejected: 1 });
  globalThis.__dshComplete(true, 'ok');
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  // An uncaught rejection would otherwise die silently between pumps —
  // route every failure through the scenario verdict (fail loud, rule 5).
  await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
}
