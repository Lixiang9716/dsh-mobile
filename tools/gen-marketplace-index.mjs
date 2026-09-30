#!/usr/bin/env node
// dsh:logging-exempt (node-side tool: console IS the product)
/**
 * gen-marketplace-index.mjs — the signed-catalog AUTHORING tool
 * (data-protocols.md §7): packages `system-plugins/` into DSH-format
 * package tarballs and writes the signed `index.json` beside them. The
 * catalog is "authored by CI from the repo" (the adopted proposal's v0
 * model) — this script IS that authoring step, reproducible end to end:
 * deterministic ustar members (mtime 0, uid/gid 0 — the tar-mini.js wire
 * format, mirrored here byte-for-byte so the install pipeline's reader and
 * digest checks accept the tarballs), a FIXED generation stamp, and an
 * ed25519 signature over the canonical JSON of the whole document except
 * `signatures` (canonical-json.js — the SAME module the spike resolver
 * verifies with, so signer and verifier cannot drift).
 *
 * KEY MATERIAL: the private key NEVER touches the repository. It arrives
 * either as --seed <64 hex chars> (deterministic RFC 8032 keygen from a
 * 32-byte seed — for the e2e's fixed test keys) or --key-file <path> (32
 * raw bytes or 64 hex chars; keep it out of the tree — the .gitignore
 * already refuses *.pem/*.env). The script only READS key material and
 * never writes any.
 *
 * usage: node tools/gen-marketplace-index.mjs \
 *          --plugins-dir runtime/spike/system-plugins \
 *          --out-dir <dir> --base-url https://host/prefix \
 *          --generated-at 2026-10-01T00:00:00Z \
 *          --key-id dsh-market-1 (--seed <hex> | --key-file <path>) \
 *          [--rotation-signer dsh-market-2 --rotation-seed <hex>]
 *
 * --rotation-signer dual-signs the index (outgoing + incoming keys — the
 * §7.2 rotation window). Exit 0 on a written catalog; every malformed
 * input fails loud with the offending name.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../runtime/spike/canonical-json.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const usage = (msg) => {
  console.error(`gen-marketplace-index: ${msg}`);
  console.error('usage: node tools/gen-marketplace-index.mjs --plugins-dir <dir> --out-dir <dir> '
    + '--base-url <url> --generated-at <iso> --key-id <id> (--seed <hex>|--key-file <path>) '
    + '[--rotation-signer <id> --rotation-seed <hex>]');
  process.exit(2);
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) usage('bad argv');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
for (const required of ['plugins-dir', 'out-dir', 'base-url', 'generated-at', 'key-id']) {
  if (!args[required]) usage(`missing --${required}`);
}
if (!args.seed && !args['key-file']) usage('one of --seed / --key-file is required');

/** RFC 8032 ed25519 keypair from a 32-byte seed, through node's PKCS8 DER
 * prefix (302e020100300506032b657004220420 + seed). Returns {pubB64}. */
const keyFromSeed = (seedBytes) => {
  if (seedBytes.length !== 32) throw new Error(`seed must be 32 bytes, got ${seedBytes.length}`);
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), seedBytes]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv, pubB64: pub.toString('base64') };
};

const readSeed = (source, label) => {
  const raw = source.includes('/') || source.includes('.')
    ? readFileSync(resolve(source))
    : Buffer.from(source, 'hex');
  if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(raw.toString('latin1'))) {
    return Buffer.from(raw.toString('latin1'), 'hex');
  }
  if (raw.length !== 32) throw new Error(`${label}: need 32 raw bytes or 64 hex chars`);
  return raw;
};

// --- deterministic ustar writer (mirrors runtime/spike/tar-mini.js) --------
const BLOCK = 512;
const asciiBytes = (text, len) => {
  const out = new Uint8Array(len);
  for (let i = 0; i < Math.min(text.length, len); i++) out[i] = text.charCodeAt(i);
  return out;
};
const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
const pad2 = (n) => (n % BLOCK === 0 ? 0 : BLOCK - (n % BLOCK));
const tarWrite = (members) => {
  const chunks = [];
  for (const { path, bytes } of members) {
    if (path.startsWith('/') || path.split('/').some((s) => s === '' || s === '..')) {
      throw new Error(`unsafe member path: ${path}`);
    }
    const head = new Uint8Array(BLOCK);
    const put = (at, len, value) => head.set(asciiBytes(value, len), at);
    put(0, 100, path);
    put(100, 8, octal(0o644, 8)); // mode
    put(108, 8, octal(0, 8)); // uid
    put(116, 8, octal(0, 8)); // gid
    put(124, 12, octal(bytes.length, 12)); // size
    put(136, 12, octal(0, 12)); // mtime 0 — deterministic
    head[156] = '0'.charCodeAt(0); // typeflag: regular file
    put(257, 6, 'ustar\0'); // POSIX ustar magic (not GNU)
    put(263, 2, '00'); // version
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i < 148 || i >= 156 ? head[i] : 32;
    head.set(asciiBytes(sum.toString(8).padStart(6, '0') + '\0 ', 8), 148);
    chunks.push(head, bytes, new Uint8Array(pad2(bytes.length)));
  }
  chunks.push(new Uint8Array(BLOCK * 2)); // archive terminator
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
};

