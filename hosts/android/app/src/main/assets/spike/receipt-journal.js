/**
 * receipt-journal — the receipts/ APPEND-ONLY JOURNAL and the PENDING-
 * RECEIPT STARTUP REPLAY (data-protocols.md §4): "an install interrupted
 * mid-tx leaves a PENDING receipt ... At startup the host replays every
 * pending receipt: complete the install if the staged tree verifies, else
 * roll it back and mark the receipt rolled-back. A host never leaves a
 * pending receipt unexamined."
 *
 * The gateway fs v1 has no readdir primitive, so the per-tx receipt files
 * alone cannot be enumerated; the journal file `receipts/journal.jsonl` is
 * the append-only enumeration record. Each line wraps ONE schema-valid
 * receipt (contract/schemas/receipt.schema.json — additionalProperties
 * false, so the transaction id rides an ENVELOPE field, never inside the
 * receipt): {"txId": <id>, "receipt": {…}}. The install pipeline appends
 * pending → committed; a failure after the pending receipt appends
 * rolled-back. Replay reads the journal and, for each transaction whose
 * LATEST entry is still pending:
 *
 *   - staged tree present and verifying (read-back digests match the staged
 *     integrity.json, anchored by the pending receipt's treeSha256) →
 *     promote it to plugins/<pkg>@<semver>/ and append the COMMITTED
 *     receipt (the install completes);
 *   - anything else (missing file, digest drift, unparsable ledger) →
 *     append a ROLLED-BACK receipt; the installed tree is untouched.
 *
 * `simulateCrash` is the scenario-side counterpart: it reproduces a crash
 * mid-transaction by staging a (possibly incomplete) tree and appending a
 * PENDING receipt WITHOUT promoting — the exact state §4's replay exists to
 * recover from. Committed receipts are never rewritten or deleted (§4).
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite } from 'gateway.js';
import { sha256Hex } from 'sha256.js';

const log = createLogger('dsh.receipt-journal');
const SCOPE = 'app';
export const JOURNAL_PATH = 'receipts/journal.jsonl';

const toText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');
const textBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** Append one {txId, receipt} line to the journal (fs append — the file is
 * never rewritten; §4 receipts are append-only). */
export const appendReceipt = async (txId, receipt) => {
  log.debug('journal append', { txId, status: receipt.status });
  await fsWrite(SCOPE, JOURNAL_PATH,
    textBytes(`${JSON.stringify({ txId, receipt })}\n`), { append: true });
};

/** Parse error with its 1-based journal line — fail loud, never skip. */
export class JournalError extends Error {
  constructor(line, message) {
    super(`receipt journal line ${line}: ${message}`);
    this.name = 'JournalError';
    log.debug('journal error', { line, message });
  }
}

/** Read the whole journal as [{txId, receipt}]. A missing file is an empty
 * journal (fresh install); a malformed LINE is fatal (fail loud, rule 5). */
export const readJournal = async () => {
  let text;
  try {
    const { bytes } = await fsRead(SCOPE, JOURNAL_PATH);
    text = toText(bytes);
  } catch (err) {
    log.debug('journal absent — fresh install', { code: err?.code });
    return [];
  }
  const entries = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.txId || !entry.receipt || !entry.receipt.status) {
        throw new Error('entry is not a {txId, receipt} record');
      }
      entries.push(entry);
    } catch (err) {
      throw new JournalError(i + 1, err.message);
    }
  }
  log.debug('journal read', { entries: entries.length });
  return entries;
};

/** The transactions whose LATEST journal entry is still pending, in
 * first-seen order — the startup replay's work list. */
export const pendingTransactions = (entries) => {
  log.debug('scan pending', { entries: entries.length });
  const latest = new Map();
  const order = [];
  for (const entry of entries) {
    if (!latest.has(entry.txId)) order.push(entry.txId);
    latest.set(entry.txId, entry);
  }
  return order
    .map((txId) => latest.get(txId))
    .filter((entry) => entry.receipt.status === 'pending');
};

/** Read a file and check its sha256 against `hex` (§3: verify, never trust). */
const readBackVerified = async (path, hex) => {
  log.debug('read back verified', { path });
  const { bytes } = await fsRead(SCOPE, path);
  const got = sha256Hex(bytes);
  if (got !== hex) throw new Error(`digest drift: ${path}`);
  return bytes;
};

/** Complete one pending install: verify the staged tree (anchored by the
 * pending receipt's treeSha256), promote it, append the committed receipt.
 * Throws when the staged tree does not verify. */
