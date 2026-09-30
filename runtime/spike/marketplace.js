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
 */
import { createLogger } from 'logger.js';
import { InstallRejected } from 'install-pipeline.js';
import { canonicalJson } from 'canonical-json.js';
import { ed25519Verify } from 'ed25519.js';
import { installFromFetch } from 'install-fetch.js';
import { utf8Encode, utf8Decode } from 'utf8.js';

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

/** base64 → bytes (the index carries keys/signatures base64; upstream ships
 * encode only — same inline decode as gateway.js). */
const base64ToBytes = (text) => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(text).replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const rem = clean.length - i;
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | (B64.indexOf(clean[i + 2] ?? 'A') << 6) | B64.indexOf(clean[i + 3] ?? 'A');
    out.push((n >> 16) & 255);
    if (rem > 2) out.push((n >> 8) & 255);
    if (rem > 3) out.push(n & 255);
  }
  return Uint8Array.from(out);
};


/** Strict index shape check (marketplace-index.schema.json, mirrored by hand
 * the way validateManifest mirrors manifest.schema.json — no schema runtime
 * in the spike). Returns a problem string or null. */
const indexProblem = (idx) => {
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) return 'catalog must be an object';
  const KNOWN = ['schemaVersion', 'marketplace', 'generatedAt', 'keys', 'entries', 'signatures'];
  const unknown = Object.keys(idx).find((k) => !KNOWN.includes(k));
  if (unknown) return `unknown catalog field: ${unknown}`;
  if (idx.schemaVersion !== SCHEMA_VERSION) return 'schemaVersion must be 1';
  if (idx.marketplace !== 'dsh') return 'marketplace must be "dsh"';
  if (typeof idx.generatedAt !== 'string' || !idx.generatedAt) return 'generatedAt missing';
  if (!idx.keys || typeof idx.keys !== 'object' || Array.isArray(idx.keys)
    || Object.keys(idx.keys).length === 0) return 'keys map missing';
  for (const [keyId, pub] of Object.entries(idx.keys)) {
    if (!KEY_ID.test(keyId)) return `bad key id: ${keyId}`;
    if (typeof pub !== 'string' || !B64_PUB.test(pub)) return `bad public key for ${keyId}`;
  }
  if (!Array.isArray(idx.entries)) return 'entries must be an array';
  for (const e of idx.entries) {
    const EKNOWN = ['id', 'version', 'type', 'tgzUrl', 'blobSha256', 'manifestSha256',
      'capabilities', 'summary'];
    const eunknown = Object.keys(e).find((k) => !EKNOWN.includes(k));
    if (eunknown) return `unknown catalog entry field: ${eunknown}`;
    if (typeof e.id !== 'string' || !PKG_ID.test(e.id)) return `bad entry id: ${e.id}`;
    if (typeof e.version !== 'string' || !SEMVER.test(e.version)) return `bad entry version: ${e.id}`;
    if (e.type !== 'service' && e.type !== 'web-client') return `bad entry type: ${e.id}`;
    if (typeof e.tgzUrl !== 'string' || !URL.test(e.tgzUrl)) return `bad tgzUrl: ${e.id}`;
    if (typeof e.blobSha256 !== 'string' || !SHA256.test(e.blobSha256)) return `bad blobSha256: ${e.id}`;
    if (typeof e.manifestSha256 !== 'string' || !SHA256.test(e.manifestSha256)) {
      return `bad manifestSha256: ${e.id}`;
    }
    if (!e.capabilities || typeof e.capabilities !== 'object'
      || !Array.isArray(e.capabilities.required) || !Array.isArray(e.capabilities.optional)) {
      return `bad capabilities block: ${e.id}`;
    }
    const cap = (c) => typeof c === 'string' && CAPABILITY.test(c);
    if (!e.capabilities.required.every(cap) || !e.capabilities.optional.every(cap)) {
      return `bad capability string: ${e.id}`;
    }
    if (!e.summary || typeof e.summary !== 'object'
      || typeof e.summary.en !== 'string' || typeof e.summary.zh !== 'string') {
      return `bad summary block: ${e.id}`;
    }
  }
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

/** "^1.2.3" / "~1.2.3" / "1.2.3" / "*" — the lookup range grammar (v0). */
const satisfies = (version, range) => {
  const v = version.split(/[.+-]/).slice(0, 3).map(Number);
  if (range === '*' || range === '') return true;
  const m = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) throw new InstallRejected('invalid', `unsupported range: ${range}`);
  const [, op, mj, mn, pa] = m;
  const [V, M, N, Pa] = [v[0], v[1], v[2], 0];
  if (!op) return V === +mj && M === +mn && N === +pa;
  if (op === '^') return V === +mj && (M > +mn || (M === +mn && N >= +pa));
  return V === +mj && M === +mn && N >= +pa; // ~
};

/** Drain a streaming httpFetch-shape body into bytes (same shape as
 * install-fetch.js's drain). */
