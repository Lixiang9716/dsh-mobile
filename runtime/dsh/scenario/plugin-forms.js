/**
 * Scenario `plugin.forms` — the upstream plugin tutorial's one-to-one
 * proof on the mobile host (docs/plugin-dev.md): ALL THREE plugin forms
 * mount live, declare dependencies, clean up on unload, and reload with
 * edited source — no model in the path, fully deterministic.
 *
 * Flow (every expected event = one structured log line, in the order the
 * manifest test/e2e/scenarios/plugin-forms.json declares):
 *
 *   1. spine: the mobile profile boots (dummy LLM route — no turn runs);
 *   2. authored: three workspace plugin trees are written through the
 *      gateway fs —
 *        forms-hello   the tutorial's hello-plugin, object form
 *                      (name/inject/apply + a ctx.effect cleanup flag),
 *        forms-fn      function form (export default (ctx) => …),
 *        forms-service class form (export class extends Service, static
 *                      inject ['tools'], provides formsService.beat());
 *   3. mount: all three mount live (approved: true — the scripted leg),
 *      the service form answers through the cordis service resolver
 *      (the inject ordering proof: apply ran only after tools was up);
 *   4. effect: the object form's ctx.effect disposer ran on unload —
 *      unmount disposes every fiber, the service no longer resolves;
 *   5. reload: the object form's source is EDITED and remounted — the
 *      epoch query re-links a fresh compile (the loader's node-style
 *      cache-buster), the edited line is what runs;
 *   6. boot-list: a relaunch-equivalent pass — mountEnabledRegistry mounts
 *      the still-enabled rows (the cordis.yml-insert equivalent).
 *
 * Artifacts: runtime/dsh/artifacts/macos-cli-plugin-forms/.
 */
import { createLogger } from 'logger.js';
import { fsScope, fsWrite, fsRead } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';
import { mountWorkspacePlugin, unmountWorkspacePlugin,
  mountEnabledRegistry, isMounted }
  from 'plugin-mount.js';
import { upsertRegistryRow } from 'workspace-registry.js';

const SCENARIO = 'plugin.forms';
const AGENT_ID = 'main';
const SESSION_ID = 's-plugin-forms-0001';
// A self-contained, gitignored scratch workspace (the CLI's app-scope root
// is the runtime/dsh tree): every tree and the registry land under here.
const PREFIX = 'tmp/plugin-forms';

const log = createLogger('dsh.scenario');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

// quickjs has no TextEncoder: the node:buffer shim's encodeUtf8 is the
// runtime's own face (web-write-plugin-manager resolves the same one).
const encodeUtf8 = async (text) => {
  log.debug('encodeUtf8 face probe', {});
  const dsh = await import('node:buffer').catch(() => undefined);
  demand(typeof dsh?.encodeUtf8 === 'function', 'no encodeUtf8 face on node:buffer');
  return dsh.encodeUtf8(text);
};

