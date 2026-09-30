// dsh:logging-exempt (dev script: console IS the product, like gen-staging-legs.mjs).
/**
 * marketplace-rotate-key.mjs — the ed25519 key rotation runbook for the
 * plugin marketplace (contract/proposals/2026-10-01-plugin-marketplace.md:
 * "a rotation publishes a new index signed by both the outgoing and incoming
 * key for one rotation window, then drops the outgoing one").
 *
 * Two subcommands:
 *
 *   gen          — generate a fresh ed25519 pair; prints the SEED (the
 *                  MARKETPLACE_SIGNING_KEY secret value) and the raw public
 *                  key (the value that lands in the index `keys` map). The
 *                  seed is shown once — store it in the secret before
 *                  leaving the output.
 *
 *   window-index — build the DUAL-SIGNED rotation-window index from
 *                  system-plugins/: `keys` carries BOTH keys, `signatures`
 *                  (array) carries both ed25519 signatures over the same
 *                  canonical JSON. A host pinning the outgoing key accepts
 *                  this index (its pinned key's signature verifies) and
 *                  learns the incoming key from `keys` — hosts learn
 *                  rotations ONLY from dual-signed indexes. After the window
 *                  the next REGULAR publish (gen-marketplace-index.mjs with
 *                  the new secret) drops the outgoing key.
 *
 * THE ROTATION RUNBOOK (each step verified by its own evidence):
 *   1. `gen --key-id dsh-market-2` — keep the printed seed for step 3.
 *   2. `window-index --new-key-id dsh-market-2 --base-url …` and deploy the
 *      window index (hosts now pin old + learn new).
 *   3. Flip the MARKETPLACE_SIGNING_KEY secret to the new seed.
 *   4. The next regular publish signs with the new key only — the outgoing
 *      key leaves `keys` and the window closes. A host that never fetched
 *      the dual-signed index (stale pin) now rejects — the proposal's
 *      rotation drill makes that rejection an audited InstallRejected, not
 *      a silent failure.
 *
 * Signing shape: a single signature is `signature: {key, value}` (the
 * proposal's example); the dual-sign window is `signatures: [...]` — the
 * one additive extension the rotation rule needs (see the generator header).
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  attachSignatures, buildIndex, packPlugin, pubRawB64, keyFromSeedB64,
  signWith, writeSignedIndex, SUMMARIES_PATH,
} from './gen-marketplace-index.mjs';

const KEY_ID = /^[a-z0-9][a-z0-9.-]*$/;

const fail = (msg) => {
  console.error(`marketplace-rotate-key: ${msg}`);
  process.exit(1);
};

const USAGE = `usage:
  node tools/marketplace-rotate-key.mjs gen [--key-id <id>]
  node tools/marketplace-rotate-key.mjs window-index --base-url <url>
      --new-key-id <id> [options]

gen: generate a fresh ed25519 pair. Prints the seed (the new
     MARKETPLACE_SIGNING_KEY value — shown once) and the raw public key.

window-index: build and write the dual-signed rotation-window index
     (keys: outgoing + incoming; signatures: both). Options:
  --current-seed <b64>    outgoing key seed (env MARKETPLACE_SIGNING_KEY)
  --current-seed-file <p> read the outgoing seed from a file instead
  --new-seed <b64>        incoming seed (from a prior 'gen'; generated when
                          absent and printed again)
  --new-key-id <id>       incoming key id (required; must differ from the
                          current one; default current id's number + 1 when
                          it ends in -<digits>)
  --base-url <url>        public URL prefix for every tgzUrl (required)
  --system-plugins <dir>  plugin tree (default: system-plugins)
  --out <dir>             dist directory (default: dist/marketplace)
  --generated-at <iso>    fixed timestamp (reproducibility checks)`;

const parseArgs = (argv, opts) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const known = ['--key-id', '--current-seed', '--current-seed-file', '--new-seed',
      '--new-key-id', '--base-url', '--system-plugins', '--out', '--generated-at'];
    const hit = known.find((k) => a === k);
    if (hit === undefined) fail(`unknown argument: ${a} (see --help)`);
    opts[hit.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return opts;
};

const gen = (opts) => {
  const keyId = opts.keyId ?? 'dsh-market-1';
  if (!KEY_ID.test(keyId)) fail(`bad key id: ${keyId}`);
  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  console.log('new marketplace signing key — copy the seed into the');
  console.log('MARKETPLACE_SIGNING_KEY secret (Settings → Secrets and variables');
  console.log('→ Actions). The seed is NOT stored anywhere in the repository:');
  console.log('');
  console.log(`  key id       ${keyId}`);
  console.log(`  seed (b64)   ${seed.toString('base64')}`);
  console.log(`  pub (b64)    ${pubRawB64(privateKey)}   <- raw 32-byte key`);
  console.log('');
  console.log('rotate: next run window-index with --new-key-id ' +
    `${keyId === 'dsh-market-1' ? 'dsh-market-2' : keyId.replace(/-\d+$/, (m) => `-${parseInt(m.slice(1), 10) + 1}`)}`);
};

const currentSeed = (opts) => {
  if (opts.currentSeedFile !== undefined) return readFileSync(opts.currentSeedFile, 'utf8').trim();
  if (opts.currentSeed !== undefined) return opts.currentSeed;
  if (process.env.MARKETPLACE_SIGNING_KEY) return process.env.MARKETPLACE_SIGNING_KEY.trim();
  return fail('no outgoing key: pass --current-seed/--current-seed-file or set MARKETPLACE_SIGNING_KEY');
};

/** Default the incoming id to the outgoing id's number + 1 (dsh-market-N). */
const resolveNewKeyId = (opts, currentId) => {
  if (opts.newKeyId !== undefined) return opts.newKeyId;
  const m = currentId.match(/^(.*-)(\d+)$/);
  if (m === null) return fail('--new-key-id is required (outgoing id does not end in -<number>)');
  return `${m[1]}${parseInt(m[2], 10) + 1}`;
};