const recoverOne = async (entry) => {
  const { txId, receipt } = entry;
  const staging = `plugins/.staging-${txId}`;
  log.debug('recover begin', { txId, staging });
  const integBytes = await readBackVerified(`${staging}/integrity.json`, receipt.treeSha256);
  const ledger = JSON.parse(toText(integBytes));
  for (const [rel, hex] of Object.entries(ledger.files)) {
    await readBackVerified(`${staging}/${rel}`, hex);
  }
  const pkgDir = `plugins/${receipt.id}@${receipt.version}`;
  for (const rel of [...Object.keys(ledger.files), 'integrity.json']) {
    const { bytes } = await fsRead(SCOPE, `${staging}/${rel}`);
    await fsWrite(SCOPE, `${pkgDir}/${rel}`, bytes);
  }
  const committed = {
    receiptVersion: 1,
    action: 'install',
    id: receipt.id,
    version: receipt.version,
    blobSha256: receipt.blobSha256,
    treeSha256: receipt.treeSha256,
    status: 'committed',
    previousVersion: receipt.previousVersion ?? null,
    startedAt: receipt.startedAt,
    committedAt: new Date().toISOString(),
  };
  await appendReceipt(txId, committed);
  log.debug('recover committed', { txId, pkgDir });
  return committed;
};

/**
 * The STARTUP REPLAY: read the journal, examine every pending receipt, and
 * resolve each to committed or rolled-back (§4). Progress rides
 * on = (step, fields) with steps begin / committed / rolled-back / done.
 * Resolves {committed, rolledBack}.
 */
export const replayPendingReceipts = async ({ on = () => {} } = {}) => {
  const pending = pendingTransactions(await readJournal());
  log.debug('replay begin', { pending: pending.length });
  on('begin', { pending: pending.length });
  let committed = 0;
  let rolledBack = 0;
  for (const entry of pending) {
    const { txId, receipt } = entry;
    try {
      await recoverOne(entry);
      committed += 1;
      on('committed', { txId, id: receipt.id, version: receipt.version });
    } catch (err) {
      log.debug('recover failed — rolling back', { txId, error: err.message });
      await appendReceipt(txId, {
        receiptVersion: 1,
        action: 'install',
        id: receipt.id,
        version: receipt.version,
        blobSha256: receipt.blobSha256,
        treeSha256: null,
        status: 'rolled-back',
        previousVersion: receipt.previousVersion ?? null,
        startedAt: receipt.startedAt,
        committedAt: new Date().toISOString(),
      });
      rolledBack += 1;
      on('rolled-back', {
        txId, id: receipt.id, version: receipt.version, reason: 'verify-failed',
      });
    }
  }
  on('done', { committed, rolledBack });
  return { committed, rolledBack };
};

/**
 * Crash simulation for the E2E: stage `files` ({relPath: bytes}) under
 * `.staging-<txId>/` — all except paths named in `omit` (an INTERRUPTED
 * unpack) — write the matching integrity ledger, and append the PENDING
 * receipt. Nothing is promoted: exactly §4's interrupted state. Args:
 * {txId, manifest, files, blobBytes, omit} — blobBytes (the package bytes)
 * anchor the receipt's blobSha256. Resolves the pending receipt.
 */
export const simulateCrash = async ({ txId, manifest, files, blobBytes, omit = [] }) => {
  log.debug('simulate crash', { txId, omit });
  const staged = Object.fromEntries(
    Object.entries(files).filter(([rel]) => !omit.includes(rel)));
  // The ledger covers the FULL file set — an interrupted unpack means the
  // staging tree is missing bytes the ledger still vouches for, which is
  // exactly the verification failure the replay must catch.
  const digests = Object.fromEntries(
    Object.entries(files).map(([rel, bytes]) => [rel, sha256Hex(bytes)]));
  const ledger = {
    ledgerVersion: 1,
    algorithm: 'sha256',
    manifestSha256: digests['manifest.json'] ?? null,
    files: digests,
  };
  const integBytes = textBytes(JSON.stringify(ledger, null, 2));
  const staging = `plugins/.staging-${txId}`;
  for (const [rel, bytes] of Object.entries(staged)) {
    await fsWrite(SCOPE, `${staging}/${rel}`, bytes);
  }
  await fsWrite(SCOPE, `${staging}/integrity.json`, integBytes);
  const receipt = {
    receiptVersion: 1,
    action: 'install',
    id: manifest.id,
    version: manifest.version,
    blobSha256: sha256Hex(blobBytes),
    treeSha256: sha256Hex(integBytes),
    status: 'pending',
    previousVersion: null,
    startedAt: new Date().toISOString(),
    committedAt: null,
  };
  await appendReceipt(txId, receipt);
  return receipt;
};
