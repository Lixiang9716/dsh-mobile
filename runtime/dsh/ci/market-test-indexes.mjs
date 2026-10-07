// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * market-test-indexes.mjs — the TAMPER-LADDER + ROTATION-DRILL catalog
 * variants for the marketplace E2E (data-protocols.md §7 verification plan).
 * Reads the HONEST index the generator wrote, then derives five named
 * variants, each a faithful model of one attack or lifecycle state:
 *
 *   index-bad-signature.json    honest index, one signature byte flipped —
 *                               the hosting tamper that breaks §7.1
 *   index-unknown-key.json      a fully SELF-CONSISTENT catalog signed by an
 *                               attacker key that lists itself in `keys` —
 *                               §7.1's "trusts no key it did not pin or
 *                               learn" is the only defense
 *   index-manifest-mismatch.json  honest key, honest bytes, but the dsh-fs
 *                               entry's manifestSha256 replaced by a wrong
 *                               digest (publisher metadata error — the §4
 *                               transaction must catch what the signature
 *                               alone cannot)
 *   index-rotation-window.json  dual-signed (dsh-market-1 + dsh-market-2) —
 *                               the §7.2 rotation window document
 *   index-rotated-final.json    single-signed by dsh-market-2 only — the
 *                               post-window catalog that a stale pin must
 *                               refuse
 *
 * The rotation keys are FIXED TEST SEEDS (the runner exports them); the real
 * marketplace keys live only in the signing CI. Signatures cover the
 * canonical JSON via the SAME canonical-json.js the resolver verifies with.
 *
 * usage: node ci/market-test-indexes.mjs <catalog-dir> <base-url> \
 *          <seed-1-hex> <seed-2-hex> <seed-atk-hex>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../../runtime/dsh/canonical-json.js';

const [dir, baseUrl, seed1, seed2, seedAtk] = process.argv.slice(2);
if (!dir || !baseUrl || !seed1 || !seed2 || !seedAtk) {
  console.error('usage: node ci/market-test-indexes.mjs <catalog-dir> <base-url> <seed1> <seed2> <seedAtk>');
  process.exit(2);
}

const keyFromSeed = (hex) => {
  const seed = Buffer.from(hex, 'hex');
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  return {
    priv,
    pubB64: createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
};
const b64Bytes = (text) => Buffer.from(text, 'base64');
const signWith = (priv, doc) => cryptoSign(null, Buffer.from(canonicalJson(doc), 'utf8'), priv);

const honest = JSON.parse(readFileSync(resolve(dir, 'index.json'), 'utf8'));
// The signature covers the canonical JSON of everything EXCEPT `signatures`
// (§7.1) — every variant is built from the stripped document, signed, and
// only then does the signatures array go back on.
const strip = ({ signatures: _drop, ...doc }) => doc;
const write = (name, doc) => {
  writeFileSync(resolve(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`market-test-indexes: wrote ${name} (${doc.signatures.map((s) => s.key).join(' + ')})`);
};

// 1. bad-signature: flip the high bit of the signature's first byte.
const badSig = structuredClone(honest);
const flipped = b64Bytes(badSig.signatures[0].value);
flipped[0] ^= 0x80;
badSig.signatures[0].value = flipped.toString('base64');
write('index-bad-signature.json', badSig);

// 2. unknown-key: a self-consistent catalog under the attacker's key.
const atk = keyFromSeed(seedAtk);
const atkDoc = { ...strip(honest), keys: { 'attacker-key-9': atk.pubB64 } };
atkDoc.signatures = [{ key: 'attacker-key-9', value: signWith(atk.priv, strip(atkDoc)).toString('base64') }];
write('index-unknown-key.json', atkDoc);

// 3. manifest-mismatch: honest key, wrong manifestSha256 on dsh-fs —
//    re-signed so the CATALOG itself verifies; the pipeline must refuse the
//    install on the trust record (publisher metadata error).
const signer1 = keyFromSeed(seed1);
const wrongManifest = strip(honest);
const entry = wrongManifest.entries.find((e) => e.id === 'dsh-fs');
entry.manifestSha256 = entry.manifestSha256.slice(0, 62) + (entry.manifestSha256.endsWith('00') ? '11' : '00');
wrongManifest.signatures = [{ key: 'dsh-market-1', value: signWith(signer1.priv, wrongManifest).toString('base64') }];
write('index-manifest-mismatch.json', wrongManifest);

// 4. rotation window: dual-signed by the outgoing and the incoming key.
const signer2 = keyFromSeed(seed2);
const window = strip(honest);
window.keys['dsh-market-2'] = signer2.pubB64;
window.signatures = [
  { key: 'dsh-market-1', value: signWith(signer1.priv, window).toString('base64') },
  { key: 'dsh-market-2', value: signWith(signer2.priv, window).toString('base64') },
];
write('index-rotation-window.json', window);

// 5. post-window: dsh-market-2 only — the stale pin must refuse this.
const final = strip(honest);
final.keys = { 'dsh-market-2': signer2.pubB64 };
final.signatures = [{ key: 'dsh-market-2', value: signWith(signer2.priv, final).toString('base64') }];
write('index-rotated-final.json', final);