const loadPacked = (opts) => {
  const root = opts.systemPlugins ?? 'system-plugins';
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    return fail(`cannot read plugin tree ${root}: ${err}`);
  }
  return names.map((n) => packPlugin(`${root}/${n}`, n));
};

const windowIndex = (opts) => {
  // Same contract as the generator's resolveInput: empty/whitespace-only
  // counts as missing — `--base-url "$VAR"` with an unset VAR must fail
  // loud, never publish a signed index of relative URLs.
  const baseUrl = (opts.baseUrl ?? '').trim();
  if (baseUrl === '') {
    return fail('no --base-url (or it is empty) — a signed index never ' +
      'carries a placeholder URL');
  }
  const currentId = opts.keyId ?? 'dsh-market-1';
  const newId = resolveNewKeyId(opts, currentId);
  if (newId === currentId) return fail(`--new-key-id must differ from the outgoing id (${currentId})`);
  if (!KEY_ID.test(newId)) fail(`bad new key id: ${newId}`);
  const oldKey = keyFromSeedB64(currentSeed(opts), 'outgoing key');
  const newKey = opts.newSeed !== undefined
    ? keyFromSeedB64(opts.newSeed, 'incoming key')
    : generateKeyPairSync('ed25519').privateKey;
  const packed = loadPacked(opts);
  const index = buildIndex({
    packed,
    summaries: readSummaries(),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    keys: { [currentId]: pubRawB64(oldKey), [newId]: pubRawB64(newKey) },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  });
  const signed = attachSignatures(
    index, [signWith(index, currentId, oldKey), signWith(index, newId, newKey)]);
  writeSignedIndex(opts.out ?? 'dist/marketplace', packed, signed);
  const seed = newKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  console.log('');
  console.log('rotation window published. NEXT STEPS, in order:');
  console.log(`  1. deploy this index (the dual-signed window — hosts learn ${newId})`);
  console.log('  2. flip MARKETPLACE_SIGNING_KEY to the new seed:');
  console.log(`       ${seed.toString('base64')}`);
  console.log(`  3. the next regular publish (gen-marketplace-index.mjs) signs`);
  console.log(`     with ${newId} only and drops ${currentId} from keys — window closed.`);
};

const readSummaries = () => JSON.parse(readFileSync(SUMMARIES_PATH, 'utf8'));

const main = (argv) => {
  const [cmd, ...rest] = argv;
  if (cmd === 'gen') return gen(parseArgs(rest, {}));
  if (cmd === 'window-index') return windowIndex(parseArgs(rest, {}));
  if (cmd === '-h' || cmd === '--help' || cmd === undefined) { console.log(USAGE); return; }
  fail(`unknown subcommand: ${cmd} (see --help)`);
};

if (process.argv[1] !== undefined && process.argv[1].endsWith('marketplace-rotate-key.mjs')) {
  main(process.argv.slice(2));
}
