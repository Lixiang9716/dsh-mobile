import { describe, it, expect, beforeEach } from 'vitest';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  fetchIndex, lookupEntry, clearIndexCache, MarketplaceRejected,
} from 'marketplace-resolver.js';
import { canonicalJson } from 'canonical-json.js';

// The resolver's rejection ladder, IN THE TREE (rule 6): node:crypto signs —
// the independent implementation — and the resolver must verify the honest
// catalog and refuse every tamper class, INCLUDING the trust-anchor story:
// with a host-side pin (proposal rule 2) a wholesale keys+index+signature
// swap refuses; without one the swap PASSES — the declared gap, asserted
// here as the honest fact it is, never papered over.

const pkcs8 = (seed) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});
const SEED = Buffer.from('3a6b7d0f1e2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e', 'hex');
const TRUSTED = pkcs8(SEED);
const PUB_B64 = Buffer.from(
  createPublicKey(TRUSTED).export({ format: 'jwk' }).x, 'base64url').toString('base64');

const buildIndex = (over = {}) => ({
  schemaVersion: 1,
  marketplace: 'dsh',
  generatedAt: '2026-10-01T00:00:00Z',
  keys: { 'dsh-market-1': PUB_B64 },
  entries: [{
    id: 'dsh-office',
    version: '0.1.0',
    type: 'service',
    tgzUrl: 'https://cdn.example.com/dsh-office@0.1.0.tgz',
    blobSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    capabilities: { required: ['fsRead'], optional: [] },
    summary: { en: 'Office suite', zh: '办公套件 — 中文摘要 ✓' },
  }],
  ...over,
});

const signIndex = (doc, key = TRUSTED) => {
  const { signature, ...rest } = doc;
  doc.signature = { key: Object.keys(doc.keys)[0], value: '' };
  doc.signature.value = sign(null, Buffer.from(canonicalJson(rest), 'utf-8'), key)
    .toString('base64');
  return doc;
};

/** One fetchImpl serving a map of url → document (the gateway httpFetch
 * response shape), counting requests for the cache assertions. */
const serve = (routes) => {
  const served = [];
  return {
    served,
    fetchImpl: async (url) => {
      served.push(url);
      const body = routes[url];
      if (body === undefined) return { status: 404, body: (async function* () {})() };
      return {
        status: 200,
        body: (async function* () { yield Buffer.from(JSON.stringify(body), 'utf-8'); })(),
      };
    },
  };
};

