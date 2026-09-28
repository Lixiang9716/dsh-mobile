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

const main = async () => {
  log.debug('main begin', {});
  const cfg = launchSpecFacts() ?? await takeRuntimeConfig();
  // Pin the profile container for the os/fs shims BEFORE the spec imports
  // evaluate (this driver IS the suite's boot prelude).
  await pinProfileContainer();
  // Stage the spawned sibling files (real children read the real disk).
  await stageRealSiblingFiles();
  const spec = cfg.spec;
  if (typeof spec !== 'string' || spec.length === 0) fail('runtime.config carries no spec path');
  emit('suite/spec', { spec });

  // The spec's fixtures module (emitted by transpile.mjs when the spec ships
  // a tests/fixtures tree): seed the bytes into the staged fs view BEFORE the
  // spec imports — some specs read fixtures at MODULE scope during
  // collection (session-snapshot's suite.spec reads its record-suite
  // fixture bytes into a closure before any test runs), so seeding after
  // the import lost that race (W5-T). `../fixtures` joins resolve at
  // /upstream-tests/fixtures, one spec per runtime, so the flat namespace
  // never collides. A spec without a fixtures module simply skips.
  await seedSpecFixtures(spec, emit);
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
