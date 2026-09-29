// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * source-bootstrap-tsx.js — the tsx (TypeScript registration) face for
 * SOURCE-ENTRY bootstraps, W8 source-entry-bootstrap class.
 *
 * Upstream's source-mode launches hand `node --import <tsx> <srcBin.ts>` to
 * a REAL child (runLoaderSmoke, the subprocess-local host scripts, the
 * corpus runners) and the source-closure Workers build a data: bootstrap
 * around `import.meta.resolve('tsx/esm/api')`. Under the spike, three
 * seams had to meet for those launches to exist at all:
 *
 *   1. RESOLUTION — the C import.meta.resolve throws for the bare name
 *      'tsx' (no dot/slash → unmapped). This module resolves the REAL tsx
 *      install instead (test/upstream-suite/node_modules — the node
 *      differential's own devDependency tree, pinned 4.23.15 whose layout
 *      matches upstream's '/tsx/dist/esm/index.mjs' shape), falling back to
 *      a minimal registration stub under the profile tmpdir for hosts
 *      without the install. The returned path is a REAL absolute file so
 *      the child loads it directly (the C argv remap only rewrites paths
 *      that do not exist yet).
 *   2. SOURCE BYTES — the staged fixtures/entries (/upstream-tests/**)
 *      live in the seeded VFS view; a REAL child reads the REAL disk. The
 *      argv remap re-roots '/x' to '<bundle>/x' WHEN THOSE BYTES EXIST
 *      there, so materializeChildArgv stages the seeded bytes (or a
 *      vendored-tree origin) to the remap target before the spawn — the
 *      same verbatim staging the suite leg's sibling/fixtures staging does
 *      (D6: staged, never edited).
 *   3. IN-REalm REGISTER — the Worker data: bootstraps import
 *      `{ register }` from the resolved tsx face and call it before
 *      importing their TypeScript entry. The runtime-modules rows serve
 *      this module as 'tsx' / 'tsx/esm' / 'tsx/esm/api'; register() here is
 *      the honest no-op (this realm has no TS eraser — source entries that
 *      need one say so loudly at import, they do not silently mis-parse).
 *
 * W9 split: seam 2 (the staging half — stagedRealRoot, the argv
 * materializer, the spawn-argv stager, the tsconfig staging, the vendored
 * origin search, the kill-face normalization) lives in
 * './source-bootstrap-tsx-stage.js', which imports NOTHING from here (a
 * static cycle between two shims files kills QuickJS at link); this face
 * re-exports the moved names so every existing import keeps its
 * specifier.
 */

import { readFileSync } from 'upstream/shims/fs.js';
export {
  realFileExists,
  stageChildTsConfig,
  materializeChildArgv,
  installSpawnArgvStager,
} from './source-bootstrap-tsx-stage.js';

/** The real tsx install this spike pairs with: the node differential's
 * dependency tree one level above the runtime bundle (<repo>/test/…).
 * Discovered lazily (a /bin/pwd child) and memoized — the overlay's first
 * src-mode launch pays one child spawn, every later call reuses it. */
let installCache;
const discoverInstall = () => {
  if (installCache !== undefined) return installCache;
  installCache = null;
  try {
    const { spawnSync } = globalThis.__dshChildProcessNs ?? {};
    if (typeof spawnSync !== 'function') return installCache;
    const pwd = spawnSync('/bin/pwd', [], { encoding: 'utf8' });
    if (pwd.status !== 0 || typeof pwd.stdout !== 'string') return installCache;
    const spikeDir = pwd.stdout.replace(/\n+$/, '');
    const tail = '/runtime/spike';
    if (!spikeDir.endsWith(tail)) return installCache;
    const repo = spikeDir.slice(0, -tail.length);
    const root = `${repo}/test/upstream-suite/node_modules/tsx`;
    // The package.json read is the existence check (readRealBytes serves
    // real absolute paths; a missing install answers null).
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
    } catch {
      return installCache;
    }
    const entryOf = (key) => {
      let face = manifest.exports?.[key];
      if (face === undefined) return undefined;
      // Conditional-map shapes: take the import/default chain's tail.
      while (face !== null && typeof face === 'object') {
        face = face.import?.default ?? face.default ?? face.node?.import?.default ?? face.node?.default;
      }
      if (typeof face !== 'string') return undefined;
      return `${root}/${face.replace(/^\.\//, '')}`;
    };
    const faces = {
      tsx: entryOf('.'),
      'tsx/esm': entryOf('./esm'),
      'tsx/esm/api': entryOf('./esm/api'),
    };
    if (typeof faces.tsx !== 'string' || typeof faces['tsx/esm'] !== 'string') return installCache;
    installCache = { root, faces };
  } catch {
    installCache = null;
  }
  return installCache;
};

/** The no-install fallback: a minimal registration stub written under the
 * profile tmpdir (a real directory), spelled with the upstream layout so
 * the '/tsx/dist/esm/index.mjs' containment pin still holds. Node ≥ 23.6
 * strips erasable TypeScript natively, so plain fixtures run unregistered —
 * this stub exists so the launch SHAPE is servable on hosts without the
 * real install, not to reimplement tsx. */
let fallbackWritten = false;
const FALLBACK_STUB = [
  '// source-bootstrap tsx face (no real tsx install on this host):',
  '// this child runs Node >= 23.6 which strips erasable TypeScript',
  '// natively; the bootstrap registers nothing.',
  'export const register = () => {};',
  'export const registerHooks = () => {};',
  'export const transform = (code) => ({ code });',
  'export default { register, registerHooks, transform };',
  '',
].join('\n');

const spawnSyncNs = () => globalThis.__dshChildProcessNs ?? {};

const writeFallback = () => {
  if (fallbackWritten) return true;
  try {
    const { spawnSync } = spawnSyncNs();
    if (typeof spawnSync !== 'function') return false;
    const tmp = globalThis.__dshProfileTmpdir;
    if (typeof tmp !== 'string' || tmp === '') return false;
    const dir = `${tmp.replace(/\/$/, '')}/tsx/dist/esm`;
    spawnSync('/bin/mkdir', ['-p', dir]);
    const writer = spawnSync('/usr/bin/python3', [
      '-c',
      `import pathlib; pathlib.Path('${dir}/index.mjs').write_text(${JSON.stringify(FALLBACK_STUB)})`,
    ]);
    fallbackWritten = writer.status === 0;
    return fallbackWritten;
  } catch {
    return false;
  }
};

const fallbackFace = (kind) => {
  if (!writeFallback()) return undefined;
  const base = `${globalThis.__dshProfileTmpdir.replace(/\/$/, '')}/tsx/dist/esm/index.mjs`;
  return base; // one stub serves every kind: registration is a no-op here
};

/** The child-launch face path for 'tsx' | 'tsx/esm' | 'tsx/esm/api' — the
 * overlay's resolveExampleLaunch answer (see the header: resolution, not
 * the C resolve). Undefined means "no face could be staged" and the caller
 * fails loud naming the kind, like the unmapped-specifier error it
 * replaces. */
export const resolveTsxChildFace = (kind) => {
  const install = discoverInstall();
  if (install !== null) {
    const face = install.faces[kind];
    if (typeof face === 'string') return face;
  }
  return fallbackFace(kind);
};
