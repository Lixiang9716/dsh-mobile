/**
 * install-pipeline — the M3 plugin install transaction (data-protocols.md §4):
 *
 *   tgz bytes → digest (sha256) → store at cache/blobs/<sha256> → verify
 *   against the caller's trust record → untar → validate manifest → build
 *   the integrity ledger → stage under .staging-<txId>/ → read-back
 *   re-verify → promote to plugins/<pkg>@<semver>/ → append the receipt
 *   (THE COMMIT POINT).
 *
 * Everything is a data operation over the frozen gateway fs primitives
 * (fsRead/fsWrite under the granted scope) — no new gateway surface, no
 * hostType branching. The trust record ({blobSha256, manifestSha256}) stands
 * in for the signed catalog a real installer consults. Atomicity: the
 * gateway fs v1 has no rename primitive, so unpack writes a
 * `.staging-<txId>/` tree, re-verifies every byte through read-back, then
 * promotes (copy) to the final directory; the committed receipt is what
 * makes the tree authoritative — a crash before it leaves an uncommitted
 * tree that startup replay must re-verify or roll back (§4 pending
 * semantics; the replay itself lands with the real profile host).
 *
 * A rejected install (digest or manifest mismatch) aborts BEFORE promotion
 * and writes NO receipt — the transaction never reached its commit point.
 *
 * The pipeline never logs scenario events itself; it reports lifecycle
 * progress through the `on(step, fields)` callback (event-driven, D8) so the
 * calling scenario owns the E2E log stream.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite } from 'gateway.js';
import { sha256Hex } from 'sha256.js';
import { tarRead } from 'tar-mini.js';

const log = createLogger('dsh.install');
const SCOPE = 'app';

/** Rejected install: the package never matched its trust record. */
export class InstallRejected extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'InstallRejected';
    this.code = code;
    this.detail = detail;
    log.debug('install rejected', { code, message });
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;
const CAPABILITY = /^[a-zA-Z][a-zA-Z0-9.-]*(@[0-9]+)?$/;
const REL_PATH = /^(?!\/)(?!(^|\/)\.\.($|\/)).+$/;

const isStr = (v) => typeof v === 'string';

/** Capability array check: strings matching the §5 grammar. */
const capsProblem = (list) => {
  log.debug('validate capabilities', { count: list.length });
  if (!Array.isArray(list)) return 'capabilities entries must be an array';
  return list.find((c) => !isStr(c) || !CAPABILITY.test(c))
    ? `bad capability string in ${JSON.stringify(list)}` : null;
};

/**
 * Minimal strict manifest validator (manifest.schema.json, schemaVersion 1):
 * required fields present, UNKNOWN fields rejected (additionalProperties
 * false — fail loud per rule 5), patterns enforced. Returns a problem string
 * or null. Reading a manifest must never execute code — this stays static.
 */
export const validateManifest = (m) => {
  log.debug('validate manifest', { id: m?.id });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest must be an object';
  const KNOWN = ['schemaVersion', 'id', 'version', 'type', 'entry', 'web', 'capabilities', 'hooks'];
  const unknown = Object.keys(m).find((k) => !KNOWN.includes(k));
  if (unknown) return `unknown manifest field: ${unknown}`;
  if (m.schemaVersion !== 1) return 'schemaVersion must be 1';
  if (!isStr(m.id) || !PKG_ID.test(m.id) || m.id.length < 3) return 'bad manifest id';
  if (!isStr(m.version) || !SEMVER.test(m.version)) return 'bad manifest version';
  if (m.type !== 'service' && m.type !== 'web-client') return 'type must be service|web-client';
  if (m.type === 'service' && !(isStr(m.entry) && REL_PATH.test(m.entry))) {
    return 'service manifests need an entry path';
  }
  if (m.type === 'web-client' && !(isStr(m.web) && REL_PATH.test(m.web))) {
    return 'web-client manifests need a web dir';
  }
  if (!m.capabilities || typeof m.capabilities !== 'object') return 'capabilities missing';
  const capKeys = Object.keys(m.capabilities).find((k) => k !== 'required' && k !== 'optional');
  if (capKeys) return `unknown capabilities field: ${capKeys}`;
  const req = capsProblem(m.capabilities.required)
    ?? capsProblem(m.capabilities.optional ?? []);
  if (req) return req;
  if (m.hooks !== undefined) {
    const hookKeys = Object.keys(m.hooks).find((k) => k !== 'activate' && k !== 'deactivate');
    if (hookKeys) return `unknown hooks field: ${hookKeys}`;
    if ([m.hooks.activate, m.hooks.deactivate].some((h) => h !== undefined && !isStr(h))) {
      return 'hooks must name exports (strings)';
    }
  }
  return null;
};

