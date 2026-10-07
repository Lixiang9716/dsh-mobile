#!/usr/bin/env node
/**
 * generate-index.mjs — the marketplace v0 catalog tool (host-side, node ≥18,
 * zero dependencies). Implements the signed static index.json of
 * contract/data-protocols.md §7 (v1.1.0, FROZEN — the ADOPTED
 * contract/proposals/2026-10-01-plugin-marketplace.md folded here) over the
 * FROZEN DSH package format (data-protocols.md v1.0.0 §1–§4):
 *
 *   --keygen <prefix>   create an ed25519 test keypair (PEM files)
 *   --build …           pack system-plugins → deterministic tgz + signed index
 *   --verify <index>    verify signature + every entry's digests on disk
 *
 * Package tarball (the frozen layout, dsh fixtures show the shape):
 *   members: manifest.json (verbatim bytes) + bundle/<file> for every source
 *   file; ustar exactly as runtime/dsh/tar-mini.js writes it (mtime 0,
 *   uid/gid 0, empty uname/gname, POSIX magic) so the dsh pipeline can read
 *   these packages unchanged; then gzip with mtime 0 — bytes are
 *   reproducible run to run, which is what makes `blobSha256` meaningful.
 *
 * Trust record (the pipeline's own vocabulary, install-pipeline.js):
 *   blobSha256     = sha256 of the tgz bytes
 *   manifestSha256 = sha256 of the manifest.json member bytes
 *
 * Signature shape (FROZEN, data-protocols.md §7 v1.1.0): `signatures` is a
 * required 1..2 array of {key, value} — one entry here (the deploy standby
 * publishes single-signed); the rotation window's dual-sign shape comes
 * from tools/marketplace-rotate-key.mjs.
 *
 * Canonical JSON (what the signature covers): everything except
 * `signatures`, serialized with object keys sorted recursively, arrays in
 * order, no whitespace — UTF-8 bytes. Signer and verifier MUST share this
 * one function; it is runtime/dsh/canonical-json.js and nowhere else —
 * this tool imports it, so what the publisher signs is byte-for-byte what
 * the runtime resolver verifies.
 *
 * Keys: the repo carries a TEST pair only (deploy/marketplace/test-keys/,
 * loud "TEST ONLY" banners). The production signing key lives in CI secrets
 * — never in the repo, never on the hosting server. `keys{}` in the index
 * carries the RAW 32-byte ed25519 public key, base64 (the proposal's
 * "ed25519-pub-base64"), so verifiers need no certificate machinery.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../runtime/dsh/canonical-json.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BLOCK = 512;
const USTAR_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const die = (msg) => { console.error(`generate-index: ${msg}`); process.exit(1); };
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');

// canonicalJson comes from runtime/dsh/canonical-json.js — the one
// canonical form, one module (its fail-loud undefined rejection is the
// rule-5 discipline this tool's embedded copy pioneered).

// --- ustar writer, byte-for-byte the layout of runtime/dsh/tar-mini.js ---

const octal = (value, width) => {
  const digits = value.toString(8).padStart(width - 1, '0');
  if (digits.length > width - 1) die(`tar: field overflow (${value})`);
  return digits + '\0';
};

const tarWrite = (members) => {
  const chunks = [];
  for (const { path, bytes } of members) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')
      || path.split('/').some((seg) => seg === '' || seg === '..')) {
      die(`tar: unsafe member path: ${path}`);
    }
    if (path.length > 100) die(`tar: member name too long: ${path}`);
    const head = Buffer.alloc(BLOCK);
    head.write(path, 0, 100, 'ascii');
    head.write(octal(0o644, 8), 100); // mode
    head.write(octal(0, 8), 108); // uid
    head.write(octal(0, 8), 116); // gid
    head.write(octal(bytes.length, 12), 124); // size
    head.write(octal(0, 12), 136); // mtime 0 — deterministic
    head[156] = '0'.charCodeAt(0); // typeflag: regular file
    head.write('ustar\0', 257, 'ascii'); // POSIX magic, not GNU
    head.write('00', 263, 'ascii'); // version
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i < 148 || i >= 156 ? head[i] : 32;
    head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const padded = bytes.length % BLOCK === 0
      ? bytes
      : Buffer.concat([bytes, Buffer.alloc(BLOCK - (bytes.length % BLOCK))]);
    chunks.push(head, padded);
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // terminator
  return Buffer.concat(chunks);
};

const tarRead = (bytes) => {
  if (bytes.length % BLOCK !== 0) die('tar: size is not block-aligned');
  const members = [];
  let at = 0;
  while (at + BLOCK <= bytes.length) {
    const head = bytes.subarray(at, at + BLOCK);
    if (head.every((b) => b === 0)) break;
    let stored = 0;
    for (let i = 0; i < BLOCK; i++) stored += i < 148 || i >= 156 ? head[i] : 32;
    const claimed = parseInt(head.subarray(148, 154).toString('ascii'), 8);
    if (stored !== claimed) die(`tar: checksum drift at offset ${at}`);
    if (head.subarray(257, 262).toString('ascii') !== 'ustar') die('tar: not a ustar archive');
    const type = String.fromCharCode(head[156]);
    if (type !== '0' && type !== '\0') die(`tar: unsupported member type: ${type}`);
    const path = head.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const size = parseInt(head.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    members.push({ path, bytes: bytes.subarray(at + BLOCK, at + BLOCK + size) });
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    at += BLOCK + size + pad;
  }
  if (members.length === 0) die('tar: archive has no members');
  return members;
};

// --- ed25519 helpers (raw-key base64 in the index, PEM files on disk) ---

const rawPubB64 = (publicKey) =>
  toB64(publicKey.export({ format: 'der', type: 'spki' }).subarray(USTAR_SPKI_PREFIX.length));

const pubFromRawB64 = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) die(`index keys: expected a 32-byte raw ed25519 public key, got ${raw.length} bytes`);
  return createPublicKey({ key: Buffer.concat([USTAR_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
};

const keygen = (prefix) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(`${prefix}.pem`, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  writeFileSync(`${prefix}.pub.pem`, publicKey.export({ format: 'pem', type: 'spki' }));
  console.log(`wrote ${prefix}.pem (PRIVATE — TEST ONLY, never commit a production key)`);
  console.log(`wrote ${prefix}.pub.pem`);
  console.log(`raw public key (index keys{} value): ${rawPubB64(publicKey)}`);
};

// --- packing: system-plugins/<id>/ → site/packages/<id>@<semver>.tgz ---

/** Plugin source files are flat (index.js, …); they ship under bundle/, per
 * data-protocols.md §1 ("entry is relative to bundle/"). */
