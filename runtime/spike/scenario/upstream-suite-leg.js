// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * upstream-suite-leg — the on-emulator driver of the UPSTREAM DSH test
 * suite: it loads ONE transpiled upstream spec (esbuild output, bare
 * package imports served by the host loader from the vendored closure,
 * `vitest` redirected to scenario/upstream-test-harness.js), runs it
 * through the harness, and streams one structured verdict per test plus a
 * summary. The spec selection arrives via the runtime.config bus delivery
 * (`spec`: bundle-root-relative module path of the transpiled spec).
 *
 * A failure here is the product: it names what OUR environment must grow
 * (a missing module, an absent API, a runtime capability gap) — the
 * owner's gap-fill loop ("run the upstream suite on the emulator, patch
 * whatever breaks").
 */
import 'upstream/web-shims.js'; // MUST be first: the specs compose contexts directly, so the Web-API globals the vendored packages expect (AbortController et al.) must exist before any of them loads
import 'upstream/shims/npm-bridges.js'; // the bare-npm bridges (diff/yaml/chokidar) register at import time — the product boot imports this, so the suite driver must too, or `diff` reads as unvendored (7+ specs, measured)
import { createLogger } from 'logger.js';
import { resetCollection, runCollected } from 'scenario/upstream-test-harness.js';
import { fsScope } from 'gateway.js';

const SCENARIO = 'upstream.suite';

const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason: String(reason).slice(0, 200) });
  const error = reason instanceof Error ? reason : null;
  const message = error ? `${error.message} | ${(error.stack ?? '').split('\n').slice(1, 4).join(' / ')}` : String(reason);
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};

