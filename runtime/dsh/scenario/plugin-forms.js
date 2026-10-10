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

// --- the framework-capabilities chapters, proven on this host -------------

// ch.5 config: an exported Config schema (Schemastery — a Standard Schema
// validator) is applied by ctx.plugin itself; apply receives the validated
// config, defaults filled.
const CONFIG_SOURCE = `
import Schema from '@deepseek-ai/schemastery';
export const name = 'forms-config';
export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
});
export const apply = (ctx, config) => {
  globalThis.__formsConfig = { greeting: config.greeting };
};
`;

// ch.4 events: broadcast, bail short-circuit, waterfall transform; every
// ctx.on is an effect — unmount removes the listeners.
const EVENTS_SOURCE = `
export const name = 'forms-events';
export const apply = (ctx) => {
  globalThis.__formsEvents = { on: 0, bail: 0, wf: 0 };
  ctx.on('forms/ping', () => { globalThis.__formsEvents.on += 1; });
  ctx.on('forms/check', (input) => (input === 'bad' ? 'blocked' : undefined));
  ctx.on('forms/transform', async (input, next) => (await next()) + '!');
};
`;

// basic/tool + ch.7: the tutorial's greet tool verbatim (defineTool from
// '@deepseek-ai/dsh-tools') plus an INDEPENDENT observer over tools/result
// (the two plugins connect only through the registry service and events).
const GREET_SOURCE = `
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'forms-greet';
export const inject = ['tools'];
export const apply = (ctx) => {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    async execute(args) { return \`Hello, \${args.name}!\`; },
  }));
  globalThis.__formsGreet = { registered: true };
};
`;
const LOGGER_SOURCE = `
export const name = 'forms-logger';
export const inject = ['tools'];
export const apply = (ctx) => {
  globalThis.__formsLogger = { seen: [] };
  ctx.on('tools/result', (exec, result) => {
    globalThis.__formsLogger.seen.push({
      name: exec.name,
      text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    });
  });
};
`;

// ch.3 dependency cascade: a consumer whose REQUIRED service is the
// Service-form provider. Unload the provider — cordis disposes the
// dependent; bring the provider back — the dependent reloads.
const CUSTOMER_SOURCE = `
export const name = 'forms-customer';
export const inject = ['formsService'];
export const apply = (ctx) => {
  globalThis.__formsCustomer = { alive: true };
  ctx.effect(() => () => { globalThis.__formsCustomer = { alive: false }; });
};
`;

// ch.6 diagnosis: a required service NOBODY provides — the mount must
// refuse with the PENDING diagnosis instead of reporting a phantom mount.
const PENDING_SOURCE = `
export const name = 'forms-pending';
export const inject = ['nonexistentService'];
export const apply = (ctx) => {
  globalThis.__formsPending = { loaded: true };
};
`;