const drain = async (res) => {
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

const versionLess = (a, b) => {
  const pa = a.split(/[.+-]/)[0].split('.').map(Number);
  const pb = b.split(/[.+-]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
};

/**
 * Build a resolver. Args: {fetchImpl, indexUrl, pinnedKeys, on} —
 * pinnedKeys = { keyId: base64PublicKey } (the host's out-of-band pin record,
 * repo config); on = (step, fields) => void progress callback.
 * Returns {refresh, lookup, install, trustedKeyIds}.
 */
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

  // The trust set: pinned keys (out-of-band) + keys learned from verified
  // dual-signed indexes (§7.2). Session state only — never persisted.
  const trusted = new Map(Object.entries(pinnedKeys));
  let state = null; // { index, byId, verifiedUnder } after a successful refresh

  const emit = (name, fields) => on(name, fields);

  /** Fetch + verify one catalog document; on success returns the parsed
   * index and EXTENDS the trust set with newly learned keys (§7.2). */
  const fetchAndVerify = async (url) => {
    log.debug('catalog fetch begin', { url });
    emit('index.fetch.start', { urlPath: urlPathOf(url) });
    const res = await fetchImpl(url);
    if (res.status !== 200) {
      throw new InstallRejected('network', `catalog fetch ${urlPathOf(url)} status ${res.status}`,
        { status: res.status });
    }
    const bytes = await drain(res);
    emit('index.fetched', { urlPath: urlPathOf(url), bytes: bytes.length });
    log.debug('catalog fetched', { bytes: bytes.length });
    let idx;
    try {
      idx = JSON.parse(utf8Decode(bytes));
    } catch (err) {
      throw new InstallRejected('catalog', `catalog is not valid JSON: ${err}`);
    }
    const problem = indexProblem(idx);
    if (problem) throw new InstallRejected('catalog', `catalog invalid: ${problem}`);

    // §7.1: the signature covers the canonical JSON of everything except
    // `signatures`. Verify under a TRUSTED key; a signature from an
    // untrusted key never promotes the document.
    const { signatures: _drop, ...doc } = idx;
    const message = utf8Encode(canonicalJson(doc));
    const known = idx.signatures.filter((s) => trusted.has(s.key));
    if (known.length === 0) {
      throw new InstallRejected('unknown-key',
        `no catalog signature from a trusted key (signed by: ${idx.signatures.map((s) => s.key).join(', ')})`,
        { signedBy: idx.signatures.map((s) => s.key), trusted: [...trusted.keys()] });
    }
    const primary = known[0];
    const pubBytes = base64ToBytes(trusted.get(primary.key));
    if (!ed25519Verify(pubBytes, base64ToBytes(primary.value), message)) {
      throw new InstallRejected('signature', `catalog signature failed verification under ${primary.key}`,
        { key: primary.key });
    }
    emit('index.verified', {
      key: primary.key, signatures: idx.signatures.length, generatedAt: idx.generatedAt,
      entries: idx.entries.length,
    });

    // §7.2 rotation: a signature from a key we do NOT yet trust, carried by
    // an index that just verified, IS the rotation window — learn that key
    // only after its own signature verifies under the key the index
    // publishes for it. A broken second signature refuses the whole catalog.
    for (const sig of idx.signatures) {
      if (trusted.has(sig.key)) continue;
      const published = base64ToBytes(idx.keys[sig.key]);
      if (!ed25519Verify(published, base64ToBytes(sig.value), message)) {
        throw new InstallRejected('signature',
          `rotation signature failed verification under ${sig.key}`, { key: sig.key });
      }
      trusted.set(sig.key, idx.keys[sig.key]);
      log.debug('rotation key learned', { key: sig.key });
      emit('key.learned', { key: sig.key });
    }
    return idx;
  };

  /** Highest-version entry per id (the lookup's range anchor). */
  const byIdMap = (idx) => {
    const byId = new Map();
    for (const e of idx.entries) {
      const best = byId.get(e.id);
      if (!best || versionLess(best.version, e.version)) byId.set(e.id, e);
    }
    return byId;
  };

  const urlPathOf = (url) => {
    const at = url.indexOf('://');
    const slash = url.indexOf('/', at + 3);
    return slash < 0 ? '/' : url.slice(slash);
  };

  const parseSpec = (spec) => {
    const at = spec.indexOf('@');
    const id = at < 0 ? spec : spec.slice(0, at);
    const range = at < 0 ? '*' : spec.slice(at + 1);
    return { id, range };
  };

  const api = {
    /** Fetch + verify the catalog, replacing any cached state only on
     * success (a failed refresh leaves the last verified index usable).
     * `url` overrides the constructor index URL for this one refresh —
     * the §7.2 rotation observation: one resolver, one trust set, watching
     * the catalog move from the window document to the post-window one. */
    refresh: async (url) => {
      const idx = await fetchAndVerify(url ?? indexUrl);
      state = { index: idx, byId: byIdMap(idx) };
      return idx;
    },

    /** Look up "id" or "id@range" against the cached VERIFIED catalog. */
    lookup: (spec) => {
      if (!state) throw new InstallRejected('catalog', 'lookup before refresh');
      const { id, range } = parseSpec(spec);
      const entry = state.byId.get(id);
      if (!entry || !satisfies(entry.version, range)) {
        throw new InstallRejected('catalog', `no catalog entry for ${spec}`);
      }
      emit('lookup.found', {
        spec, id: entry.id, version: entry.version,
        blobSha256: entry.blobSha256, manifestSha256: entry.manifestSha256,
      });
      log.debug('lookup resolved', { spec, version: entry.version });
      return entry;
    },

    /** The marketplace install: the entry's trust record passed through
     * UNTOUCHED to the existing installFromFetch (§7.3 — the installer is
     * not modified). Args: {spec, txId, journal, on}. */
    install: async ({ spec, txId, journal = false, on: onInstall }) => {
      const resolved = api.lookup(spec);
      return await installFromFetch({
        fetchImpl,
        url: resolved.tgzUrl,
        id: resolved.id,
        trust: { blobSha256: resolved.blobSha256, manifestSha256: resolved.manifestSha256 },
        txId,
        on: onInstall ?? on,
        journal,
      });
    },

    /** The current trust set (audit/inspection). */
    trustedKeyIds: () => [...trusted.keys()],
  };
  return api;
};
