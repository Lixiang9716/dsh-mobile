// dsh:logging-exempt (dev script: console IS the product, like gen-staging-legs.mjs).
/**
 * gen-marketplace-index.mjs — build the SIGNED plugin-marketplace catalog
 * from system-plugins/ (contract/proposals/2026-10-01-plugin-marketplace.md).
 *
 * One run = one reproducible publish unit:
 *
 *   system-plugins/<pkg>/  →  DSH package "tgz" per plugin (the FROZEN
 *   format, zero changes: manifest.json verbatim at the archive root, every
 *   other file under bundle/ — exactly the layout install-pipeline.js's
 *   tarRead consumes)  →  blobSha256 (digest of the archive bytes) +
 *   manifestSha256 (digest of the packaged manifest.json) — the trust record
 *   the installer already consumes  →  index.json (schemaVersion 1,
 *   marketplace "dsh", entries mirroring the pre-download manifest fields)
 *   →  ed25519 signature over the canonical JSON of everything except the
 *   signature itself.
 *
 * BYTE FORMAT NOTE (load-bearing for the resolver): the installer pipeline
 * consumes UNCOMPRESSED POSIX ustar today — runtime/spike/tar-mini.js ships
 * "an uncompressed archive ... the gzip transport coding lands with the real
 * fetch-based installer", and install-fetch.js passes the bytes to
 * installPackage WITHOUT gunzipping. The packages produced here use the SAME
 * deterministic ustar profile (mtime 0, uid/gid 0, empty uname/gname, 100-byte
 * name field), so blobSha256 is stable run to run and the bytes install
 * as-is. If the gzip transport leg lands upstream, this generator and the
 * pin discipline must switch in lockstep.
 *
 * SIGNATURE SHAPE: a normal index carries `signature: {key, value}` exactly
 * as the proposal shows. A key-rotation WINDOW index carries `signatures`
 * (array of the same {key, value} objects) — the one additive extension the
 * proposal's rotation rule ("signed by both the outgoing and incoming key
 * for one rotation window") needs; see tools/marketplace-rotate-key.mjs.
 *
 * Key material: MARKETPLACE_SIGNING_KEY is the base64 of the 32-byte ed25519
 * SEED (what `openssl genpkey -algorithm ed25519` stores as the last 32
 * bytes of its PKCS8 DER). The public key is derived deterministically;
 * `keys` in the index carries the RAW 32-byte public key, base64
 * (`openssl pkey -pubout -outform DER | tail -c 32 | base64`).
 *
 * Catalog display summaries come from deploy/marketplace/summaries.json
 * (id → {en, zh}) — the manifest schema is frozen with
 * additionalProperties: false, so display data must NOT enter manifest.json.
 *
 * This module is importable (tools/marketplace-rotate-key.mjs reuses the
 * packing/signing halves); the CLI runs only when executed directly.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Catalog display summaries live beside the deploy tooling; resolved from
// THIS file's location so the generator runs from any working directory.
const SUMMARIES_PATH = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'deploy', 'marketplace', 'summaries.json');

const BLOCK = 512;
const PKCS8_ED25519_SEED_PREFIX = '302e020100300506032b657004220420';
const SPKI_ED25519_PREFIX = '302a300506032b6570032100';
const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY = /^[a-zA-Z][a-zA-Z0-9.-]*(@[0-9]+)?$/;
const MANIFEST_KNOWN = ['schemaVersion', 'id', 'version', 'type', 'entry', 'web',
  'capabilities', 'hooks'];

const fail = (msg) => {
  console.error(`gen-marketplace-index: ${msg}`);
  process.exit(1);
};

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Deterministic ustar writer — the SAME byte profile as tar-mini.js tarWrite
// (mtime 0, uid/gid 0, empty uname/gname, POSIX `ustar\0` magic, two zero
// terminator blocks). Ported, not imported: tar-mini.js imports the runtime's
// injected `logger.js`, which a plain Node process cannot resolve.
// ---------------------------------------------------------------------------

const octal = (value, width) => {
  const digits = value.toString(8).padStart(width - 1, '0');
  if (value.toString(8).length > width - 1) fail(`ustar field overflow (${value})`);
  return digits + '\0';
};

const putAscii = (head, at, len, text) => {
  if (text.length > len) fail(`ustar field too long (${text.length} > ${len}): ${text}`);
  for (let i = 0; i < text.length; i++) head[at + i] = text.charCodeAt(i);
};

const padToBlock = (bytes) => {
  const rest = bytes.length % BLOCK;
  if (rest === 0) return bytes;
  const out = new Uint8Array(bytes.length + (BLOCK - rest));
  out.set(bytes);
  return out;
};

/** {path, bytes} members → one ustar archive; paths are package-root
 * relative, 100-byte name field only (the reader's profile). */