const rejects = async (promise, code) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceRejected);
    expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected a MarketplaceRejected('${code}') — the call succeeded`);
};

beforeEach(() => clearIndexCache());

describe('the honest catalog verifies (node:crypto-signed)', () => {
  it('fetchIndex resolves the entries and the bilingual summary survives', async () => {
    const { fetchImpl } = serve({ 'https://m.test/i.json': signIndex(buildIndex()) });
    const doc = await fetchIndex({ url: 'https://m.test/i.json', fetchImpl, pinnedKey: PUB_B64 });
    expect(doc.entries).toHaveLength(1);
    expect(lookupEntry(doc, 'dsh-office').summary.zh).toBe('办公套件 — 中文摘要 ✓');
  });

  it('lookupEntry refuses a missing package', async () => {
    const { fetchImpl } = serve({ 'https://m.test/i.json': signIndex(buildIndex()) });
    const doc = await fetchIndex({ url: 'https://m.test/i.json', fetchImpl, pinnedKey: PUB_B64 });
    await rejects(Promise.resolve().then(() => lookupEntry(doc, 'dsh-nope')), 'missing-entry');
  });
});

/** The hosting attacker's move: publish a foreign keys map + a foreign
 * self-consistent signature under the trusted key's NAME. */
const wholesaleSwap = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const foreign = buildIndex();
  foreign.keys = { 'dsh-market-1': Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'jwk' }).x, 'base64url').toString('base64') };
  const { signature, ...rest } = foreign;
  foreign.signature = {
    key: 'dsh-market-1',
    value: sign(null, Buffer.from(canonicalJson(rest), 'utf-8'), privateKey).toString('base64'),
  };
  return foreign;
};

describe('the tamper ladder (the proposal verification plan, signature family)', () => {
  it('flipped content under the real key\'s signature refuses as `signature`', async () => {
    const tampered = signIndex(buildIndex());
    tampered.entries[0].summary.en = 'TAMPERED — an attacker edited this';
    const { fetchImpl } = serve({ 'https://m.test/t.json': tampered });
    await rejects(
      fetchIndex({ url: 'https://m.test/t.json', fetchImpl, pinnedKey: PUB_B64, force: true }),
      'signature');
  });

  it('an unknown signing key refuses as `unknown-key`', async () => {
    // The signature NAMES 'stranger' — a key the index's own keys map does
    // not carry (with the pin set, the name-and-equality guard refuses
    // before any curve work; without the pin, the map lookup is the guard).
    const { privateKey } = generateKeyPairSync('ed25519');
    const doc = buildIndex();
    doc.keys = { 'dsh-market-1': PUB_B64 };
    const { signature, ...rest } = doc;
    const body = sign(null, Buffer.from(canonicalJson(rest), 'utf-8'), privateKey)
      .toString('base64');
    doc.signature = { key: 'stranger', value: body };
    const { fetchImpl } = serve({ 'https://m.test/u.json': doc });
    await rejects(
      fetchIndex({ url: 'https://m.test/u.json', fetchImpl, force: true }),
      'unknown-key');
  });

  it('a WHOLESALE keys+index+signature swap passes WITHOUT a pin — the declared gap', async () => {
    // No pin: the swap goes through — transport-plus-format trust, the
    // proposal-REJECTED alternative, present here only as the loud, logged
    // declared gap (every unpinned fetch logs the disclosure).
    const { fetchImpl } = serve({ 'https://m.test/f.json': wholesaleSwap() });
    const doc = await fetchIndex({ url: 'https://m.test/f.json', fetchImpl, force: true });
    expect(doc.entries).toHaveLength(1);
  });

  it('the same swap refuses as `unknown-key` against the host-side pin (rule 2)', async () => {
    const { fetchImpl } = serve({ 'https://m.test/f.json': wholesaleSwap() });
    await rejects(
      fetchIndex({ url: 'https://m.test/f.json', fetchImpl, pinnedKey: PUB_B64, force: true }),
      'unknown-key');
  });
});

describe('network and format rejections', () => {
  it('a non-200 fetch refuses as `network`', async () => {
    const { fetchImpl } = serve({});
    await rejects(fetchIndex({ url: 'https://m.test/none.json', fetchImpl }), 'network');
  });

  it('a non-JSON body refuses as `format`', async () => {
    const fetchImpl = async () => ({
      status: 200,
      body: (async function* () { yield Buffer.from('not json', 'utf-8'); })(),
    });
    await rejects(fetchIndex({ url: 'https://m.test/bad.json', fetchImpl }), 'format');
  });

  it('a non-http(s) index url refuses as `format` before any fetch', async () => {
    await rejects(fetchIndex({ url: 'ftp://m.test/i.json', fetchImpl: async () => {
      throw new Error('must not fetch');
    } }), 'format');
  });
});

describe('cache policy — verified documents only', () => {
  it('a cache hit does not refetch; force bypasses', async () => {
    const { fetchImpl, served } = serve({ 'https://m.test/i.json': signIndex(buildIndex()) });
    const first = await fetchIndex({ url: 'https://m.test/i.json', fetchImpl, pinnedKey: PUB_B64 });
    const second = await fetchIndex({ url: 'https://m.test/i.json', fetchImpl, pinnedKey: PUB_B64 });
    expect(second).toBe(first);
    expect(served).toHaveLength(1);
    await fetchIndex({ url: 'https://m.test/i.json', fetchImpl, pinnedKey: PUB_B64, force: true });
    expect(served).toHaveLength(2);
  });

  it('a failed verify never poisons the cache (the next honest fetch verifies)', async () => {
    const tampered = signIndex(buildIndex());
    tampered.entries[0].summary.en = 'tampered';
    const honest = signIndex(buildIndex());
    let flipped = true;
    const fetchImpl = async () => ({
      status: 200,
      body: (async function* () {
        yield Buffer.from(JSON.stringify(flipped ? tampered : honest), 'utf-8');
      })(),
    });
    await rejects(
      fetchIndex({ url: 'https://m.test/c.json', fetchImpl, pinnedKey: PUB_B64 }), 'signature');
    flipped = false;
    const doc = await fetchIndex({ url: 'https://m.test/c.json', fetchImpl, pinnedKey: PUB_B64 });
    expect(doc.entries).toHaveLength(1);
  });
});