const packPlugin = (dir) => {
  const manifestBytes = readFileSync(join(dir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.type !== 'service') die(`${manifest.id}: only "service" plugins are packed in v0 (found "${manifest.type}")`);
  const sources = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && f.endsWith('.js'));
  if (!sources.includes(manifest.entry)) {
    die(`${manifest.id}: entry "${manifest.entry}" missing from plugin sources`);
  }
  const members = [
    { path: 'manifest.json', bytes: manifestBytes },
    ...sources.sort().map((f) => ({ path: `bundle/${f}`, bytes: readFileSync(join(dir, f)) })),
  ];
  // Deterministic order: lexicographic by path.
  members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tar = tarWrite(members);
  // mtime 0 + pinned level → reproducible bytes → stable blobSha256.
  const tgz = gzipSync(tar, { mtime: 0, level: 9 });
  return { manifest, manifestBytes, tgz };
};

// --- build ---

/** Scan the plugins dir + merge the catalog into index entries (each still
 * carrying its __tgz bytes for the writer). Drift fails loud (rule 5). */
const collectEntries = (pluginsDir, catalogFile, baseUrl) => {
  const catalog = JSON.parse(readFileSync(resolve(catalogFile), 'utf8'));
  const ids = readdirSync(pluginsDir).filter((f) => statSync(join(pluginsDir, f)).isDirectory()).sort();
  if (ids.length === 0) die(`no plugin directories under ${pluginsDir}`);
  const catalogIds = Object.keys(catalog).sort();
  const drift = [
    ...ids.filter((id) => !catalogIds.includes(id)).map((id) => `packaged but no catalog summary: ${id}`),
    ...catalogIds.filter((id) => !ids.includes(id)).map((id) => `catalog summary but not packaged: ${id}`),
  ];
  if (drift.length) die(`catalog drift (fail loud, rule 5):\n  ${drift.join('\n  ')}`);

  return ids.map((id) => {
    const { manifest, manifestBytes, tgz } = packPlugin(join(pluginsDir, id));
    const name = `${manifest.id}@${manifest.version}.tgz`;
    const summary = catalog[manifest.id];
    if (!summary?.en || !summary?.zh) die(`catalog[${manifest.id}] needs both "en" and "zh" summaries`);
    return {
      id: manifest.id,
      version: manifest.version,
      type: manifest.type,
      tgzUrl: `${baseUrl.replace(/\/$/, '')}/packages/${name}`,
      blobSha256: sha256Hex(tgz),
      manifestSha256: sha256Hex(manifestBytes),
      capabilities: {
        required: manifest.capabilities?.required ?? [],
        optional: manifest.capabilities?.optional ?? [],
      },
      summary: { en: summary.en, zh: summary.zh },
      __tgz: { name, bytes: tgz },
    };
  });
};