// practice/llm-adapter: a workspace-authored LLM adapter — the tutorial's
// minimal stream() over the StreamChunk protocol, registered for its own
// provider through ctx.llm.registerAdapter (the registration is an effect:
// unmounting the plugin retires the provider).
const LLM_SOURCE = `
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'forms-llm';
export const inject = ['llm'];
class FormsAdapter extends LlmAdapter {
  // The tutorial's minimal adapter: override stream() only — the base
  // class owns providerInfo/providerRetryPolicy/resolveModel/prepareCall.
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, delta: 'forms-llm-echo' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'forms-llm-echo' } };
    yield { type: 'usage', inputTokens: 1, outputTokens: 3 };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const apply = (ctx) => {
  ctx.llm.registerAdapter(['forms-provider'], new FormsAdapter());
  globalThis.__formsLlm = { registered: true };
};
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

/** ch.5 config: ctx.plugin validates against the plugin's exported Config
 * schema (Standard Schema) before apply — explicit values pass through,
 * missing fields get the schema default, and an INVALID config must fail
 * the mount loud (the ValidationError surfaces as a 'mounted' refusal). */
const configPhase = async (ctx) => {
  log.debug('config phase begin', {});
  await writeTree('forms-config', MANIFEST('forms-config'), CONFIG_SOURCE);
  const set = await mountWorkspacePlugin(ctx, 'forms-config',
    { approved: true, prefix: PREFIX, pluginOpts: { greeting: 'Hola' } });
  demand(set.mounted === true, `config mount refused: ${set.step}: ${set.reason ?? ''}`);
  demand(globalThis.__formsConfig?.greeting === 'Hola', 'the explicit config value did not reach apply');
  emit('config.validated', { greeting: globalThis.__formsConfig.greeting });
  const off = await unmountWorkspacePlugin('forms-config', { prefix: PREFIX });
  demand(off.unmounted === true, 'config unmount refused');
  const def = await mountWorkspacePlugin(ctx, 'forms-config', { approved: true, prefix: PREFIX });
  demand(def.mounted === true, `default-config mount refused: ${def.step}`);
  demand(globalThis.__formsConfig?.greeting === 'Hello', 'the schema default did not fill in');
  emit('config.default', { greeting: globalThis.__formsConfig.greeting });
  void await unmountWorkspacePlugin('forms-config', { prefix: PREFIX });
  const bad = await mountWorkspacePlugin(ctx, 'forms-config',
    { approved: true, prefix: PREFIX, pluginOpts: { greeting: 7 } });
  demand(bad.mounted === false && bad.step === 'mounted'
    && /invalid config/i.test(bad.reason ?? ''),
  `an invalid config did not fail the mount loud: ${JSON.stringify(bad)}`);
  emit('config.invalid', { refused: true });
};

/** basic/tool + ch.7: the greet tool registers through defineTool, executes
 * through the REAL ToolRuntime, and an independent plugin observes it via
 * tools/result — the two connect only through the registry + events. */
const toolPhase = async (ctx) => {
  log.debug('tool phase begin', {});
  await writeTree('forms-greet', MANIFEST('forms-greet'), GREET_SOURCE);
  await writeTree('forms-logger', MANIFEST('forms-logger'), LOGGER_SOURCE);
  for (const spec of ['forms-greet', 'forms-logger']) {
    const mount = await mountWorkspacePlugin(ctx, spec, { approved: true, prefix: PREFIX });
    demand(mount.mounted === true, `${spec} mount refused: ${mount.step}: ${mount.reason ?? ''}`);
  }
  const outcome = await ctx.tools.execute({
    callId: 'forms-greet-1', name: 'greet',
    arguments: { name: 'Cordis' }, signal: new AbortController().signal,
  });
  const text = (outcome?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  demand(text === 'Hello, Cordis!', `the greet tool replied "${text}"`);
  const seen = globalThis.__formsLogger?.seen ?? [];
  demand(seen.length === 1 && seen[0].name === 'greet' && seen[0].text === text,
    `the tools/result observer missed the call: ${JSON.stringify(seen)}`);
  emit('tool.greeted', { text, observed: seen.length });
  for (const spec of ['forms-greet', 'forms-logger']) {
    const off = await unmountWorkspacePlugin(spec, { prefix: PREFIX });
    demand(off.unmounted === true, `${spec} unmount refused`);
  }
};

/** ch.3 dependency cascade: disposing the provider disposes the dependent;
 * restoring the service reloads it (the cordis dependency contract). */
const cascadePhase = async (ctx) => {
  log.debug('cascade phase begin', {});
  await writeTree('forms-customer', MANIFEST('forms-customer'), CUSTOMER_SOURCE);
  const mount = await mountWorkspacePlugin(ctx, 'forms-customer', { approved: true, prefix: PREFIX });
  demand(mount.mounted === true, `customer mount refused: ${mount.step}: ${mount.reason ?? ''}`);
  demand(globalThis.__formsCustomer?.alive === true, 'the dependent did not load on its required service');
  const off = await unmountWorkspacePlugin('forms-service', { prefix: PREFIX });
  demand(off.unmounted === true, 'provider unmount refused');
  demand(globalThis.__formsCustomer?.alive === false, 'the dependent survived its provider unload');
  emit('cascade.disposed', { alive: globalThis.__formsCustomer.alive });
  const back = await mountWorkspacePlugin(ctx, 'forms-service', { approved: true, prefix: PREFIX });
  demand(back.mounted === true, `provider remount refused: ${back.step}`);
  demand(globalThis.__formsCustomer?.alive === true, 'the dependent did not reload with its service');
  emit('cascade.reloaded', { alive: globalThis.__formsCustomer.alive });
  const done = await unmountWorkspacePlugin('forms-customer', { prefix: PREFIX });
  demand(done.unmounted === true, 'customer unmount refused');
};

/** ch.6 diagnosis: a required service nobody provides leaves the fiber
 * PENDING — the mount must refuse with the diagnosis, never a phantom. */
const pendingPhase = async (ctx) => {
  log.debug('pending phase begin', {});
  await writeTree('forms-pending', MANIFEST('forms-pending'), PENDING_SOURCE);
  const outcome = await mountWorkspacePlugin(ctx, 'forms-pending', { approved: true, prefix: PREFIX });
  demand(outcome.mounted === false && outcome.step === 'mounted'
    && /PENDING/.test(outcome.reason ?? ''),
  `a PENDING mount was not refused with the diagnosis: ${JSON.stringify(outcome)}`);
  demand(globalThis.__formsPending === undefined, 'the pending plugin ran its apply');
  emit('pending.refused', { step: outcome.step });
};

/** practice/llm-adapter: a workspace-authored adapter serves its provider —
 * the stream() call flows through the real LlmRuntime waterfall, and the
 * registration being an effect means unmount retires the provider. */
const llmPhase = async (ctx) => {
  log.debug('llm phase begin', {});
  await writeTree('forms-llm', MANIFEST('forms-llm'), LLM_SOURCE);
  const mount = await mountWorkspacePlugin(ctx, 'forms-llm', { approved: true, prefix: PREFIX });
  demand(mount.mounted === true, `llm mount refused: ${mount.step}: ${mount.reason ?? ''}`);
  let text = '';
  let stop = null;
  for await (const chunk of ctx.llm.stream({
    provider: 'forms-provider', model: 'forms-m1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [], signal: new AbortController().signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.delta;
    if (chunk.type === 'finish') stop = chunk.reason?.kind ?? null;
  }
  demand(text === 'forms-llm-echo' && stop === 'stop', `the adapter stream lied: "${text}" / ${String(stop)}`);
  emit('llm.streamed', { text, stop });
  const off = await unmountWorkspacePlugin('forms-llm', { prefix: PREFIX });
  demand(off.unmounted === true, 'llm unmount refused');
};

/** ch.4 events: broadcast emit, bail short-circuit, waterfall transform —
 * and every ctx.on is an effect, so unmount detaches the listeners. */
const eventsPhase = async (ctx) => {
  log.debug('events phase begin', {});
  await writeTree('forms-events', MANIFEST('forms-events'), EVENTS_SOURCE);
  const mount = await mountWorkspacePlugin(ctx, 'forms-events', { approved: true, prefix: PREFIX });
  demand(mount.mounted === true, `events mount refused: ${mount.step}`);
  ctx.emit('forms/ping', {});
  demand(globalThis.__formsEvents?.on === 1, 'the broadcast listener did not run');
  const bail = ctx.bail('forms/check', 'bad');
  demand(bail === 'blocked', `bail did not short-circuit: ${String(bail)}`);
  const pass = ctx.bail('forms/check', 'ok');
  demand(pass === undefined, `bail answered when every listener passed: ${String(pass)}`);
  const wf = await ctx.waterfall('forms/transform', 'hey', async () => 'hey');
  demand(wf === 'hey!', `waterfall did not transform: ${String(wf)}`);
  emit('events.observed', { on: 1, bail, wf });
  const off = await unmountWorkspacePlugin('forms-events', { prefix: PREFIX });
  demand(off.unmounted === true, 'events unmount refused');
  ctx.emit('forms/ping', {});
  demand(globalThis.__formsEvents?.on === 1, 'the listener survived unmount (ctx.on is not an effect)');
  emit('events.detached', { on: globalThis.__formsEvents.on });
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
  await configPhase(ctx);
  await eventsPhase(ctx);
  await toolPhase(ctx);
  await cascadePhase(ctx);
  await pendingPhase(ctx);
  await llmPhase(ctx);
  await unloadPhase(ctx);
  await reloadPhase(ctx);
  await bootListPhase(ctx);
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'pass');
};

main().catch((error) => fail(error));