const ustarWrite = (members) => {
  const chunks = [];
  for (const { path, bytes } of members) {
    if (path.length === 0 || path.startsWith('/') || path.split('/').some((s) => s === '' || s === '..')) {
      fail(`unsafe member path: ${path}`);
    }
    if (path.length > 100) fail(`member path exceeds the 100-byte ustar name field: ${path}`);
    const head = new Uint8Array(BLOCK);
    putAscii(head, 0, 100, path);
    putAscii(head, 100, 8, octal(0o644, 8));
    putAscii(head, 108, 8, octal(0, 8));
    putAscii(head, 116, 8, octal(0, 8));
    putAscii(head, 124, 12, octal(bytes.length, 12));
    putAscii(head, 136, 12, octal(0, 12));
    head[156] = '0'.charCodeAt(0);
    putAscii(head, 257, 6, 'ustar\0');
    putAscii(head, 263, 2, '00');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i < 148 || i >= 156 ? head[i] : 32;
    putAscii(head, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    chunks.push(head, padToBlock(bytes));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

// ---------------------------------------------------------------------------
// Manifest validation — mirrors install-pipeline.js validateManifest
// (schemaVersion 1, unknown fields rejected) so a broken manifest fails at
// GENERATION time, not at install time on a phone.
// ---------------------------------------------------------------------------

const capsProblem = (list, where) => {
  if (!Array.isArray(list)) return `${where}: capabilities entries must be an array`;
  const bad = list.find((c) => typeof c !== 'string' || !CAPABILITY.test(c));
  return bad ? `${where}: bad capability string ${JSON.stringify(bad)}` : null;
};

const validateManifest = (m, where) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return `${where}: manifest must be an object`;
  const unknown = Object.keys(m).find((k) => !MANIFEST_KNOWN.includes(k));
  if (unknown) return `${where}: unknown manifest field: ${unknown}`;
  if (m.schemaVersion !== 1) return `${where}: schemaVersion must be 1`;
  if (typeof m.id !== 'string' || !PKG_ID.test(m.id) || m.id.length < 3) return `${where}: bad manifest id`;
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) return `${where}: bad manifest version`;
  if (m.type !== 'service' && m.type !== 'web-client') return `${where}: type must be service|web-client`;
  if (m.type === 'service' && !(typeof m.entry === 'string' && m.entry.length > 0)) {
    return `${where}: service manifests need an entry path`;
  }
  if (m.type === 'web-client' && !(typeof m.web === 'string' && m.web.length > 0)) {
    return `${where}: web-client manifests need a web dir`;
  }
  if (!m.capabilities || typeof m.capabilities !== 'object') return `${where}: capabilities missing`;
  const badKey = Object.keys(m.capabilities).find((k) => k !== 'required' && k !== 'optional');
  if (badKey) return `${where}: unknown capabilities field: ${badKey}`;
  return capsProblem(m.capabilities.required, where)
    ?? capsProblem(m.capabilities.optional ?? [], where);
};

// ---------------------------------------------------------------------------
// Packing: system-plugins/<pkg>/ → package members → ustar bytes.
// manifest.json stays verbatim at the root; for a `service` every other file
// lands under bundle/ (the manifest entry is read from bundle/<entry>); for
// a `web-client` the manifest.web assets keep their package-root paths and
// the rest goes under bundle/. Sorted by path — the digest is stable.
// ---------------------------------------------------------------------------

const listFiles = (dir, prefix = '') => {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, rel));
    else if (ent.isFile()) out.push(rel);
    else fail(`unsupported file type in package tree: ${full}`);
  }
  return out;
};