const writeTree = async (spec, manifest, source) => {
  log.debug('plugin tree write', { spec });
  await fsWrite('app', `${PREFIX}/plugins/${spec}/manifest.json`,
    await encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`));
  await fsWrite('app', `${PREFIX}/plugins/${spec}/index.js`, await encodeUtf8(source));
};

// The three forms. The object form is the tutorial verbatim in spirit
// (name + apply + ctx.effect cleanup). NOTE the vendored cordis@4.0.2
// effect semantics (lib/index.js _execute): the callback runs IMMEDIATELY
// as setup and its RETURN VALUE is the disposer — so cleanups are written
// `ctx.effect(() => () => …)`. The counters ride globalThis so the
// scenario observes load/disposal without a second round trip.
const HELLO_SOURCE = `
export const name = 'forms-hello';
export const inject = ['tools'];
export const apply = (ctx) => {
  globalThis.__formsProbe = { loaded: (globalThis.__formsProbe?.loaded ?? 0) + 1 };
  ctx.effect(() => () => {
    globalThis.__formsProbe = {
      ...globalThis.__formsProbe,
      disposed: (globalThis.__formsProbe?.disposed ?? 0) + 1,
    };
  });
};
`;
const HELLO_EDITED = HELLO_SOURCE.replace("name = 'forms-hello'",
  "name = 'forms-hello-edited'");
const FN_SOURCE = `
export default (ctx) => {
  globalThis.__formsFn = { loaded: true };
  ctx.effect(() => () => { globalThis.__formsFn = { loaded: false }; });
};
`;
const BOOT_SOURCE = `
export const name = 'forms-boot';
export const apply = (ctx) => {
  globalThis.__formsBoot = { loaded: true };
};
`;
const SERVICE_SOURCE = `
import { Service } from '@deepseek-ai/cordis';
export class FormsService extends Service {
  static inject = ['tools'];
  constructor(ctx) {
    super(ctx, 'formsService');
    globalThis.__formsService = { constructed: true };
  }
  beat() { return 'forms-service-beat'; }
}
`;
const MANIFEST = (id) => ({
  schemaVersion: 1, type: 'service', id, version: '1.0.0',
  entry: 'index.js', capabilities: { required: [] },
});

const bootPhase = async () => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
  demand(typeof root === 'string' && root.startsWith('/'),
    `profile container not resolved: ${JSON.stringify(root)}`);
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  const env = JSON.parse(raw);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: AGENT_ID, sessionId: SESSION_ID, cwd: root,
    onEvent: () => {},
    container: {
      cwd: root, scopeRoot: root, tmpdir: `${root}/tmp`, home: `${root}/home`,
      env, argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: env.DSH_MOCK_LLM_URL, apiKey: env.DSH_MOCK_LLM_KEY,
      provider: 'mock', model: 'mock-1',
    },
  });
  emit('spine.booted', { sessionId: SESSION_ID });
  return ctx;
};

const mountPhase = async (ctx) => {
  log.debug('mount phase begin', {});
  for (const spec of ['forms-hello', 'forms-fn', 'forms-service']) {
    const outcome = await mountWorkspacePlugin(ctx, spec, { approved: true, prefix: PREFIX });
    demand(outcome.mounted === true, `${spec} mount refused at ${outcome.step}: ${outcome.reason ?? ''}`);
    emit('form.mounted', { spec });
  }
  demand(globalThis.__formsProbe?.loaded === 1, 'object form apply did not run');
  demand(globalThis.__formsFn?.loaded === true, 'function form apply did not run');
  demand(globalThis.__formsService?.constructed === true, 'class form constructor did not run');
  demand(typeof ctx.get?.('formsService')?.beat === 'function',
    'the Service form did not register formsService (inject ordering broken)');
  emit('forms.live', {
    object: true, function: true,
    service: ctx.get('formsService').beat() === 'forms-service-beat',
  });
};

const unloadPhase = async (ctx) => {
  log.debug('unload phase begin', {});
  for (const spec of ['forms-hello', 'forms-fn', 'forms-service']) {
    const outcome = await unmountWorkspacePlugin(spec, { prefix: PREFIX });
    demand(outcome.unmounted === true, `${spec} unmount refused at ${outcome.step}: ${outcome.reason ?? ''}`);
    emit('form.unmounted', { spec });
  }
  demand(globalThis.__formsProbe?.disposed === 1, 'ctx.effect cleanup did not run on unload');
  demand(globalThis.__formsFn?.loaded === false, 'function form effect cleanup did not run');
  demand(ctx.get?.('formsService') === undefined, 'formsService still resolves after unload');
  demand(isMounted('forms-hello') === false, 'forms-hello still marked live');
  emit('unload.effects', { disposed: globalThis.__formsProbe.disposed });
};

const reloadPhase = async (ctx) => {
  log.debug('reload phase begin', {});
  await writeTree('forms-hello', MANIFEST('forms-hello'), HELLO_EDITED);
  const reload = await mountWorkspacePlugin(ctx, 'forms-hello', { approved: true, prefix: PREFIX });
  demand(reload.mounted === true, `reload refused at ${reload.step}: ${reload.reason ?? ''}`);
  demand(reload.module.includes('?e=1'), `reload did not epoch-bust: ${reload.module}`);
  demand(globalThis.__formsProbe?.loaded === 2, 'the edited source did not re-run (stale module cache)');
  emit('reload.edited', { module: reload.module, loaded: globalThis.__formsProbe.loaded });
};

/** The boot-list (cordis.yml-insert equivalent): unmount leaves the row
 * DISABLED (skipped at boot), the dev-script-style enable of a fresh row
 * mounts exactly that row. forms-hello staying live would refuse. */
const bootListPhase = async (ctx) => {
  log.debug('boot-list phase begin', {});
  const again = await unmountWorkspacePlugin('forms-hello', { prefix: PREFIX });
  demand(again.unmounted === true, `forms-hello re-unmount refused: ${again.step}`);
  await writeTree('forms-boot', MANIFEST('forms-boot'), BOOT_SOURCE);
  const row = await upsertRegistryRow({
    fsRead, fsWrite, path: `${PREFIX}/dsh.plugins/1/registry.json`,
  }, { id: 'forms-boot', name: 'forms-boot', version: '1.0.0',
    path: 'plugins/forms-boot', source: 'workspace', enabled: true,
    installedAt: new Date().toISOString() });
  demand(row.ok === true, `registry upsert failed: ${row.code}: ${row.message}`);
  const boot = await mountEnabledRegistry(ctx, { prefix: PREFIX });
  demand(boot.ok === true, `boot-list read failed: ${boot.code}: ${boot.message}`);
  demand(boot.mounted.length === 1 && boot.mounted[0].spec === 'forms-boot',
    `boot-list mounted the wrong set: ${JSON.stringify(boot.mounted)}`);
  demand(boot.refused.length === 0,
    `boot-list refusals: ${JSON.stringify(boot.refused)}`);
  demand(globalThis.__formsBoot?.loaded === true, 'the boot row did not mount');
  demand(isMounted('forms-hello') === false, 'the disabled row mounted at boot');
  emit('bootlist.mounted', { spec: 'forms-boot', skipped: 'forms-hello(disabled)' });
};

const main = async () => {
  log.debug('main begin', {});
  const ctx = await bootPhase();
  await writeTree('forms-hello', MANIFEST('forms-hello'), HELLO_SOURCE);
  await writeTree('forms-fn', MANIFEST('forms-fn'), FN_SOURCE);
  await writeTree('forms-service', MANIFEST('forms-service'), SERVICE_SOURCE);
  emit('authored.trees', { specs: ['forms-hello', 'forms-fn', 'forms-service'] });
  await mountPhase(ctx);
  await unloadPhase(ctx);
  await reloadPhase(ctx);
  await bootListPhase(ctx);
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'pass');
};

main().catch((error) => fail(error));
