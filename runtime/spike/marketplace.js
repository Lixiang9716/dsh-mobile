/**
 * marketplace — THE RESOLVER SEAM of the plugin marketplace (data-protocols.md
 * §7, proposal 2026-10-01-plugin-marketplace.md ADOPTED): signed-catalog
 * lookup feeding the UNCHANGED install transaction.
 *
 *   createResolver({ fetchImpl, indexUrl, pinnedKeys, on })
 *     .refresh()               → fetch index over httpFetch + ed25519 verify
 *     .lookup("id@range")      → the verified entry (highest version in range)
 *     .install("id", {…})      → entry's {tgzUrl, blobSha256, manifestSha256}
 *                                passed THROUGH to the existing installFromFetch
 *
 * The trust boundary is the SIGNATURE, not the transport: the index is
 * verified with an ed25519 key the host pinned out-of-band (repo config —
 * the vendor-pin-table discipline) or learned from a DUAL-SIGNED verified
 * index (§7.2 rotation). The signature covers the canonical JSON of the
 * whole index except `signatures` (canonical-json.js — the same module the
 * generator signs with), so the entries' {blobSha256, manifestSha256} —
 * exactly the pipeline's trust record — are covered too; the resolver hands
 * them to installFromFetch UNTOUCHED and the §4 transaction re-derives both
 * from the served bytes. Tampered hosting can therefore never produce an
 * installable package.
 *
 * Rejections are the installer's InstallRejected vocabulary (each auditable
 * through the `on` callback by the calling scenario):
 *   'signature'    a known key's signature failed verification, or the index
 *                  carries a signature that does not verify under its own key
 *   'unknown-key'  no signature from a trusted key (a self-consistent catalog
 *                  signed by an attacker key; a rotation completed outside the
 *                  observed window against a stale pin — §7.2)
 *   'catalog'      malformed index, or no entry for the requested id@range
 *   'network'      non-200 from the catalog host
 *   'integrity'    (from the pipeline) served bytes ≠ the signed trust record
 *
 * The fetchImpl is a PARAMETER (D5/D8 — no hostType branching), same
 * discipline as install-fetch.js: a carrier host passes the real gateway
 * httpFetch, the CLI passes the same shape. Cache policy (§7 resolver seam):
 * the verified index and the learned keys are SESSION state — refresh()
 * replaces the cached index only after FULL verification (a failed refresh
 * leaves the previous verified state installable), and a restart drops the
 * learned keys so a stale pin can never shortcut the rotation window.
 *
 * Shape note: the resolver is a flat module-scope state bag (`env`) with
 * free functions — no closure factory — so every function stays under the
 * size gate's span and the state transitions stay readable top to bottom.
 *
 * Sibling note: marketplace-resolver.js (the marketplace-UI face's cached
 * fetch/lookup, merged in #288) and THIS module are deliberately separate:
 * the UI face needs browse-with-cache; the contract face needs the §7.2
 * rotation trust set, the pinned-key SET, and the §7.3 install passthrough.
 * They share ed25519.js + canonical-json.js — one verifier, one codec — so
 * the trust core cannot drift; folding the two resolvers is the named
 * simplification once the UI face needs rotation.
 */
import { createLogger } from 'logger.js';
import { InstallRejected } from 'install-pipeline.js';
import { canonicalJson, utf8Bytes, utf8Text } from 'canonical-json.js';
import { ed25519Verify } from 'ed25519.js';
import { installFromFetch } from 'install-fetch.js';
import { satisfies, versionLess } from 'semver-range.js';

const log = createLogger('dsh.marketplace');

