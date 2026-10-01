// dsh:logging-exempt (node-side driver: its stdout IS the product — the
// runner reads the endpoint announce from it)
/**
 * mock-market-server.mjs — node-side lifecycle for the marketplace e2e's
 * loopback catalog (scenario `marketplace.ui.flow`). The catalog is DATA,
 * not a service — this node http server stands in for the plain file hosting
 * the proposal names (object storage / GitHub Releases): one signed static
 * index.json plus the package tarball, both built ONCE at startup.
 *
 * The index is SIGNED with ed25519 by node:crypto/OpenSSL — an INDEPENDENT
 * implementation the runtime's pure-JS verifier must agree with (the same
 * oracle discipline as test/panel). The key is a FIXED test-only seed (never
 * a secret; the runner greps that neither the seed nor the private DER ever
 * reaches the capture). The package is a plain POSIX ustar (tar-mini.js's
 * frozen format — the spike ships uncompressed archives, no gzip), built
 * here with a ~40-line ustar writer so the node side owns zero runtime code.
 *
 * Routes: GET /index.json (signed catalog), GET /packages/<file> (tgz).
 * Announces MARKET_BASE_URL=... on stdout (condition-polled by the runner,
 * rule 8); one JSON telemetry line per request (diagnostics only).
 *
 * usage: node mock-market-server.mjs
 */
import { createServer } from 'node:http';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { canonicalJson } from '../canonical-json.js';

// The fixed test-only seed (this file is its only home; never a secret).
const SEED = Buffer.from('3a6b7d0f1e2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, SEED]), format: 'der', type: 'pkcs8' });
const pubJwk = createPublicKey(key).export({ format: 'jwk' });
const PUB_B64 = Buffer.from(pubJwk.x, 'base64url').toString('base64');

// ---- the package (POSIX ustar, tar-mini.js's frozen format) ----------------

const PKG = { id: 'dsh-market-demo', version: '0.1.0' };
const MANIFEST = {
  schemaVersion: 1,
  id: PKG.id,
  version: PKG.version,
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['gateway@1'], optional: [] },
};
const manifestBytes = Buffer.from(`${JSON.stringify(MANIFEST, null, 2)}\n`, 'utf-8');
const entryBytes = Buffer.from(
  '// dsh-market-demo — the marketplace e2e\'s honest fixture plugin.\n'
  + 'export const demo = () => "hello from the marketplace";\n', 'utf-8');

const octal = (value, len) => value.toString(8).padStart(len - 1, '0') + '\0';
const tarMember = (path, bytes) => {
  const head = Buffer.alloc(512);
  head.write(path, 0);
  head.write(octal(0o644, 8), 100);
  head.write(octal(0, 8), 108);
  head.write(octal(0, 8), 116);
  head.write(octal(bytes.length, 12), 124);
  head.write(octal(0, 12), 136);
  head.write('        ', 148); // checksum placeholder (spaces)
  head.write('0', 156);
  head.write('ustar\0', 257);
  head.write('00', 263);
  let sum = 0;
  for (const b of head) sum += b;
  // The checksum field is 6 octal digits + NUL + space (tar-mini reads
  // exactly the six digits; a 7-digit form corrupts the parse).
  head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([head, bytes, pad]);
};
const tgz = Buffer.concat([
  tarMember('manifest.json', manifestBytes),
  tarMember('bundle/index.js', entryBytes),
  Buffer.alloc(1024),
]);

// ---- the signed index (canonical JSON of everything but `signature`) ------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const blobSha256 = sha256(tgz);
const manifestSha256 = sha256(manifestBytes);

// A SECOND, FOREIGN keypair — the tamper ladder's attacker (an attacker
// controlling the hosting can replace keys + index + signature wholesale;
// the host-side pin is what refuses them).
const foreignSeed = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
const foreignKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, foreignSeed]), format: 'der', type: 'pkcs8' });
const FOREIGN_PUB_B64 = Buffer.from(
  createPublicKey(foreignKey).export({ format: 'jwk' }).x, 'base64url').toString('base64');