const build = (opts) => {
  const pluginsDir = resolve(opts.plugins);
  const outDir = resolve(opts.out);
  const privateKey = createPrivateKey(readFileSync(resolve(opts.key)));
  if (privateKey.asymmetricKeyType !== 'ed25519') die('--key is not an ed25519 private key');
  const publicKey = createPublicKey(privateKey);
  const entries = collectEntries(pluginsDir, opts.catalog, opts.baseUrl);

  const packagesDir = join(outDir, 'packages');
  mkdirSync(packagesDir, { recursive: true });
  for (const e of entries) {
    writeFileSync(join(packagesDir, e.__tgz.name), e.__tgz.bytes);
    console.log(`packed packages/${e.__tgz.name} (${e.__tgz.bytes.length} bytes) blob=${e.blobSha256.slice(0, 12)}…`);
  }

  const index = {
    schemaVersion: 1,
    marketplace: 'dsh',
    generatedAt: opts.generatedAt,
    keys: { [opts.keyId]: rawPubB64(publicKey) },
    entries: entries.map(({ __tgz, ...rest }) => rest),
  };
  const payload = canonicalJson(index);
  const signatureValue = toB64(sign(null, Buffer.from(payload, 'utf8'), privateKey));
  // The FROZEN signature shape (data-protocols.md §7 v1.1.0): `signatures`
  // is a required 1..2 ARRAY — the singular `signature` object this tool
  // once wrote is dead (the resolver's validator rejects it as an unknown
  // field; schemas/marketplace-index.schema.json forbids it).
  index.signatures = [{ key: opts.keyId, value: signatureValue }];
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`signed index.json (key=${opts.keyId}, entries=${entries.length}, canonical bytes=${Buffer.byteLength(payload)})`);
};

// --- verify (the honest self-check: signature first, then disk digests) ---

const verifyIndex = (indexPath) => {
  const index = JSON.parse(readFileSync(resolve(indexPath), 'utf8'));
  // The frozen `signatures` ARRAY (data-protocols.md §7): a regular index
  // carries exactly one entry. A singular `signature` object is the dead
  // pre-contract shape — refuse it loudly rather than verify it.
  if (!Array.isArray(index.signatures) || index.signatures.length !== 1) {
    die('index has no single-entry signatures[] (the frozen §7 shape)');
  }
  const [sig] = index.signatures;
  if (!sig || typeof sig.key !== 'string' || typeof sig.value !== 'string') {
    die('malformed signatures[0] entry');
  }
  const { signatures: _drop, ...rest } = index;
  const publicKey = pubFromRawB64(index.keys?.[sig.key]
    ?? die(`signature names key "${sig.key}" which is not in keys{}`));
  const payload = Buffer.from(canonicalJson(rest), 'utf8');
  const ok = verify(null, payload, publicKey, Buffer.from(sig.value, 'base64'));
  if (!ok) die('SIGNATURE INVALID — the index does not match its own signature');
  console.log(`signature valid (key=${sig.key}, canonical bytes=${payload.length})`);

  const siteDir = dirname(resolve(indexPath));
  let checked = 0;
  for (const e of index.entries) {
    const name = basename(new URL(e.tgzUrl).pathname);
    const tgz = readFileSync(join(siteDir, 'packages', name));
    if (sha256Hex(tgz) !== e.blobSha256) die(`${name}: blobSha256 mismatch (file on disk is not the indexed bytes)`);
    const manifestMember = tarRead(gunzipSync(tgz)).find((m) => m.path === 'manifest.json')
      ?? die(`${name}: no manifest.json member inside the tgz`);
    if (sha256Hex(manifestMember.bytes) !== e.manifestSha256) die(`${name}: manifestSha256 mismatch`);
    checked++;
    console.log(`entry ok: ${e.id}@${e.version} → ${name} (blob+manifest digests match)`);
  }
  console.log(`verify: ${checked}/${index.entries.length} entries, signature + disk digests all hold`);
};

// --- argv ---

const args = process.argv.slice(2);
const want = (flag) => {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) die(`${flag} needs a value`);
  return value;
};

const has = (flag) => args.includes(flag); // boolean flags
if (has('--keygen')) { keygen(want('--keygen') ?? die('--keygen needs a prefix')); process.exit(0); }
if (has('--verify')) { verifyIndex(want('--verify') ?? die('--verify needs the index path')); process.exit(0); }
if (has('--build')) {
  const opts = {
    plugins: want('--plugins') ?? die('--build needs --plugins <dir>'),
    catalog: want('--catalog') ?? die('--build needs --catalog <file>'),
    key: want('--key') ?? die('--build needs --key <private.pem>'),
    keyId: want('--key-id') ?? 'dsh-market-1',
    baseUrl: want('--base-url') ?? die('--build needs --base-url <https://…> (it is signed into every tgzUrl)'),
    out: want('--out') ?? join(SCRIPT_DIR, 'site'),
    generatedAt: want('--generated-at') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  build(opts);
  process.exit(0);
}
die('nothing to do — use --keygen <prefix>, --build …, or --verify <index.json>');