// --- package one plugin directory into the DSH package format --------------
const packagePlugin = (pluginDir) => {
  const manifestBytes = readFileSync(join(pluginDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.id || !manifest.version || manifest.entry === undefined) {
    throw new Error(`plugin manifest incomplete in ${pluginDir}`);
  }
  // Everything except manifest.json rides under bundle/ (data-protocols.md
  // §1: "bundle/ — JS ESM sources, entry per manifest"). Sorted for
  // deterministic member order.
  const members = [{ path: 'manifest.json', bytes: manifestBytes }];
  const walk = (rel) => {
    for (const name of readdirSync(join(pluginDir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const child = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(child);
      else if (name.isFile()) {
        members.push({ path: `bundle/${child}`, bytes: readFileSync(join(pluginDir, child)) });
      }
    }
  };
  walk('');
  if (!members.some((m) => m.path === `bundle/${manifest.entry}`)) {
    throw new Error(`manifest entry ${manifest.entry} not found in ${pluginDir}`);
  }
  return { manifest, tgz: tarWrite(members) };
};

// --- main -------------------------------------------------------------------
const pluginsDir = resolve(args['plugins-dir']);
const outDir = resolve(args['out-dir']);
const baseUrl = args['base-url'].replace(/\/+$/, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const signer = args.seed ? keyFromSeed(readSeed(args.seed, '--seed'))
  : keyFromSeed(readSeed(args['key-file'], '--key-file'));
const keyId = args['key-id'];
const keys = { [keyId]: signer.pubB64 };
const signers = [{ keyId, priv: signer.priv }];
if (args['rotation-signer']) {
  if (!args['rotation-seed']) usage('--rotation-signer needs --rotation-seed');
  const rot = keyFromSeed(readSeed(args['rotation-seed'], '--rotation-seed'));
  keys[args['rotation-signer']] = rot.pubB64;
  signers.push({ keyId: args['rotation-signer'], priv: rot.priv });
}

const entries = [];
const packages = [];
for (const name of readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
  if (!name.isDirectory()) continue;
  const { manifest, tgz } = packagePlugin(join(pluginsDir, name.name));
  const fileName = `${manifest.id}@${manifest.version}.tgz`;
  entries.push({
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    tgzUrl: `${baseUrl}/packages/${fileName}`,
    blobSha256: sha256(tgz),
    manifestSha256: sha256(readFileSync(join(pluginsDir, name.name, 'manifest.json'))),
    capabilities: {
      required: manifest.capabilities?.required ?? [],
      optional: manifest.capabilities?.optional ?? [],
    },
    summary: {
      en: `${manifest.id} ${manifest.version} — ${manifest.type} plugin (system-plugins/${name.name})`,
      zh: `${manifest.id} ${manifest.version} — ${manifest.type} 插件(system-plugins/${name.name})`,
    },
  });
  packages.push([fileName, tgz]);
}

const doc = {
  schemaVersion: 1,
  marketplace: 'dsh',
  generatedAt: args['generated-at'],
  keys,
  entries,
};
// The signature is defined over the UTF-8 bytes of the canonical JSON (§7.1)
// — Buffer's 'utf8' is the same encoding utf8.js produces on the spike side.
const canonical = Buffer.from(canonicalJson(doc), 'utf8');
const index = {
  ...doc,
  signatures: signers.map(({ keyId: id, priv }) => ({
    key: id,
    value: cryptoSign(null, canonical, priv).toString('base64'),
  })),
};

mkdirSync(join(outDir, 'packages'), { recursive: true });
for (const [fileName, bytes] of packages) writeFileSync(join(outDir, 'packages', fileName), bytes);
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`gen-marketplace-index: ${entries.length} entries, `
  + `${signers.length} signature(s) (${signers.map((s) => s.keyId).join(' + ')}), key ${keyId} `
  + `${signer.pubB64.slice(0, 12)}…`);
console.log(`gen-marketplace-index: wrote ${join(outDir, 'index.json')} + ${packages.length} package tarball(s)`);