const SCHEMA_VERSION = 1;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;
const KEY_ID = /^[a-z0-9][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const B64_PUB = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const B64_SIG = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
const URL = /^https?:\/\//;
const CAPABILITY = /^[a-zA-Z][a-zA-Z0-9.-]*(@[0-9]+)?$/;
const ENTRY_FIELDS = ['id', 'version', 'type', 'tgzUrl', 'blobSha256', 'manifestSha256',
  'capabilities', 'summary'];
const INDEX_FIELDS = ['schemaVersion', 'marketplace', 'generatedAt', 'keys', 'entries',
  'signatures'];

/** One catalog entry's shape (marketplace-index.schema.json, mirrored by
 * hand the way validateManifest mirrors manifest.schema.json — no schema
 * runtime in the spike). Returns a problem string or null. */
const entryProblem = (e) => {
  log.debug('validate catalog entry', { id: e?.id });
  const unknown = Object.keys(e).find((k) => !ENTRY_FIELDS.includes(k));
  if (unknown) return `unknown catalog entry field: ${unknown}`;
  if (typeof e.id !== 'string' || !PKG_ID.test(e.id)) return `bad entry id: ${e.id}`;
  if (typeof e.version !== 'string' || !SEMVER.test(e.version)) return `bad entry version: ${e.id}`;
  if (e.type !== 'service' && e.type !== 'web-client') return `bad entry type: ${e.id}`;
  if (typeof e.tgzUrl !== 'string' || !URL.test(e.tgzUrl)) return `bad tgzUrl: ${e.id}`;
  if (typeof e.blobSha256 !== 'string' || !SHA256.test(e.blobSha256)) return `bad blobSha256: ${e.id}`;
  if (typeof e.manifestSha256 !== 'string' || !SHA256.test(e.manifestSha256)) {
    return `bad manifestSha256: ${e.id}`;
  }
  const caps = e.capabilities;
  if (!caps || typeof caps !== 'object'
    || !Array.isArray(caps.required) || !Array.isArray(caps.optional)) {
    return `bad capabilities block: ${e.id}`;
  }
  const cap = (c) => typeof c === 'string' && CAPABILITY.test(c);
  if (!caps.required.every(cap) || !caps.optional.every(cap)) {
    return `bad capability string: ${e.id}`;
  }
  if (!e.summary || typeof e.summary !== 'object'
    || typeof e.summary.en !== 'string' || typeof e.summary.zh !== 'string') {
    return `bad summary block: ${e.id}`;
  }
  return null;
};

/** The keys map's shape: keyId → ed25519 public key (base64). */
const keysProblem = (keys) => {
  log.debug('validate catalog keys', { count: keys ? Object.keys(keys).length : 0 });
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)
    || Object.keys(keys).length === 0) return 'keys map missing';
  for (const [keyId, pub] of Object.entries(keys)) {
    if (!KEY_ID.test(keyId)) return `bad key id: ${keyId}`;
    if (typeof pub !== 'string' || !B64_PUB.test(pub)) return `bad public key for ${keyId}`;
  }
  return null;
};

/** The signatures array's shape: one or two {key, value} entries, each
 * naming a key of the keys map. */
const signaturesProblem = (idx) => {
  log.debug('validate catalog signatures', { count: idx.signatures?.length });
  if (!Array.isArray(idx.signatures) || idx.signatures.length < 1 || idx.signatures.length > 2) {
    return 'signatures must carry one or two entries';
  }
  for (const s of idx.signatures) {
    if (!s || typeof s !== 'object' || Object.keys(s).length !== 2
      || typeof s.key !== 'string' || !KEY_ID.test(s.key)
      || typeof s.value !== 'string' || !B64_SIG.test(s.value)) {
      return 'malformed signature entry';
    }
    if (!(s.key in idx.keys)) return `signature names a key outside the keys map: ${s.key}`;
  }
  return null;
};

/** Strict index shape check. Returns a problem string or null. */
const indexProblem = (idx) => {
  log.debug('validate catalog', { entries: idx?.entries?.length });
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) return 'catalog must be an object';
  const unknown = Object.keys(idx).find((k) => !INDEX_FIELDS.includes(k));
  if (unknown) return `unknown catalog field: ${unknown}`;
  if (idx.schemaVersion !== SCHEMA_VERSION) return 'schemaVersion must be 1';
  if (idx.marketplace !== 'dsh') return 'marketplace must be "dsh"';
  if (typeof idx.generatedAt !== 'string' || !idx.generatedAt) return 'generatedAt missing';
  return keysProblem(idx.keys)
    ?? (Array.isArray(idx.entries) ? null : 'entries must be an array')
    ?? idx.entries.map(entryProblem).find((p) => p)
    ?? signaturesProblem(idx);
};