const index = {
  schemaVersion: 1,
  marketplace: 'dsh',
  generatedAt: '2026-10-01T00:00:00Z',
  keys: { 'dsh-market-1': PUB_B64 },
  entries: [{
    id: PKG.id,
    version: PKG.version,
    type: 'service',
    tgzUrl: 'SET-AT-STARTUP',
    blobSha256,
    manifestSha256,
    capabilities: MANIFEST.capabilities,
    summary: {
      en: 'The marketplace demo plugin — a harmless service fixture',
      zh: '市场演示插件 — 一个无害的服务示例',
    },
  }],
  signature: { key: 'dsh-market-1', value: '' },
};

// ---- the server ------------------------------------------------------------

let indexBody = null;
let tamperedBody = null;
let foreignBody = null;
const start = createServer((req, res) => {
  const url = req.url ?? '';
  console.log(JSON.stringify({ served: url }));
  // Explicit content-length everywhere: the CLI smoke httpFetch backend is a
  // minimal HTTP/1.1 reader (connection: close, no de-chunker), so the
  // catalog must not ride chunked transfer coding.
  if (url === '/index.json') {
    res.writeHead(200, { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(indexBody) });
    res.end(indexBody);
    return;
  }
  // The tamper ladder (the proposal's verification plan): a flipped summary
  // under the REAL key's signature — the canonical form no longer matches,
  // so the signature check must refuse it.
  if (url === '/index-tampered.json') {
    res.writeHead(200, { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(tamperedBody) });
    res.end(tamperedBody);
    return;
  }
  // A WHOLESALE swap: foreign keys map + foreign signature — well-formed and
  // self-consistent, and exactly what a hosting attacker ships. Only the
  // host-side pin refuses it.
  if (url === '/index-foreign.json') {
    res.writeHead(200, { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(foreignBody) });
    res.end(foreignBody);
    return;
  }
  if (url === `/packages/${PKG.id}@${PKG.version}.tgz`) {
    res.writeHead(200, { 'content-type': 'application/x-tar', 'content-length': tgz.length });
    res.end(tgz);
    return;
  }
  res.writeHead(404, { 'content-length': 9 });
  res.end('not found');
});

start.listen(0, '127.0.0.1', () => {
  const { port } = start.address();
  const base = `http://127.0.0.1:${port}`;
  // The tgzUrl is the announce's own loopback base — the catalog is
  // reproducible from the repository, the hosting is wherever this points.
  index.entries[0].tgzUrl = `${base}/packages/${PKG.id}@${PKG.version}.tgz`;
  const signIndex = (doc, signingKey) => {
    const { signature, ...rest } = doc;
    doc.signature.value = sign(null, Buffer.from(canonicalJson(rest), 'utf-8'), signingKey)
      .toString('base64');
    return JSON.stringify(doc, null, 2);
  };
  indexBody = signIndex(index, key);
  // The tamper ladder's bodies (built once at startup, served above).
  // TAMPERED = the signed catalog with one content byte flipped and the
  // ORIGINAL signature kept — an attacker edits the hosting, they cannot
  // re-sign — so the canonical form no longer matches and the signature
  // check must refuse it.
  const tampered = JSON.parse(JSON.stringify(index));
  tampered.entries[0].summary.en = 'TAMPERED — an attacker edited this summary';
  tamperedBody = JSON.stringify(tampered, null, 2);
  // FOREIGN = a wholesale keys+index+signature swap: well-formed and
  // self-consistent under the attacker's key — exactly what a hosting
  // attacker ships. Only the host-side pin refuses it.
  const foreign = JSON.parse(JSON.stringify(index));
  foreign.keys = { 'dsh-market-1': FOREIGN_PUB_B64 };
  foreignBody = signIndex(foreign, foreignKey);
  console.log(`MARKET_BASE_URL=${base}`);
});

const close = () => start.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
// keep the event loop alive waiting for the CLI's requests
setInterval(() => {}, 3600000).unref?.();
