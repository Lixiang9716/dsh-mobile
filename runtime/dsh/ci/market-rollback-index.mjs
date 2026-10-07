// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * market-rollback-index.mjs — authors the STALE-BUT-VALID catalog for the
 * security.manifest-forgery leg: an HONEST, correctly signed old index
 * (one dsh-echo@<old> entry), built with the LANDED publisher halves
 * (packPlugin / buildIndex / attachSignatures / writeSignedIndex imported
 * from tools/gen-marketplace-index.mjs — the same code the publish workflow
 * signs with, over a fixed TEST seed). This is the replay-attack model: not
 * a forged document, but the publisher's own old catalog still circulating
 * on a compromised mirror.
 *
 * usage: node market-rollback-index.mjs <catalog-dir> <base-url> <seed-b64> <generated-at>
 *   <catalog-dir>/src/dsh-echo/ must hold the old package tree;
 *   writes <catalog-dir>/index.json (the runner renames it) + the tgz.
 */
import { join } from 'node:path';
import {
  attachSignatures, buildIndex, keyFromSeedB64, packPlugin, pubRawB64,
  signWith, writeSignedIndex,
} from '../../../tools/gen-marketplace-index.mjs';

const [catalogDir, baseUrl, seedB64, generatedAt] = process.argv.slice(2);
if (!catalogDir || !baseUrl || !seedB64 || !generatedAt) {
  console.error('usage: market-rollback-index.mjs <catalog-dir> <base-url> <seed-b64> <generated-at>');
  process.exit(2);
}

const packed = [packPlugin(join(catalogDir, 'src', 'dsh-echo'), 'dsh-echo')];
const privateKey = keyFromSeedB64(seedB64, 'test signing key');
const index = buildIndex({
  packed,
  summaries: {
    'dsh-echo': {
      en: 'TEST-ONLY stale catalog entry (the security.manifest-forgery leg)',
      zh: '仅测试用的过期目录条目(security.manifest-forgery 腿)',
    },
  },
  baseUrl,
  keys: { 'dsh-market-1': pubRawB64(privateKey) },
  generatedAt,
});
const signed = attachSignatures(index, [signWith(index, 'dsh-market-1', privateKey)]);
writeSignedIndex(catalogDir, packed, signed);
