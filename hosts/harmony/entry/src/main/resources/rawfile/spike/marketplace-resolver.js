/**
 * marketplace-resolver — THE ONE NEW SEAM of the plugin marketplace
 * (contract proposal 2026-10-01: data-protocols v1.1.0 candidate). The
 * catalog is DATA, not a service: a signed static index.json (ed25519 over
 * the canonical JSON of everything but `signature` itself) plus package
 * tarballs on plain hosting. The resolver is the marketplace's only
 * authority:
 *
 *   fetchIndex({url, fetchImpl, now})  → the VERIFIED index document
 *     (GET over the caller's fetch impl — the gateway httpFetch in every
 *     real embed — canonical-JSON re-serialization, signature verify against
 *     the index's OWN pinned keys map, shape validation that fails loud).
 *   lookupEntry(document, id)          → the catalog entry, verbatim.
 *
 * The entries' blobSha256/manifestSha256 ARE the install pipeline's trust
 * record and are passed through UNTOUCHED (installFromFetch/install-pipeline
 * are not modified — the proposal's unchanged-seam rule). Rejections speak
 * the proposal's auditable vocabulary: network, format, unknown-key,
 * signature.
 *
 * CACHE POLICY (v0): the last verified document per URL is reused for
 * CACHE_TTL_MS, then refetched; `force: true` bypasses it (the panel's
 * refresh). The cache holds only VERIFIED documents — a failed verify never
 * poisons it. Keys map policy: the index carries its own current key set and
 * the signature must name one of THEM (a rotation is an index event, the
 * proposal's rule — no host-side pin to rotate in v0).
 */
import { createLogger } from 'logger.js';
import { ed25519Verify } from 'ed25519.js';
import { canonicalJson, utf8Bytes, utf8Text } from 'canonical-json.js';

const log = createLogger('dsh.marketplace');

/** One rejected marketplace step: the audit vocabulary of the proposal. */
export class MarketplaceRejected extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'MarketplaceRejected';
    this.code = code;
    this.detail = detail;
    log.debug('marketplace rejected', { code, message });
  }
}

/** The verified-document cache: url → { document, fetchedAt }. */
const cache = new Map();
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const clearIndexCache = () => cache.clear();

const isStr = (v) => typeof v === 'string';

/** Shape validation that fails loud (rule 5) — anything the resolver would
 * have to guess about is a format rejection naming the field. */
export const validateIndex = (doc) => {
  log.debug('validate index', { fields: doc === null ? 0 : Object.keys(doc).length });
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'index must be an object';
  }
  const KNOWN = ['schemaVersion', 'marketplace', 'generatedAt', 'keys', 'entries', 'signature'];
  const unknown = Object.keys(doc).find((k) => !KNOWN.includes(k));
  if (unknown) return `unknown index field: ${unknown}`;
  if (doc.schemaVersion !== 1) return 'schemaVersion must be 1';
  if (doc.marketplace !== 'dsh') return 'marketplace must be "dsh"';
  if (!isStr(doc.generatedAt) || Number.isNaN(Date.parse(doc.generatedAt))) {
    return 'generatedAt must be an ISO timestamp';
  }
  if (doc.keys === null || typeof doc.keys !== 'object' || Array.isArray(doc.keys)
    || Object.keys(doc.keys).length === 0
    || Object.values(doc.keys).some((v) => !isStr(v))) {
    return 'keys must be a non-empty {name: ed25519-public-base64} map';
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    return 'entries must be a non-empty array';
  }
  for (const e of doc.entries) {
    const problem = entryProblem(e);
    if (problem) return problem;
  }
  if (doc.signature === null || typeof doc.signature !== 'object'
    || !isStr(doc.signature.key) || !isStr(doc.signature.value)) {
    return 'signature must be {key, value}';
  }
  return null;
};