const queue = [];
let wake = null;
globalThis.__dshBusOnMessage = (line) => {
  queue.push(JSON.parse(line));
  wake?.();
};
const takeRuntimeConfig = async () => {
  log.debug('take runtime config', {});
  for (;;) {
    const at = queue.findIndex((msg) => msg.type === 'runtime.config');
    if (at >= 0) return queue.splice(at, 1)[0];
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
};

// The launch-env branch (the same host-facts shape the parity drive uses):
// a host that declares DSH_UPSTREAM_SPEC in its launch snapshot — the iOS
// simulator drive, injected via SIMCTL_CHILD_* — runs the spec named there
// without waiting on the bus delivery (device carriers keep the
// runtime.config handoff; an empty snapshot, like Android's, ignores this).
const launchSpecFacts = () => {
  log.debug('launch spec facts', {});
  const raw = globalThis.__dshLaunchEnv?.();
  let env = null;
  if (typeof raw === 'string') {
    try { env = JSON.parse(raw); } catch { env = null; }
  }
  if (env !== null && typeof env.DSH_UPSTREAM_SPEC === 'string' && env.DSH_UPSTREAM_SPEC.length > 0) {
    return { spec: env.DSH_UPSTREAM_SPEC };
  }
  return null;
};


/** Seed one spec's fixtures module (emitted by transpile.mjs) into the
 * staged fs view BEFORE the tests run — `../fixtures` joins resolve at
 * /upstream-tests/fixtures, one spec per runtime, so the flat namespace
 * never collides. Seeding failures fail LOUD (rule 5): a bad fixture
 * manifest is a pipeline defect, not a skippable absence. A spec without a
 * fixtures module simply fails the dynamic import and is skipped. */
const seedSpecFixtures = async (spec, emit) => {
  log.debug('fixtures seed begin', { spec: spec.slice(0, 120) });
  let fx;
  try {
    fx = await import(spec.replace(/\.spec\.mjs$/, '.fixtures.js'));
  } catch {
    return;
  }
  if (!fx || !Array.isArray(fx.fixtures) || fx.fixtures.length === 0) return;
  const { fromBase64 } = await import('upstream/shims/buffer.js');
  const { seedStagedFiles } = await import('upstream/shims/fs.js');
  seedStagedFiles(Object.fromEntries(fx.fixtures.map(
    (f) => [f.path, { bytes: fromBase64(f.b64), mtimeMs: 0 }])));
  emit('suite/fixtures', { seeded: fx.fixtures.length });
};

/** Pin the profile container for the os/fs shims (cwd/tmpdir/home) and mount
 * the writable workspace VFS — specs import node:fs/promises + node:os at
 * top level, and their mkdtemp/tmpdir calls need a container the boot
 * prelude would normally pin; this driver IS that prelude for the suite. */
const pinProfileContainer = async () => {
  const resolved = await fsScope.resolve('scope://app/');
  if (typeof resolved?.path !== 'string') return;
  globalThis.__dshProfileCwd = resolved.path;
  globalThis.__dshProfileTmpdir = resolved.path.replace(/\/$/, '') + '/tmp';
  // os.shims homedir() refuses until the profile home is pinned.
  globalThis.__dshProfileHome = resolved.path.replace(/\/$/, '') + '/home';
  const { mountWorkspace } = await import('upstream/shims/fs.js');
  mountWorkspace(globalThis.__dshProfileTmpdir);
  // The pinned HOME exists before the first spec runs: on the desktop the
  // user home is a REAL directory os.homedir() may list (the browse picker's
  // home listing asserts exactly that), so the leg materializes both pinned
  // roots in the workspace VFS (R3-G1, 2026-09-28).
  const { mkdirSync } = await import('node:fs');
  for (const dir of [globalThis.__dshProfileHome, globalThis.__dshProfileTmpdir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') log.debug('profile root mkdir failed', { dir: String(dir).slice(0, 120), code: error?.code });
    }
  }
  // The transpiled specs' module directory (import.meta.dirname is
  // 'upstream-tests' — bundle-relative) is a REAL directory in node's
  // layout; specs that join it for scratch dirs (typert generator's
  // .generated-schema-*) need it under the pinned cwd too (W3-K, 2026-09-28).
  try {
    mkdirSync(`${globalThis.__dshProfileCwd.replace(/\/$/, '')}/upstream-tests`, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') log.debug('spec module dir mkdir failed', { code: error?.code });
  }
  // process.execPath: the upstream contract spawns `process.execPath
  // fixture-server.ts` expecting node's erasable-TS support (the lsp-stdio
  // fixture's own header says "Run: node fixture-server.ts"). When the host
  // exposes a node binary (the subprocess seam's PATH probe), pin it — the
  // old fixed spelling (`/usr/local/bin/dsh-spike-cli`) was a non-executable
  // placeholder whose only property was being absolute (W5-R, 2026-09-28).
  try {
    const facts = globalThis.__dshProcFacts?.();
    if (typeof facts?.nodePath === 'string' && facts.nodePath.length > 0) {
      globalThis.__dshProfileExecPath = facts.nodePath;
    }
  } catch (error) {
    log.debug('execPath pin failed', { reason: String(error).slice(0, 120) });
  }
  log.debug('profile container pinned', { cwd: globalThis.__dshProfileCwd });
};

/** Stage the specs' SPAWNED sibling files as REAL files next to the
 * transpiled specs (upstream-tests/ is a real directory on the desktop
 * spike): upstream CI runs `process.execPath <sibling .ts>` against the
 * vendored test tree, and a real child reads the real disk — the staged-fs
 * (in-runtime) fixture seeding cannot serve it. Sources stay vendored and
 * read-only (D6): the leg COPIES, never edits. Inert where the bundle is
 * not a writable real directory (device hosts). (W5-R, 2026-09-28.) */
const REAL_SIBLING_FILES = [
  // lsp-stdio's scriptable fake LSP server (connection/lifecycle spawn it;
  // its header: "Run: node fixture-server.ts (Node's erasable TypeScript
  // syntax support)")
  ['packages/lsp/lsp-stdio/tests/fixture-server.ts', 'fixture-server.ts'],
  // the win32-dialog driver spawns the worker and expects the native-less
  // failure to reject through it ("rejects through the real worker where
  // the Win32 surface is unavailable")
  ['packages/host/directory-picker-native/src/win32-dialog-worker.ts', 'win32-dialog-worker.ts'],
  // the sdk-client fake runtime server (spawned as `execPath fake-runtime.ts`)
  ['packages/sdk/client/tests/fake-runtime.ts', 'fake-runtime.ts'],
  // skill-office's checkers spec spawns `python3 check_office_test.py` — the
  // script is a REAL sibling of the vendored spec (W6-V, 2026-09-28)
  ['packages/skill/skill-office/tests/check_office_test.py', 'check_office_test.py'],
];
const VENDOR_TESTS_TAG = 'dsh-v0.1.6-alpha.2'; // the ensure-dsh-tests.sh pin
const stageRealSiblingFiles = async () => {
  log.debug('real sibling staging begin', {});
  // Real children read the REAL disk, so the copies must be real too — and
  // the runtime's own fs face is the in-memory workspace VFS. The one real
  // disk actor this seam owns is a CHILD PROCESS: /bin/cp runs in the CLI's
  // real working directory (the checkout root, where vendor/ and
  // upstream-tests/ live) — no cwd option on purpose (options.cwd would pin
  // the virtual profile container, which is NOT on the real disk).
  const { spawnSync } = await import('node:child_process');
  for (const [from, to] of REAL_SIBLING_FILES) {
    const vendorPath = `vendor/dsh-tests@${VENDOR_TESTS_TAG}/${from}`;
    const res = spawnSync('/bin/cp', [vendorPath, `upstream-tests/${to}`]);
    if (res.status !== 0) {
      log.debug('sibling stage failed', { from, to, code: res.error?.code ?? res.stderr?.slice?.(0, 80) });
    }
  }
};

/** Stage the running spec's PACKAGE SOURCE tree into the seeded read-only
 * view at the bundle-root paths the transpiled spec's source-introspection
 * joins resolve to (W6-V, 2026-09-28). The source-audit tests read their own
 * production sources — `readFileSync(new URL('../src/brand.ts',
 * import.meta.url), 'utf8')` — which on the monorepo layout resolves beside
 * the spec; under flat staging (spec at /upstream-tests/<stem>.spec.mjs) the
 * same join lands at /src/<file>. The vendored tree holds those bytes
 * verbatim (D6: read-only, staged not edited), so the leg seeds them. The
 * stem → package mapping is the transpiler's own flat name (path segments
 * joined by '__'), so only specs whose third segment is `tests` with a
 * shipped src/ tree stage anything. Listing rides the subprocess seam's find
 * (desktop only; elsewhere this is inert, like the sibling staging). */
const stageSourceIntrospectionTree = async (spec, emit) => {
  log.debug('source-introspection staging begin', { spec: spec.slice(0, 120) });
  const stem = spec.replace(/^upstream-tests\//, '').replace(/\.spec\.mjs$/, '');
  const parts = stem.split('__');
  if (parts.length < 3 || parts[2] !== 'tests') return;
  const vendorSrc = `vendor/dsh-tests@${VENDOR_TESTS_TAG}/packages/${parts[0]}/${parts[1]}/src`;
  const { spawnSync } = await import('node:child_process');
  const list = spawnSync('find', [vendorSrc, '-type', 'f']);
  if (list.status !== 0 || typeof list.stdout !== 'string') {
    log.debug('source-introspection list failed', { code: list.status, err: String(list.error?.code ?? '') });
    return;
  }
  const realFiles = list.stdout.split('\n').filter((line) => line.length > 0);
  if (realFiles.length === 0) return;
  const { fromBase64 } = await import('upstream/shims/buffer.js');
  const { seedStagedFiles } = await import('upstream/shims/fs.js');
  const seeds = {};
  for (const realPath of realFiles) {
    const b64 = globalThis.__dshProcReadReal?.(realPath);
    if (typeof b64 !== 'string') continue;
    seeds[`/src${realPath.slice(vendorSrc.length)}`] = { bytes: fromBase64(b64), mtimeMs: 0 };
  }
  const staged = Object.keys(seeds).length;
  if (staged === 0) return;
  seedStagedFiles(seeds);
  emit('suite/source-stage', { staged });
};

/** Install the flat-path map (W6-V): the transpiled specs' bundle-relative
 * joins (/vendor/..., /upstream-tests/...) are REAL directories of the
 * desktop checkout — the fs faces' real-disk fallbacks re-root through this
 * map so reads/stats of vendored assets answer from the pinned tree (D6: the
 * same read-only bytes the loader serves). Relative re-rootings resolve
 * against the CLI's real working directory, exactly like the sibling
 * staging's /bin/cp. Undefined for paths with no real-world twin. */
const installFlatPathMap = () => {
  // The webworker-runtime node/chokidar spec's per-consumer package trees
  // (W7-X1): the spec resolves REAL chokidar/readdirp bytes through
  // createRequire(<consumer manifest>).resolve() — the node:module shim's
  // node_modules ancestor walk over the staged view — then mounts the files
  // into its own Worker-loader VFS. Upstream's lockfile pins DIFFERENT
  // majors per consumer (settings-file/credentials → chokidar 4.0.3 +
  // readdirp 4.1.2; skill-filesystem → chokidar 5.0.0 + readdirp 5.0.0), so
  // the per-consumer node_modules nesting is what makes both fixtures
  // resolve their own version; one shared <cwd>/node_modules cannot. The
  // vendored registry trees answer through this map (read-only re-rooting —
  // D6: the same pinned bytes, staged not copied).
  const watchTrees = [
    ['/packages/settings/settings-file/node_modules/chokidar/', 'vendor/npm/chokidar@4.0.3/'],
    ['/packages/settings/settings-file/node_modules/readdirp/', 'vendor/npm/readdirp@4.1.2/'],
    ['/packages/skill/skill-filesystem/node_modules/chokidar/', 'vendor/npm/chokidar@5.0.0/'],
    ['/packages/skill/skill-filesystem/node_modules/readdirp/', 'vendor/npm/readdirp@5.0.0/'],
  ];
  // W8 (2026-09-29), the sdk-launch / subagent-dsh-sdk launch-resolution
  // family: `import.meta.resolve("@deepseek-ai/dsh/package.json")` answers
  // with the SPECIFIER VERBATIM (the product package is outside both
  // vendored staging families, so the bare map declines it and the loader's
  // legacy bundle-relative arm passes it through), and the spec reads the
  // manifest + launch files through THAT spelling — `@deepseek-ai/dsh/...`
  // raw (the resolve answer) and `/tmp/<run>/@deepseek-ai/dsh/...`
  // (path.resolve joins it against the run cwd). The pinned submodule
  // carries the VERBATIM product tree (apps/cli: manifest, built lib/bin.js,
  // src/bin.ts + sdk-source.cordis.patch.yml + tsconfig.json — the complete
  // source-launch set the spec requires), so the map re-roots both
  // spellings at it (D6: read-only re-rooting, bytes untouched). The re-root
  // target is relative to the CLI's REAL working directory — the spike root
  // (runtime/spike, where vendor/ lives; every real-disk staging arm
  // resolves there) — hence the ../../ prefix into the checkout.
  const reRoots = [
    ['@deepseek-ai/dsh/', '../../third-party/deepseek-harness/apps/cli/'],
    ['/@deepseek-ai/dsh/', '../../third-party/deepseek-harness/apps/cli/'],
    ['/package.json', 'vendor/npm/@deepseek-ai/dsh-sdk-client@0.1.6-alpha.2/package.json'],
  ];
  // W8 (2026-09-29): the spec joins its consumer manifest against
  // process.cwd() — the RUN's workspace root (/tmp/dsh-spike-smoke.*) — so
  // the ancestor walk produces WORKSPACE-ABSOLUTE spellings
  // (<root>/packages/.../node_modules/...) the bare watchTrees rows above
  // never match ("cannot resolve 'chokidar' from /tmp/.../settings-file/
  // package.json"). The workspace root is pinned by pinProfileContainer
  // BEFORE the spec loads, so the map strips it (and the tmpdir root)
  // before the prefix match; unprefixed spellings still hit directly.
  const roots = [globalThis.__dshProfileCwd, globalThis.__dshProfileTmpdir]
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => `${root.replace(/\/$/, '')}/`);
  const mapAll = (candidate) => {
    for (const [staged, real] of reRoots) {
      if (staged.endsWith('/') ? candidate.startsWith(staged) : candidate === staged) {
        return `${real}${candidate.slice(staged.length)}`;
      }
    }
    for (const [staged, real] of watchTrees) {
      if (candidate.startsWith(staged)) return `${real}${candidate.slice(staged.length)}`;
    }
    return undefined;
  };
  globalThis.__dshFlatPathMap = (path) => {
    if (typeof path !== 'string') return undefined;
    if (path.startsWith('/vendor/') || path.startsWith('/upstream-tests/')) {
      return path.slice(1);
    }
    const direct = mapAll(path);
    if (direct !== undefined) return direct;
    for (const root of roots) {
      if (root !== '/' && path.startsWith(root)) {
        const inner = path.slice(root.length - 1); // keep the leading '/'
        const mapped = mapAll(inner);
        if (mapped !== undefined) return mapped;
      }
    }
    return undefined;
  };
};

/** Preload the child-process namespace for the fs faces' real-disk readdir
 * (fs.js lazy-imports it, but specs walk fixtures at MODULE scope — no job
 * drain between fs.js's eval and the walk — so the leg pins it here, ahead
 * of the spec import, where async context exists). */
const preloadRealFs = async () => {
  try {
    const ns = await import('node:child_process');
    globalThis.__dshChildProcessNs = ns;
  } catch (error) {
    log.debug('child-process preload failed', { reason: String(error).slice(0, 120) });
  }
};

/** Stage the spec's tests/fixtures tree as REAL files under
 * upstream-tests/fixtures (W6-V, 2026-09-28). The transpiler already seeds
 * those bytes into the VFS at /upstream-tests/fixtures (the bundle-root
 * join), but specs that resolve fixtures against process.cwd() produce the
 * WORKSPACE-absolute <cwd>/upstream-tests/fixtures path — outside every
 * seeded view. The copy is verbatim (D6: read-only staging) and desktop-only
 * like the sibling staging. */
/** Mirror the vendored node_modules packages a fixture's tsconfig walk-up
 * needs (module level for size): SPECIFIC packages only (extend the list
 * when a fixture names one; never mirror the whole vendor tree — host cost,
 * and @deepseek-ai/* types are served by the fixture tsconfig's own paths
 * map). cp -R follows the vendor symlink, so the run container is
 * self-contained (D6: read-only staging of the pinned vendored bytes). */
const stageFixtureNodeModules = async (spawnSync) => {
  const root = globalThis.__dshProfileCwd?.replace(/\/$/, '');
  for (const pkg of ['zod']) {
    const probe = spawnSync('/bin/test', ['-d', `vendor/node_modules/${pkg}`]);
    if (probe.status !== 0) continue;
    // cp -R src dest/ needs dest to exist (no implicit mkdir in /bin/cp).
    spawnSync('/bin/mkdir', ['-p', `${root}/node_modules`]);
    const mirror = spawnSync('/bin/cp', ['-R', `vendor/node_modules/${pkg}`, `${root}/node_modules/`]);
    if (mirror.status !== 0) {
      log.debug('fixture node_modules mirror skipped', { pkg, code: mirror.status });
    }
  }
};

/** Stage the MINIMAL @types/node test-support declaration (module level for
 * size). @types/node is NOT vendored (a vendoring decision — only the
 * fixture compiles want it), but the type-model fixture's models reference
 * the NodeJS namespace (NodeJS.Process). Authored in OUR layer (the
 * .parity-shim precedent): just enough ambient vocabulary for the namespace
 * lookups to resolve — the analyzer under test observes the fixture's OWN
 * declarations, and the vendored fixture tree must stay verbatim (D6). */
const stageFixtureTypesStub = async (spawnSync) => {
  const root = globalThis.__dshProfileCwd?.replace(/\/$/, '');
  const nm = `${root}/node_modules/@types/node`;
  spawnSync('/bin/mkdir', ['-p', nm]);
  const decl = [
    '// Test-support minimum staged by upstream-suite-leg (W6-V): the vendored',
    '// fixture closure names the NodeJS namespace; @types/node itself is not',
    '// vendored. Ambient vocabulary only — no member shapes are asserted.',
    'declare namespace NodeJS {',
    '  interface Process {}',
    '  interface ProcessEnv { [key: string]: string | undefined }',
    '  interface Timeout {}',
    '  interface Immediate {}',
    '}',
    'declare namespace NodeJS { interface Process { env: ProcessEnv } }',
    '',
  ].join('\n');
  // The python3 writer (a staged real child) owns the bytes; spawnSync has
  // no stdin-input face worth leaning on here.
  const writer = spawnSync('/usr/bin/python3', ['-c', `import pathlib; pathlib.Path('${nm}/index.d.ts').write_text(${JSON.stringify(decl)})`]);
  if (writer.status !== 0) {
    log.debug('fixture @types/node stub skipped', { code: writer.status });
  } else {
    spawnSync('/usr/bin/python3', ['-c', `import json, pathlib; p = pathlib.Path('${nm}/package.json'); p.write_text(json.dumps({'name': '@types/node', 'version': '0.0.0-test-support', 'types': './index.d.ts'}))`]);
  }
};

const stageRealFixturesTree = async (spec) => {
  const stem = spec.replace(/^upstream-tests\//, '').replace(/\.spec\.mjs$/, '');
  const parts = stem.split('__');
  if (parts.length < 3 || parts[2] !== 'tests') return;
  const vendorFixtures = `vendor/dsh-tests@${VENDOR_TESTS_TAG}/packages/${parts[0]}/${parts[1]}/tests/fixtures`;
  // The cwd-joined path is the RUN'S OWN real scope root (the per-run
  // mkdtemp), not the CLI checkout — materialize there (absolute real paths;
  // the /bin tools see exactly what the real fallback will stat).
  const target = `${globalThis.__dshProfileCwd?.replace(/\/$/, '') ?? ''}/upstream-tests`;
  if (!target.startsWith('/tmp/')) return;
  const { spawnSync } = await import('node:child_process');
  spawnSync('/bin/mkdir', ['-p', target]);
  const res = spawnSync('/bin/cp', ['-R', vendorFixtures, `${target}/`]);
  if (res.status !== 0) {
    log.debug('fixtures tree stage skipped', { vendorFixtures, code: res.status });
  }
  await stageFixtureNodeModules(spawnSync);
  await stageFixtureTypesStub(spawnSync);
};

/** Pin the real host platform for the shell-gated suites (W7-X1): upstream
 * guards its real-shell compositions with `process.platform === 'linux' ||
 * 'darwin'` (tool-terminal loader-composition's suite selector) — a gate
 * this runtime's 'mobile' default silently fails, registering the suite as
 * skipped (0/0 green = skipped in the dark, the exact shape the transpiler's
 * named-exclusion contract refuses). The desktop spike IS a shell host (the
 * subprocess seam spawns real children throughout), so the REAL platform is
 * the honest value here: uname(1) through the seam's real-child channel,
 * desktop-only like every other real-disk staging arm; device hosts keep
 * 'mobile' and upstream's own gate keeps skipping (its intent). Spec-scoped
 * until a wave owns the global flip: 70 staged specs read process.platform,
 * and repinning every arm in one sweep is that wave's blast radius, not a
 * vendoring side effect. */
const stageShellSuitePlatform = async (spec) => {
  if (!spec.includes('terminal__tool-terminal__tests__loader-composition')) return;
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('/usr/bin/uname', ['-s']);
  const platform = res.status === 0 && typeof res.stdout === 'string'
    ? { Darwin: 'darwin', Linux: 'linux' }[res.stdout.trim()]
    : undefined;
  if (platform === undefined) {
    log.debug('shell-suite platform pin skipped', { code: res.status, out: String(res.stdout).slice(0, 20) });
    return;
  }
  globalThis.__dshProfilePlatform = platform;
  log.debug('shell-suite platform pinned', { platform });
};

/** Stage the committed session-format corpus (W8, 2026-09-29): the
 * llm-replay session-format-corpus spec walks the upstream REPO ROOT
 * (`resolve(import.meta.dirname, '../../../..')` — the bundle root '/' under
 * flat staging) for committed session fixtures under snapshots/ + packages/
 * + scripts/snapshots/python-sdk-single-exe, then reads every one. The
 * pinned submodule IS the verbatim upstream repo tree (D6: read-only
 * staging), so the leg lists its session*.jsonl corpus (find; excluding the
 * walk's own excludedDirectories dist/lib/node_modules) and seeds the bytes
 * into the staged view at exactly the bundle-root spellings the walk joins
 * (fs.js serves them from the /snapshots + /packages + /scripts roots).
 * Spec-scoped: only that spec's runtime pays the ~4 MB seed. */
const SUBMODULE_ROOT_REL = '../../third-party/deepseek-harness';
const SESSION_NAME = /^session(?:\.[1-9]\d*)?(?:\.v[1-9]\d*)?\.jsonl$/;
const stageSessionFormatCorpus = async (spec, emit) => {
  if (!spec.includes('test-support__llm-replay__tests__session-format-corpus')) return;
  log.debug('session corpus staging begin', {});
  const { spawnSync } = await import('node:child_process');
  const realFiles = [];
  for (const root of ['snapshots', 'packages', 'scripts/snapshots/python-sdk-single-exe']) {
    const list = spawnSync('find', [`${SUBMODULE_ROOT_REL}/${root}`, '-type', 'f', '-name', 'session*.jsonl',
      '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*', '-not', '-path', '*/lib/*']);
    if (list.status !== 0 || typeof list.stdout !== 'string') {
      log.debug('session corpus list failed', { root, code: list.status });
      continue;
    }
    for (const realPath of list.stdout.split('\n')) {
      if (realPath.length === 0) continue;
      const rel = realPath.slice(SUBMODULE_ROOT_REL.length + 1);
      // The walk COLLECTS only session-named jsonl files and THROWS on a
      // non-canonical name — stage exactly the canonical set.
      if (SESSION_NAME.test(realPath.split('/').at(-1) ?? '')) realFiles.push(rel);
    }
  }
  if (realFiles.length === 0) return;
  const { fromBase64 } = await import('upstream/shims/buffer.js');
  const { seedStagedFiles } = await import('upstream/shims/fs.js');
  const seeds = {};
  for (const rel of realFiles) {
    const b64 = globalThis.__dshProcReadReal?.(`${SUBMODULE_ROOT_REL}/${rel}`);
    if (typeof b64 !== 'string') continue;
    seeds[`/${rel}`] = { bytes: fromBase64(b64), mtimeMs: 0 };
  }
  const staged = Object.keys(seeds).length;
  if (staged === 0) return;
  seedStagedFiles(seeds);
  emit('suite/corpus-stage', { staged });
};

/** Stage the remote-mock type world (W8, 2026-09-29): the proxy-types spec
 * type-checks against the upstream REPO ROOT (root =
 * resolve(import.meta.dirname, '../../../..') → '/' under flat staging) —
 * it reads tsconfig.base.client.json (→ extends tsconfig.base.json) there,
 * typeRoots ./scripts/types, the typert protocol sources the virtual paths
 * re-export from, and resolves @vitest/spy + @types/node under
 * root/node_modules. The pinned submodule carries all of it VERBATIM (D6:
 * read-only staging), so the leg seeds the closure the program reaches at
 * exactly those '/'-spellings before the spec import:
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
const stageRemoteMockTypeWorld = async (spec, emit) => {
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
    if (!isDir) { readSeed(to, `${SUBMODULE_ROOT_REL}/${from}`); continue; }
    const list = spawnSync('find', [`${SUBMODULE_ROOT_REL}/${from}`, '-type', 'f']);
    if (list.status !== 0 || typeof list.stdout !== 'string') continue;
    for (const realPath of list.stdout.split('\n')) {
      if (realPath.length === 0) continue;
      readSeed(`${to}${realPath.slice(`${SUBMODULE_ROOT_REL}/${from}`.length)}`, realPath);
    }
  }
  // The @vitest trio out of the pnpm store (declaration + manifest files
  // only — the typecheck never executes them), seeded at the root
  // node_modules spellings the compiler resolves from.
  for (const name of ['spy', 'expect', 'utils']) {
    const dirs = spawnSync('/bin/sh', ['-c',
      `ls -d ${SUBMODULE_ROOT_REL}/node_modules/.pnpm/@vitest+${name}@*/node_modules/@vitest/${name} 2>/dev/null`]);
    const dir = String(dirs.stdout ?? '').split('\n').find((line) => line.length > 0);
    if (dir === undefined) { log.debug('vitest types dir missing', { name }); continue; }
    const list = spawnSync('find', [dir, '-type', 'f', '(', '-name', '*.d.ts', '-o', '-name', 'package.json', ')']);
    if (list.status !== 0 || typeof list.stdout !== 'string') continue;
    for (const realPath of list.stdout.split('\n')) {
      if (realPath.length === 0) continue;
      readSeed(`/node_modules/@vitest/${name}${realPath.slice(dir.length)}`, realPath);
    }
  }
  // The @types/node ambient stub (same vocabulary the fixture compilers
  // get; authored in OUR layer, see stageFixtureTypesStub).
  seeds['/node_modules/@types/node/package.json'] = {
    bytes: encodeUtf8(JSON.stringify({ name: '@types/node', version: '0.0.0-test-support', types: './index.d.ts' })),
    mtimeMs: 0,
  };
  seeds['/node_modules/@types/node/index.d.ts'] = { bytes: encodeUtf8([
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
  ].join('\n')), mtimeMs: 0 };
  const staged = Object.keys(seeds).length;
  if (staged === 0) return;
  seedStagedFiles(seeds);
  emit('suite/type-world-stage', { staged });
};

/** Boot the leg's environment and stage everything the spec needs before
 * its import (module level for size): pin the profile container (the os/fs
 * shims read it BEFORE the spec imports evaluate — this driver IS the
 * suite's boot prelude), stage the spawned sibling files, install the
 * flat-path map, preload the child-process namespace, then run the
 * spec-specific staging faces. Returns the resolved spec path. */
const bootLegEnvironment = async () => {
  log.debug('main begin', {});
  const cfg = launchSpecFacts() ?? await takeRuntimeConfig();
  await pinProfileContainer();
  // Stage the spawned sibling files (real children read the real disk).
  await stageRealSiblingFiles();
  // Bundle-relative paths re-root at the real checkout (see above).
  installFlatPathMap();
  // The fs faces' real readdir needs the namespace before the spec's
  // module-scope walks run.
  await preloadRealFs();
  const spec = cfg.spec;
  if (typeof spec !== 'string' || spec.length === 0) fail('runtime.config carries no spec path');
  emit('suite/spec', { spec });
  // Stage the package source tree for the source-audit tests (see above).
  await stageSourceIntrospectionTree(spec, emit);
  // Stage the committed session-format corpus for the llm-replay walk (W8).
  await stageSessionFormatCorpus(spec, emit);
  // Stage the remote-mock type world (tsconfig chain + ambient types +
  // @vitest trio) for the proxy-types compiler (W8).
  await stageRemoteMockTypeWorld(spec, emit);

  // The spec's fixtures module (emitted by transpile.mjs when the spec ships
  // a tests/fixtures tree): seed the bytes into the staged fs view BEFORE the
  // spec imports — some specs read fixtures at MODULE scope during
  // collection (session-snapshot's suite.spec reads its record-suite
  // fixture bytes into a closure before any test runs), so seeding after
  // the import lost that race (W5-T). `../fixtures` joins resolve at
  // /upstream-tests/fixtures, one spec per runtime, so the flat namespace
  // never collides. A spec without a fixtures module simply skips.
  await seedSpecFixtures(spec, emit);
  // cwd-joined fixture joins need the REAL tree (see stageRealFixturesTree).
  await stageRealFixturesTree(spec);
  // The shell-gated suites need the REAL host platform before the spec's
  // module-scope suite selector evaluates (see above).
  await stageShellSuitePlatform(spec);
  return spec;
};

const main = async () => {
  const spec = await bootLegEnvironment();
  // The spec registers its tests at import time (module side effects are
  // the vitest collection model — exactly what the harness captures).
  await import(spec);
  const report = await runCollected((name, verdict, message) => {
    emit(verdict === 'pass' ? 'test/pass' : verdict === 'fail' ? 'test/fail' : verdict === 'start' ? 'test/start' : 'test/skip', {
      name: name.slice(0, 300),
      ...(message !== undefined ? { message: String(message).slice(0, 500) } : {}),
    });
  });

  emit('suite/summary', {
    spec,
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    ...(report.failures.length > 0 ? { firstFailure: report.failures[0] } : {}),
  });
  globalThis.__dshComplete(report.failed === 0, `${report.passed} passed, ${report.failed} failed`);
};

main().catch(fail);