const packageMembers = (pkgDir, manifest) => {
  const files = listFiles(pkgDir);
  const webPrefix = manifest.type === 'web-client' ? `${manifest.web}/` : null;
  return files.map((rel) => {
    let path;
    if (rel === 'manifest.json') path = rel;
    else if (webPrefix !== null && rel.startsWith(webPrefix)) path = rel;
    else path = `bundle/${rel}`;
    return { path, bytes: new Uint8Array(readFileSync(join(pkgDir, rel))) };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
};

/** One plugin directory → {name, manifest, bytes}. Fails loud on a missing
 * or invalid manifest. */
const packPlugin = (pkgDir, name) => {
  const manifestPath = join(pkgDir, 'manifest.json');
  let manifestBytes;
  try {
    manifestBytes = new Uint8Array(readFileSync(manifestPath));
  } catch {
    return fail(`plugin ${name} has no readable manifest.json (${manifestPath})`);
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch (err) {
    return fail(`plugin ${name}: manifest.json is not valid JSON: ${err}`);
  }
  const problem = validateManifest(manifest, name);
  if (problem) fail(problem);
  const bytes = ustarWrite(packageMembers(pkgDir, manifest));
  return { name, manifest, manifestBytes, bytes };
};

// ---------------------------------------------------------------------------
// Canonical JSON + ed25519 (raw 32-byte seed → PKCS8; SPKI DER tail → raw
// public key).
// ---------------------------------------------------------------------------

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const keyFromSeedB64 = (seedB64, where) => {
  let seed;
  try {
    seed = Buffer.from(seedB64, 'base64');
  } catch {
    return fail(`${where}: key material is not valid base64`);
  }
  if (seed.length !== 32) {
    return fail(`${where}: expected a 32-byte ed25519 seed, got ${seed.length} bytes`);
  }
  const der = Buffer.concat([Buffer.from(PKCS8_ED25519_SEED_PREFIX, 'hex'), seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
};

/** The RAW 32-byte public key, base64 — the `keys` map's value format. */
const pubRawB64 = (privateKey) => {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
};

const ed25519SignB64 = (privateKey, bytes) =>
  sign(null, bytes, privateKey).toString('base64');

// ---------------------------------------------------------------------------
// Index assembly.
// ---------------------------------------------------------------------------

const pluginEntry = (baseUrl, packed, summary) => ({
  id: packed.manifest.id,
  version: packed.manifest.version,
  type: packed.manifest.type,
  tgzUrl: `${baseUrl}/${packed.manifest.id}@${packed.manifest.version}.tgz`,
  // The trust record the installer already consumes — passed through
  // untouched to installFromFetch ({blobSha256, manifestSha256}).
  blobSha256: sha256Hex(packed.bytes),
  manifestSha256: sha256Hex(packed.manifestBytes),
  capabilities: {
    required: packed.manifest.capabilities.required ?? [],
    optional: packed.manifest.capabilities.optional ?? [],
  },
  summary,
});

const buildIndex = ({ packed, summaries, baseUrl, keys, generatedAt }) => {
  const entries = packed.map((p) => {
    const summary = summaries[p.manifest.id];
    if (!summary || typeof summary.en !== 'string' || typeof summary.zh !== 'string') {
      fail(`deploy/marketplace/summaries.json has no {en,zh} summary for ${p.manifest.id}`);
    }
    return pluginEntry(baseUrl, p, summary);
  });
  return { schemaVersion: 1, marketplace: 'dsh', generatedAt, keys, entries };
};

/** Attach signatures: one → `signature` (the proposal's shape); a rotation
 * window's two → `signatures` (same shape, array). Never both. */
const attachSignatures = (index, sigs) => {
  if (sigs.length === 0) fail('internal: no signatures to attach');
  if (sigs.length === 1) return { ...index, signature: sigs[0] };
  return { ...index, signatures: sigs };
};

const signWith = (index, keyId, privateKey) => ({
  key: keyId,
  value: ed25519SignB64(privateKey, Buffer.from(canonicalJson(index), 'utf8')),
});

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const USAGE = `usage:
  node tools/gen-marketplace-index.mjs --base-url <url> [options]

required:
  --base-url <url>       public URL prefix for every tgzUrl (env
                         MARKETPLACE_BASE_URL). No placeholder is ever
                         written into a signed index — missing = abort.
options:
  --system-plugins <dir> plugin tree to pack (default: system-plugins)
  --out <dir>            dist directory (default: dist/marketplace)
  --key-id <id>          signing key id in the index (default: dsh-market-1)
  --key-seed <b64>       ed25519 seed, base64 (env MARKETPLACE_SIGNING_KEY)
  --key-seed-file <path> read the seed (base64) from this file instead
  --generated-at <iso>   fixed generatedAt (reproducibility checks; default now)
  -h | --help            this text`;

const parseArgs = (argv) => {
  const opts = {
    systemPlugins: 'system-plugins', out: 'dist/marketplace', keyId: 'dsh-market-1',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--system-plugins') opts.systemPlugins = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--key-id') opts.keyId = argv[++i];
    else if (a === '--key-seed') opts.keySeed = argv[++i];
    else if (a === '--key-seed-file') opts.keySeedFile = argv[++i];
    else if (a === '--generated-at') opts.generatedAt = argv[++i];
    else fail(`unknown argument: ${a} (see --help)`);
  }
  return opts;
};

const loadSeed = (opts) => {
  if (opts.keySeedFile !== undefined) {
    return readFileSync(opts.keySeedFile, 'utf8').trim();
  }
  if (opts.keySeed !== undefined) return opts.keySeed;
  if (process.env.MARKETPLACE_SIGNING_KEY) return process.env.MARKETPLACE_SIGNING_KEY.trim();
  return fail('no signing key: pass --key-seed/--key-seed-file or set MARKETPLACE_SIGNING_KEY');
};

const resolveInput = (opts) => {
  if (opts.baseUrl === undefined) {
    return fail('no --base-url and no MARKETPLACE_BASE_URL — a signed index never ' +
      'carries a placeholder URL; configure the public catalog URL first');
  }
  const summariesPath = SUMMARIES_PATH;
  let summaries;
  try {
    summaries = JSON.parse(readFileSync(summariesPath, 'utf8'));
  } catch (err) {
    return fail(`cannot read ${summariesPath}: ${err}`);
  }
  return { summaries, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
};

/** Write the publish unit — per-plugin packages + index.json — and print
 * the digest table. Shared with tools/marketplace-rotate-key.mjs. */
const writeSignedIndex = (outDir, packed, index) => {
  mkdirSync(outDir, { recursive: true });
  for (const p of packed) {
    const file = join(outDir, `${p.manifest.id}@${p.manifest.version}.tgz`);
    writeFileSync(file, p.bytes);
    console.log(`packed   ${p.manifest.id}@${p.manifest.version}  ` +
      `${p.bytes.length} bytes  blobSha256=${sha256Hex(p.bytes)}`);
  }
  const indexPath = join(outDir, 'index.json');
  const indexText = `${JSON.stringify(index, null, 2)}\n`;
  writeFileSync(indexPath, indexText);
  console.log(`index    ${indexPath}`);
  console.log(`index    sha256=${sha256Hex(Buffer.from(indexText))}`);
};

const writeDist = (opts, packed, index) => writeSignedIndex(opts.out, packed, index);

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  const input = resolveInput(opts);
  if (!input) return;
  const root = opts.systemPlugins;
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    return fail(`cannot read plugin tree ${root}: ${err}`);
  }
  if (names.length === 0) fail(`no plugin directories under ${root}`);
  const packed = names.map((n) => packPlugin(join(root, n), n));
  const privateKey = keyFromSeedB64(loadSeed(opts), 'signing key');
  const index = buildIndex({
    packed, summaries: input.summaries, baseUrl: input.baseUrl,
    keys: { [opts.keyId]: pubRawB64(privateKey) },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  });
  const signed = attachSignatures(index, [signWith(index, opts.keyId, privateKey)]);
  writeDist(opts, packed, signed);
};

export {
  attachSignatures, buildIndex, canonicalJson, ed25519SignB64, keyFromSeedB64,
  packPlugin, pubRawB64, sha256Hex, signWith, ustarWrite, validateManifest,
  writeSignedIndex, SUMMARIES_PATH,
};

// CLI entry — only when executed directly, so rotate-key can import the
// packing/signing halves without triggering a run.
const invoked = process.argv[1] ?? '';
if (invoked.endsWith('gen-marketplace-index.mjs') || invoked.endsWith('gen-marketplace-index')) {
  main();
}