/** Bytes → text (ASCII sources; the plugin fixtures are ASCII by design). */
const decodeText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');

/** Bytes → JSON value; a malformed document is a rejected package. */
const parseJson = (bytes, what) => {
  log.debug('parse package document', { what });
  try {
    return JSON.parse(decodeText(bytes));
  } catch (err) {
    throw new InstallRejected('package', `${what} is not valid JSON: ${err}`);
  }
};

/** Build the integrity ledger (integrity.schema.json) from a file map. */
const buildLedger = (files) => {
  log.debug('build ledger', { files: Object.keys(files).length });
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, sha256Hex(bytes)]));
  return {
    ledgerVersion: 1,
    algorithm: 'sha256',
    manifestSha256: entries['manifest.json'],
    files: entries,
  };
};

/** Read a file back from storage and re-digest it (§3: hosts verify, never
 * trust the transport). */
const readBack = async (path, expectHex) => {
  log.debug('read back', { path });
  const { bytes } = await fsRead(SCOPE, path);
  const got = sha256Hex(bytes);
  if (got !== expectHex) {
    throw new InstallRejected('storage', `read-back digest drift: ${path}`, { got, expectHex });
  }
  return bytes;
};

/** The trust record is the caller's anchor on the package bytes. */
const verifyTrust = (digest, trust) => {
  log.debug('verify trust record');
  if (!trust || trust.blobSha256 !== digest) {
    throw new InstallRejected('integrity', 'package digest mismatches the trust record',
      { expected: trust?.blobSha256 ?? null, actual: digest });
  }
};

/** untar + strict manifest validation + trust-anchored ledger. */
const openPackage = (bytes, wantedId, trust, on) => {
  log.debug('open package', { bytes: bytes.length });
  const files = Object.fromEntries(tarRead(bytes).map((m) => [m.path, m.bytes]));
  if (files['manifest.json'] === undefined) {
    throw new InstallRejected('package', 'package has no manifest.json');
  }
  const manifest = parseJson(files['manifest.json'], 'manifest.json');
  const problem = validateManifest(manifest);
  if (problem) throw new InstallRejected('manifest', `manifest invalid: ${problem}`);
  on('manifest.validated', { id: manifest.id, version: manifest.version });
  if (manifest.id !== wantedId) {
    throw new InstallRejected('manifest', `manifest id ${manifest.id} != requested ${wantedId}`);
  }
  // manifest.entry is relative to bundle/ (data-protocols.md §1).
  const entryPath = `bundle/${manifest.entry}`;
  if (files[entryPath] === undefined) {
    throw new InstallRejected('package', `entry missing from package: ${entryPath}`);
  }
  const ledger = buildLedger(files);
  if (trust?.manifestSha256 !== ledger.manifestSha256) {
    throw new InstallRejected('integrity', 'manifest digest mismatches the trust record',
      { expected: trust?.manifestSha256 ?? null, actual: ledger.manifestSha256 });
  }
  on('integrity.computed', { files: Object.keys(files).length, manifestSha256: ledger.manifestSha256 });
  return { manifest, files, ledger, entryPath };
};

/** Digest + content-addressed store + verify (contract §4 steps 1-2). The
 * blob lands BEFORE the verify — an address is just data; the TRUST decision
 * is what aborts a tampered package, before anything is unpacked. */
const storeBlob = async (bytes, trust, on) => {
  const digest = sha256Hex(bytes);
  const blobPath = `cache/blobs/${digest}`;
  log.debug('store blob', { blobPath, bytes: bytes.length });
  await fsWrite(SCOPE, blobPath, bytes);
  await readBack(blobPath, digest);
  on('blob.stored', { sha256: digest, bytes: bytes.length });
  verifyTrust(digest, trust);
  on('digest.verified', { sha256: digest });
  return digest;
};

const textBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** Stage the tree, read it back byte-by-byte, verify every digest (§3). */
const stageAndVerify = async (pkgFiles, ledger, staging, treeSha, on) => {
  log.debug('stage tree', { staging, files: Object.keys(pkgFiles).length });
  for (const [rel, data] of Object.entries(pkgFiles)) {
    await fsWrite(SCOPE, `${staging}/${rel}`, data);
  }
  await fsWrite(SCOPE, `${staging}/integrity.json`, textBytes(JSON.stringify(ledger, null, 2)));
  for (const [rel, hex] of Object.entries(ledger.files)) {
    await readBack(`${staging}/${rel}`, hex);
  }
  await readBack(`${staging}/integrity.json`, treeSha);
  on('staged.verified', { files: Object.keys(ledger.files).length + 1 });
};

/** Copy the verified staging tree to its final home (no rename primitive —
 * the promotion is a read-back copy of verified bytes). */
const promote = async (staging, pkgDir, names) => {
  log.debug('promote tree', { pkgDir, files: names.length });
  for (const rel of names) {
    const { bytes } = await fsRead(SCOPE, `${staging}/${rel}`);
    await fsWrite(SCOPE, `${pkgDir}/${rel}`, bytes);
  }
};

/** Append the receipt — the commit point (§4). */
const commitReceipt = async (tx) => {
  const receipt = {
    receiptVersion: 1,
    action: 'install',
    id: tx.manifest.id,
    version: tx.manifest.version,
    blobSha256: tx.digest,
    treeSha256: tx.treeSha,
    status: 'committed',
    previousVersion: null,
    startedAt: tx.startedAt,
    committedAt: new Date().toISOString(),
  };
  const receiptPath = `receipts/${tx.txId}.json`;
  log.debug('commit receipt', { receiptPath });
  await fsWrite(SCOPE, receiptPath, textBytes(`${JSON.stringify(receipt, null, 2)}\n`));
  return { receipt, receiptPath };
};

/**
 * Run one install transaction. Args: {id, bytes, trust, txId, on} — trust =
 * {blobSha256, manifestSha256}, on = (step, fields) => void. Resolves
 * {manifest, integrity, entrySource, moduleId, digest, receipt, receiptPath,
 * blobPath, pkgDir}; rejects with InstallRejected (no receipt written — see
 * module doc) or a GatewayError from the fs primitives.
 */
export const installPackage = async ({ id, bytes, trust, txId, on = () => {} }) => {
  if (!isStr(id) || !isStr(txId)) throw new InstallRejected('invalid', 'install needs id + txId');
  log.debug('install begin', { id, txId, bytes: bytes.length });
  const startedAt = new Date().toISOString();
  const digest = await storeBlob(bytes, trust, on);
  const { manifest, files, ledger, entryPath } = openPackage(bytes, id, trust, on);
  const integrityBytes = textBytes(JSON.stringify(ledger, null, 2));
  const treeSha = sha256Hex(integrityBytes);
  const staging = `plugins/.staging-${txId}`;
  const pkgDir = `plugins/${manifest.id}@${manifest.version}`;
  await stageAndVerify(files, ledger, staging, treeSha, on);
  const names = [...Object.keys(files), 'integrity.json'];
  await promote(staging, pkgDir, names);
  on('promoted', { dir: pkgDir, files: names.length });
  const { receipt, receiptPath } = await commitReceipt(
    { manifest, digest, treeSha, txId, startedAt });
  on('committed', {
    status: receipt.status, previousVersion: receipt.previousVersion, treeSha256: receipt.treeSha256,
  });
  log.debug('install committed', { pkgDir, receiptPath });
  return {
    manifest, integrity: ledger, entrySource: files[entryPath],
    moduleId: `plugins/${manifest.id}@${manifest.version}/bundle/${manifest.entry}`,
    digest, receipt, receiptPath, blobPath: `cache/blobs/${digest}`, pkgDir,
  };
};
