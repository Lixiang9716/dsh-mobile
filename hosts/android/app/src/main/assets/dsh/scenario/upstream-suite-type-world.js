// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * upstream-suite-type-world — the W8 remote-mock type-world seeder of the
 * upstream suite leg, extracted from upstream-suite-leg.js at the
 * code-size gate. Takes (spec, emit, submoduleRootRel) — the caller (the
 * leg) passes its SUBMODULE_ROOT_REL so this module stays decoupled from
 * the leg's constants. ONE-WAY dependency: imports only the logger, never
 * anything from the leg (a static import cycle between closure files
 * kills QuickJS at link).
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.scenario');

/** The @types/node ambient stub (same vocabulary the fixture compilers
 * get; authored in OUR layer, see the leg's stageFixtureTypesStub —
 * @types/node itself is not vendored; sources only name the NodeJS
 * namespace). Module level for size (extracted from
 * stageRemoteMockTypeWorld with the seeder). */
const typesNodeStubSeeds = (encodeUtf8) => ({
  '/node_modules/@types/node/package.json': {
    bytes: encodeUtf8(JSON.stringify({ name: '@types/node', version: '0.0.0-test-support', types: './index.d.ts' })),
    mtimeMs: 0,
  },
  '/node_modules/@types/node/index.d.ts': { bytes: encodeUtf8([
    '// Test-support minimum staged by upstream-suite-leg (W8): the vendored',
    '// closure names the NodeJS namespace; @types/node itself is not vendored.',
    'declare namespace NodeJS {',
    '  interface Process {}',
    '  interface ProcessEnv { [key: string]: string | undefined }',
    '  interface Timeout {}',
    '  interface Immediate {}',
    '}',
    'declare namespace NodeJS { interface Process { env: ProcessEnv } }',
    '',
  ].join('\n')), mtimeMs: 0 },
});

/** The @vitest trio out of the pnpm store (declaration + manifest files
 * only — the typecheck never executes them), seeded at the root
 * node_modules spellings the compiler resolves from. Module level for
 * size (extracted from stageRemoteMockTypeWorld with the seeder). */
const seedVitestTrio = (spawnSync, readSeed, submoduleRootRel) => {
  for (const name of ['spy', 'expect', 'utils']) {
    const dirs = spawnSync('/bin/sh', ['-c',
      `ls -d ${submoduleRootRel}/node_modules/.pnpm/@vitest+${name}@*/node_modules/@vitest/${name} 2>/dev/null`]);
    const dir = String(dirs.stdout ?? '').split('\n').find((line) => line.length > 0);
    if (dir === undefined) { log.debug('vitest types dir missing', { name }); continue; }
    const list = spawnSync('find', [dir, '-type', 'f', '(', '-name', '*.d.ts', '-o', '-name', 'package.json', ')']);
    if (list.status !== 0 || typeof list.stdout !== 'string') continue;
    for (const realPath of list.stdout.split('\n')) {
      if (realPath.length === 0) continue;
      readSeed(`/node_modules/@vitest/${name}${realPath.slice(dir.length)}`, realPath);
    }
  }
};

/** Stage the remote-mock type world (W8, 2026-09-29): the proxy-types spec
 * type-checks against the upstream REPO ROOT (root =
 * resolve(import.meta.dirname, '../../../..') → '/' under flat staging) —
 * it reads tsconfig.base.client.json (→ extends tsconfig.base.json) there,
 * typeRoots ./scripts/types, the typert protocol sources the virtual paths
 * re-export from, and resolves @vitest/spy + @types/node under
 * root/node_modules. The pinned submodule carries all of it VERBATIM (D6:
 * read-only staging), so this seeder stages the closure the program
 * reaches at exactly those '/'-spellings before the spec import:
 *   - the two tsconfig chain files,
 *   - scripts/types/** (the client-build-environment ambient types),
 *   - packages/typert/protocol/src/** (types/remote-error/owned-value/index),
 *   - the pnpm store's @vitest/{spy,expect,utils} d.ts + package.json trees
 *     seeded at the /node_modules/@vitest/<name>/ spellings (the store is
 *     symlinked; the bytes are read THROUGH the links),
 *   - the same minimal @types/node ambient stub stageFixtureTypesStub
 *     writes for the fixture compilers (authored in OUR layer — @types/node
 *     itself is not vendored; sources only name the NodeJS namespace).
 * Spec-scoped: only the proxy-types runtime pays the seed. */
export const stageRemoteMockTypeWorld = async (spec, emit, submoduleRootRel) => {
  if (!spec.includes('test-support__remote-mock__tests__proxy-types.client')) return;
  log.debug('remote-mock type world staging begin', {});
  const { spawnSync } = await import('node:child_process');
  const { fromBase64, encodeUtf8 } = await import('upstream/shims/buffer.js');
  const { seedStagedFiles } = await import('upstream/shims/fs.js');
  const seeds = {};
  const readSeed = (virtualPath, realPath) => {
    const b64 = globalThis.__dshProcReadReal?.(realPath);
    if (typeof b64 === 'string') seeds[virtualPath] = { bytes: fromBase64(b64), mtimeMs: 0 };
  };
  // The tsconfig chain + the ambient client-build-environment types +
  // the typert protocol sources: find-listed verbatim trees.
  const trees = [
    ['tsconfig.base.client.json', '/tsconfig.base.client.json', false],
    ['tsconfig.base.json', '/tsconfig.base.json', false],
    ['scripts/types', '/scripts/types', true],
    ['packages/typert/protocol/src', '/packages/typert/protocol/src', true],
  ];
  for (const [from, to, isDir] of trees) {
    if (!isDir) { readSeed(to, `${submoduleRootRel}/${from}`); continue; }
    const list = spawnSync('find', [`${submoduleRootRel}/${from}`, '-type', 'f']);
    if (list.status !== 0 || typeof list.stdout !== 'string') continue;
    for (const realPath of list.stdout.split('\n')) {
      if (realPath.length === 0) continue;
      readSeed(`${to}${realPath.slice(`${submoduleRootRel}/${from}`.length)}`, realPath);
    }
  }
  seedVitestTrio(spawnSync, readSeed, submoduleRootRel);
  Object.assign(seeds, typesNodeStubSeeds(encodeUtf8));
  const staged = Object.keys(seeds).length;
  if (staged === 0) return;
  seedStagedFiles(seeds);
  emit('suite/type-world-stage', { staged });
};