/** Highest-version entry per id (the lookup's range anchor). */
const byIdMap = (idx) => {
  log.debug('index entries by id', { entries: idx.entries.length });
  const byId = new Map();
  for (const e of idx.entries) {
    const best = byId.get(e.id);
    if (!best || versionLess(best.version, e.version)) byId.set(e.id, e);
  }
  return byId;
};

/** Drain a streaming httpFetch-shape body into bytes (same shape as
 * install-fetch.js's drain). */
const drain = async (res) => {
  log.debug('catalog body drain begin');
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
  return bytes;
};

const urlPathOf = (url) => {
  log.debug('url path projection', { url });
  const at = url.indexOf('://');
  const slash = url.indexOf('/', at + 3);
  return slash < 0 ? '/' : url.slice(slash);
};

/** §7.1: verify the catalog's PRIMARY signature under a key the host
 * already trusts. A signature from an untrusted key never promotes the
 * document. Throws InstallRejected('unknown-key' | 'signature'). */
const verifyPrimarySignature = (idx, env) => {
  log.debug('verify primary signature', { candidates: idx.signatures.length });
  const { signatures: _drop, ...doc } = idx;
  const message = utf8Bytes(canonicalJson(doc));
  env.message = message; // reused by the rotation learner below
  const known = idx.signatures.filter((s) => env.trusted.has(s.key));
  if (known.length === 0) {
    throw new InstallRejected('unknown-key',
      `no catalog signature from a trusted key (signed by: ${idx.signatures.map((s) => s.key).join(', ')})`,
      { signedBy: idx.signatures.map((s) => s.key), trusted: [...env.trusted.keys()] });
  }
  const primary = known[0];
  if (!ed25519Verify(env.trusted.get(primary.key), message, primary.value)) {
    throw new InstallRejected('signature', `catalog signature failed verification under ${primary.key}`,
      { key: primary.key });
  }
  return primary;
};

/** §7.2 rotation: a signature from a key we do NOT yet trust, carried by an
 * index that just verified, IS the rotation window — learn that key only
 * after its own signature verifies under the key the index publishes for
 * it. A broken second signature refuses the whole catalog. */
const learnRotationKeys = (idx, env) => {
  for (const sig of idx.signatures) {
    if (env.trusted.has(sig.key)) continue;
    if (!ed25519Verify(idx.keys[sig.key], env.message, sig.value)) {
      throw new InstallRejected('signature',
        `rotation signature failed verification under ${sig.key}`, { key: sig.key });
    }
    env.trusted.set(sig.key, idx.keys[sig.key]);
    log.debug('rotation key learned', { key: sig.key });
    env.on('key.learned', { key: sig.key });
  }
};

/** Fetch one catalog document, validate its shape, verify its signature,
 * learn any rotation keys. Returns the parsed index. */
const fetchAndVerify = async (env, url) => {
  log.debug('catalog fetch begin', { url });
  env.on('index.fetch.start', { urlPath: urlPathOf(url) });
  const res = await env.fetchImpl(url);
  if (res.status !== 200) {
    throw new InstallRejected('network', `catalog fetch ${urlPathOf(url)} status ${res.status}`,
      { status: res.status });
  }
  const bytes = await drain(res);
  env.on('index.fetched', { urlPath: urlPathOf(url), bytes: bytes.length });
  log.debug('catalog fetched', { bytes: bytes.length });
  let idx;
  try {
    idx = JSON.parse(utf8Text(bytes));
  } catch (err) {
    throw new InstallRejected('catalog', `catalog is not valid JSON: ${err}`);
  }
  const problem = indexProblem(idx);
  if (problem) throw new InstallRejected('catalog', `catalog invalid: ${problem}`);
  const primary = verifyPrimarySignature(idx, env);
  env.on('index.verified', {
    key: primary.key, signatures: idx.signatures.length, generatedAt: idx.generatedAt,
    entries: idx.entries.length,
  });
  learnRotationKeys(idx, env);
  return idx;
};