/** One entry's required-before-download fields (the proposal's index format). */
const entryProblem = (e) => {
  log.debug('validate entry', { id: e?.id });
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'entry must be an object';
  for (const f of ['id', 'version', 'type', 'tgzUrl']) {
    if (!isStr(e[f]) || e[f].length === 0) return `entry field ${f} must be a non-empty string`;
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(e.id)) return `entry id is not a package id: ${e.id}`;
  if (!/^https?:\/\//.test(e.tgzUrl)) return `entry tgzUrl must be http(s): ${e.id}`;
  const caps = e.capabilities;
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) {
    return `entry capabilities missing: ${e.id}`;
  }
  for (const k of ['required', 'optional']) {
    if (!Array.isArray(caps[k])) return `entry capabilities.${k} must be an array: ${e.id}`;
  }
  for (const f of ['blobSha256', 'manifestSha256']) {
    if (!/^[a-f0-9]{64}$/.test(e[f] ?? '')) return `entry ${f} missing: ${e.id}`;
  }
  if (e.summary === null || typeof e.summary !== 'object'
    || !isStr(e.summary.en) || !isStr(e.summary.zh)) {
    return `entry summary must be {en, zh}: ${e.id}`;
  }
  return null;
};

/** Drain one streaming fetch body into bytes (the install-fetch pattern). */
const drainBody = async (res, url) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  log.debug('index body drained', { url, chunks: chunks.length, bytes: total });
  return bytes;
};

/**
 * Fetch + verify one index document. Args: {url, fetchImpl, force, now}.
 * fetchImpl defaults to the gateway httpFetch; it must return
 * `{status, body: AsyncIterable}`. Resolves the VERIFIED document (cached
 * per url for CACHE_TTL_MS unless force). Rejects MarketplaceRejected with
 * the audit code: network | format | unknown-key | signature.
 */
export const fetchIndex = async ({ url, fetchImpl, force = false, now = Date.now }) => {
  if (!isStr(url) || !/^https?:\/\//.test(url)) {
    throw new MarketplaceRejected('format', `index url must be http(s): ${JSON.stringify(url)}`);
  }
  const hit = cache.get(url);
  if (!force && hit !== undefined && now() - hit.fetchedAt < CACHE_TTL_MS) {
    log.debug('index cache hit', { url });
    return hit.document;
  }
  if (typeof fetchImpl !== 'function') {
    throw new MarketplaceRejected('network', 'the marketplace needs a fetch implementation');
  }
  log.debug('index fetch begin', { url });
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new MarketplaceRejected('network', `index fetch failed: ${err?.message ?? err}`);
  }
  if (res.status !== 200) {
    throw new MarketplaceRejected('network', `index fetch status ${res.status}`, { status: res.status });
  }
  const doc = parseDocument(await drainBody(res, url), url);
  verifySignature(doc, url);
  cache.set(url, { document: doc, fetchedAt: now() });
  return doc;
};

/** Parse + shape-validate one index document. */
const parseDocument = (bytes, url) => {
  log.debug('parse index document', { bytes: bytes.length, url });
  let doc;
  try {
    doc = JSON.parse(utf8Text(bytes));
  } catch (err) {
    throw new MarketplaceRejected('format', `index is not valid JSON: ${err}`);
  }
  const problem = validateIndex(doc);
  if (problem) {
    throw new MarketplaceRejected('format', `index rejected: ${problem}`, { url });
  }
  return doc;
};

/** The signature IS the trust (proposal rule 2): the named key must be one
 * the index itself publishes, and ed25519 must verify the canonical bytes. */
const verifySignature = (doc, url) => {
  log.debug('verify index signature', { url, key: doc.signature.key });
  const publicKey = doc.keys[doc.signature.key];
  if (publicKey === undefined) {
    throw new MarketplaceRejected('unknown-key',
      `index signs with unknown key "${doc.signature.key}"`, { url });
  }
  const message = utf8Bytes(canonicalJson(docWithoutSignature(doc)));
  let ok = false;
  try {
    ok = ed25519Verify(publicKey, message, doc.signature.value);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new MarketplaceRejected('signature',
      'index signature does not verify against its published keys', { url });
  }
  log.debug('index signature verified', { url, key: doc.signature.key });
};

/** The signature field is NOT input to the canonical form. */
const docWithoutSignature = (doc) => {
  log.debug('canonical form input', { excluded: 'signature' });
  const { signature, ...rest } = doc;
  return rest;
};

/** The catalog lookup: exact package id → entry, verbatim (the trust record
 * rides untouched into the installer). */
export const lookupEntry = (document, id) => {
  log.debug('lookup entry', { id, entries: document.entries.length });
  const entry = document.entries.find((e) => e.id === id);
  if (entry === undefined) {
    throw new MarketplaceRejected('missing-entry',
      `package "${id}" is not in the marketplace index`);
  }
  return entry;
};