const parseSpec = (spec) => {
  log.debug('parse lookup spec', { spec });
  const at = spec.indexOf('@');
  return {
    id: at < 0 ? spec : spec.slice(0, at),
    range: at < 0 ? '*' : spec.slice(at + 1),
  };
};

/** Look up "id" or "id@range" against the cached VERIFIED catalog. */
const lookupEntry = (env, spec) => {
  if (!env.state) throw new InstallRejected('catalog', 'lookup before refresh');
  const { id, range } = parseSpec(spec);
  const entry = env.state.byId.get(id);
  if (!entry || !satisfies(entry.version, range)) {
    throw new InstallRejected('catalog', `no catalog entry for ${spec}`);
  }
  env.on('lookup.found', {
    spec, id: entry.id, version: entry.version,
    blobSha256: entry.blobSha256, manifestSha256: entry.manifestSha256,
  });
  log.debug('lookup resolved', { spec, version: entry.version });
  return entry;
};

/**
 * Build a resolver. Args: {fetchImpl, indexUrl, pinnedKeys, on} —
 * pinnedKeys = { keyId: base64PublicKey } (the host's out-of-band pin
 * record, repo config); on = (step, fields) => void progress callback.
 * Returns {refresh, lookup, install, trustedKeyIds}.
 */
/** The resolver's session state bag (buildEnv + the api below keep every
 * span small; the state transitions read top to bottom at module scope). */
const buildEnv = ({ fetchImpl, indexUrl, pinnedKeys, on }) => ({
  fetchImpl,
  indexUrl,
  on,
  // The trust set: pinned keys (out-of-band) + keys learned from verified
  // dual-signed indexes (§7.2). Session state only — never persisted.
  trusted: new Map(Object.entries(pinnedKeys)),
  state: null, // { index, byId } after a successful refresh
  message: null, // the verified document's canonical bytes (rotation)
});

/** refresh(): fetch + verify the catalog, replacing the cached state only
 * on success (a failed refresh leaves the last verified index usable).
 * `url` overrides the constructor index URL for this one refresh — the
 * §7.2 rotation observation: one resolver, one trust set, watching the
 * catalog move from the window document to the post-window one. */
const refresh = async (env, url) => {
  log.debug('refresh begin', { url: url ?? env.indexUrl });
  const idx = await fetchAndVerify(env, url ?? env.indexUrl);
  env.state = { index: idx, byId: byIdMap(idx) };
  return idx;
};

/** install(): the entry's trust record passed through UNTOUCHED to the
 * existing installFromFetch (§7.3 — the installer is not modified). */
const installResolved = async (env, { spec, txId, journal = false, on: onInstall }) => {
  log.debug('marketplace install begin', { spec, txId, journal });
  const resolved = lookupEntry(env, spec);
  return await installFromFetch({
    fetchImpl: env.fetchImpl,
    url: resolved.tgzUrl,
    id: resolved.id,
    trust: { blobSha256: resolved.blobSha256, manifestSha256: resolved.manifestSha256 },
    txId,
    on: onInstall ?? env.on,
    journal,
  });
};

export const createResolver = ({ fetchImpl, indexUrl, pinnedKeys, on = () => {} }) => {
  if (typeof fetchImpl !== 'function') {
    throw new InstallRejected('invalid', 'createResolver needs a fetchImpl');
  }
  if (typeof indexUrl !== 'string' || !URL.test(indexUrl)) {
    throw new InstallRejected('invalid', `bad index url: ${indexUrl}`);
  }
  if (!pinnedKeys || typeof pinnedKeys !== 'object' || Object.keys(pinnedKeys).length === 0) {
    throw new InstallRejected('invalid', 'createResolver needs pinnedKeys (the host pin record)');
  }
  log.debug('resolver built', { indexUrl, pinned: Object.keys(pinnedKeys) });
  const env = buildEnv({ fetchImpl, indexUrl, pinnedKeys, on });
  return {
    refresh: (url) => refresh(env, url),
    lookup: (spec) => lookupEntry(env, spec),
    install: (args) => installResolved(env, args),
    /** The current trust set (audit/inspection). */
    trustedKeyIds: () => [...env.trusted.keys()],
  };
};
