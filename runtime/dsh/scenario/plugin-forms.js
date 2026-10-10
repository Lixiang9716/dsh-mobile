/**
 * Scenario `plugin.forms` — the upstream develop guide's one-to-one proof
 * on the mobile host (docs/plugin-dev.md), deterministic and model-free.
 * Plugin SOURCES live in plugin-forms-sources.js; this file is the driver.
 *
 * Phases (every expected event = one structured log line, in the order the
 * manifest test/e2e/scenarios/plugin-forms.json declares):
 *
 *   1. spine: the mobile profile boots (mock LLM route — no turn runs);
 *   2. mount: the three plugin FORMS (object / function / Service class)
 *      mount live; the service answers through the cordis resolver;
 *   3. config (basic/config): the exported Config schema validates inside
 *      ctx.plugin — explicit value, schema default, invalid → loud refusal
 *      with the adoption rolled back;
 *   4. events (framework/events): emit / bail / serial / waterfall, and
 *      ctx.on proven to detach on unmount;
 *   5. tool + policy (basic/tool + cookbook): the tutorial-verbatim greet
 *      tool runs through the real ToolRuntime under an independent
 *      observer; tools/pre-execute deny and the monotonic ctx.tools.guard
 *      both deny — and both lift when their plugin unmounts;
 *   6. jobs (cookbook/background): ctx.jobs.start → wait → read, and the
 *      kill path, against the real LocalJobRegistry;
 *   7. cascade + nested + provide (framework/service, tutorial 02/03):
 *      provider unload disposes the dependent and service restore reloads
 *      it; a child mounted through ctx.plugin disposes recursively with
 *      its parent; ctx.provide answers;
 *   8. pending (tutorial 06): a mount whose inject names a missing service
 *      refuses with the diagnosis — never a phantom mount;
 *   9. llm (practice/llm-adapter): a workspace-authored LlmAdapter serves a
 *      real LlmRuntime stream for its own provider;
 *  10. unload / reload / boot-list: fiber.dispose runs the cleanups, edited
 *      source re-links under the epoch cache-buster, and the boot list
 *      mounts exactly the enabled registry rows.
 *
 * Artifacts: runtime/dsh/artifacts/macos-cli-plugin-forms/.
 */
import { createLogger } from 'logger.js';
import { fsScope, fsWrite, fsRead } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';
import { mountWorkspacePlugin, unmountWorkspacePlugin,
  mountEnabledRegistry, isMounted, updateWorkspacePluginConfig }
  from 'plugin-mount.js';
import { upsertRegistryRow } from 'workspace-registry.js';
import { HELLO_SOURCE, HELLO_EDITED, FN_SOURCE, BOOT_SOURCE, SERVICE_SOURCE,
  CONFIG_SOURCE, EVENTS_SOURCE, GREET_SOURCE, LOGGER_SOURCE, POLICY_SOURCE,
  NESTED_SOURCE, CUSTOMER_SOURCE, PENDING_SOURCE, LLM_SOURCE, MANIFEST }
  from './plugin-forms-sources.js';

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

const mountOk = async (ctx, spec, opts = {}) => {
  log.debug('mount helper', { spec });
  const outcome = await mountWorkspacePlugin(ctx, spec, { approved: true, prefix: PREFIX, ...opts });
  demand(outcome.mounted === true, `${spec} mount refused at ${outcome.step}: ${outcome.reason ?? ''}`);
  return outcome;
};

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
    // The composition host plane (jobs/tokenMeter/userQuestions/shell rows)
    // is what the production serve boot composes — mirror it so the jobs
    // phase drives the REAL LocalJobRegistry, not a stub.
    presetJoin: true,
  });
  emit('spine.booted', { sessionId: SESSION_ID });
  return ctx;
};

const mountPhase = async (ctx) => {
  log.debug('mount phase begin', {});
  for (const spec of ['forms-hello', 'forms-fn', 'forms-service']) {
    await mountOk(ctx, spec);
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

/** ch.5 config: explicit value → apply, missing → schema default, invalid →
 * loud refusal (the ValidationError surfaces as a 'mounted' refusal). */
const configPhase = async (ctx) => {
  log.debug('config phase begin', {});
  await writeTree('forms-config', MANIFEST('forms-config'), CONFIG_SOURCE);
  await mountOk(ctx, 'forms-config', { pluginOpts: { greeting: 'Hola' } });
  demand(globalThis.__formsConfig?.greeting === 'Hola', 'the explicit config value did not reach apply');
  emit('config.validated', { greeting: globalThis.__formsConfig.greeting });
  // The kernel's config-HMR face (fiber.update): validated + restarted IN
  // PLACE — no unmount, no epoch bump; an invalid update leaves the old
  // config running.
  const up = await updateWorkspacePluginConfig('forms-config', { greeting: 'Bonjour' });
  demand(up.updated === true, `config update refused: ${up.step}: ${up.reason ?? ''}`);
  demand(globalThis.__formsConfig?.greeting === 'Bonjour', 'the updated config did not reach apply');
  demand(isMounted('forms-config') === true, 'the update dismounted the plugin');
  emit('config.updated', { greeting: globalThis.__formsConfig.greeting });
  const badUp = await updateWorkspacePluginConfig('forms-config', { greeting: 7 });
  demand(badUp.updated !== true && badUp.step === 'updated'
    && /invalid config/i.test(badUp.reason ?? ''),
  `an invalid config update did not refuse: ${JSON.stringify(badUp)}`);
  demand(globalThis.__formsConfig?.greeting === 'Bonjour', 'the failed update clobbered the running config');
  emit('config.update-invalid', { refused: true });
  void await unmountWorkspacePlugin('forms-config', { prefix: PREFIX });
  await mountOk(ctx, 'forms-config');
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

/** ch.4 events: broadcast, bail short-circuit, serial await, waterfall
 * transform — and unmount detaches the listeners (ctx.on is an effect). */
const eventsPhase = async (ctx) => {
  log.debug('events phase begin', {});
  await writeTree('forms-events', MANIFEST('forms-events'), EVENTS_SOURCE);
  await mountOk(ctx, 'forms-events');
  ctx.emit('forms/ping', {});
  demand(globalThis.__formsEvents?.on === 1, 'the broadcast listener did not run');
  const bail = ctx.bail('forms/check', 'bad');
  demand(bail === 'blocked', `bail did not short-circuit: ${String(bail)}`);
  const wf = await ctx.waterfall('forms/transform', 'hey', async () => 'hey');
  demand(wf === 'hey!', `waterfall did not transform: ${String(wf)}`);
  const serial = await ctx.serial('forms/slow', {});
  demand(serial === 'serial-answer', `serial did not await the listener: ${String(serial)}`);
  await ctx.parallel('forms/parallel', {});
  demand(globalThis.__formsEvents?.par === 1, 'the parallel listener did not run');
  const order = await ctx.waterfall('forms/order', 'x', async () => 'x');
  demand(order === 'head:x-tail', `prepend ordering broken: ${String(order)}`);
  emit('events.observed', { on: 1, bail, wf, serial, parallel: 1, order });
  void await unmountWorkspacePlugin('forms-events', { prefix: PREFIX });
  ctx.emit('forms/ping', {});
  demand(globalThis.__formsEvents?.on === 1, 'the listener survived unmount (ctx.on is not an effect)');
  emit('events.detached', { on: globalThis.__formsEvents.on });
};

/** basic/tool + cookbook/policy: greet executes through the real
 * ToolRuntime under an independent observer; the pre-execute waterfall and
 * the monotonic guard both deny, and both lift when their plugin unmounts. */
const toolPhase = async (ctx) => {
  log.debug('tool phase begin', {});
  await writeTree('forms-greet', MANIFEST('forms-greet'), GREET_SOURCE);
  await writeTree('forms-logger', MANIFEST('forms-logger'), LOGGER_SOURCE);
  await writeTree('forms-policy', MANIFEST('forms-policy'), POLICY_SOURCE);
  for (const spec of ['forms-greet', 'forms-logger', 'forms-policy']) await mountOk(ctx, spec);
  const call = (name) => ctx.tools.execute({
    callId: `forms-greet-${name}`,
    name: 'greet', arguments: { name }, signal: new AbortController().signal,
  });
  const ok = await call('Cordis');
  const text = (ok?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  demand(text === 'Hello, Cordis!', `the greet tool replied "${text}"`);
  const seen = globalThis.__formsLogger?.seen ?? [];
  demand(seen.length === 1 && seen[0].text === text,
    `the tools/result observer missed the call: ${JSON.stringify(seen)}`);
  const denied = await call('Villain');
  demand(denied?.isError === true,
    `the pre-execute policy did not deny: ${JSON.stringify(denied).slice(0, 200)}`);
  emit('policy.denied', { denied: true });
  // post-execute: the third waterfall REWRITES the canonical value and
  // BLOCKS with corrective feedback while the policy plugin is mounted.
  const rewritten = await call('Rewritten');
  const rewrittenText = (rewritten?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  demand(rewrittenText === '[redacted]', `post-execute did not rewrite: "${rewrittenText}" policy=${JSON.stringify(globalThis.__formsPolicy)}`);
  const blockedCall = await call('Blocked');
  demand(blockedCall?.isError === true
    && JSON.stringify(blockedCall.content ?? []).includes('blocks this greeting'),
  `post-execute did not block: ${JSON.stringify(blockedCall).slice(0, 160)}`);
  void await unmountWorkspacePlugin('forms-policy', { prefix: PREFIX });
  const lifted = await call('Villain');
  const liftedText = (lifted?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  demand(liftedText === 'Hello, Villain!', 'the policy survived its plugin unmount');
  // ctx.tools.guard: monotonic — a returned string denies, no later face
  // can force-allow; the disposer lifts it.
  const lift = ctx.tools.guard((exec) => (exec.name === 'greet'
    && exec.arguments?.name === 'Guarded' ? 'guarded name' : undefined));
  const blocked = await call('Guarded');
  demand(blocked?.isError === true, 'the monotonic guard did not deny');
  lift();
  const after = await call('Guarded');
  demand((after?.content ?? []).some((b) => b.text === 'Hello, Guarded!'),
    'the guard survived its disposer');
  for (const spec of ['forms-greet', 'forms-logger']) {
    void await unmountWorkspacePlugin(spec, { prefix: PREFIX });
  }
  emit('tool.greeted', { policed: true, guarded: true, rewritten: 1, blocked: 1 });
};

/** cookbook/background: the real LocalJobRegistry — start → wait → read,
 * and the kill path settles 'killed'. */
const jobsPhase = async (ctx) => {
  log.debug('jobs phase begin', {});
  demand(ctx.get?.('jobs') !== undefined, 'the jobs service is not mounted');
  // Production attaches the controller through dsh-tool-jobs; the seam face
  // is attachController — the leg attaches its own and detaches at the end.
  const detachController = ctx.jobs.attachController('forms-leg');
  const id = ctx.jobs.start({
    kind: 'bash', label: 'forms leg background job',
    run() {
      return {
        cancel() {},
        done: Promise.resolve({ status: 'completed', output: 'forms-job-output' }),
      };
    },
  });
  const settled = await ctx.jobs.wait(id, 5000);
  demand(settled?.status === 'completed', `the job did not complete: ${settled?.status}`);
  const read = ctx.jobs.read(id);
  demand(read.text === 'forms-job-output', `the job output read back "${read.text}"`);
  // A compliant producer: cancel() MUST eventually settle done (the
  // runtime waits for resource release, not merely the kill request).
  let settleSlow;
  const slowDone = new Promise((resolve) => { settleSlow = resolve; });
  const slow = ctx.jobs.start({
    kind: 'bash', label: 'forms leg killed job',
    run() {
      return {
        cancel(reason) { settleSlow({ status: 'killed', detail: reason }); },
        done: slowDone,
      };
    },
  });
  demand(ctx.jobs.kill(slow) === 'requested', 'kill did not request');
  const killed = await ctx.jobs.wait(slow, 5000);
  demand(killed?.status === 'killed', `the killed job settled "${killed?.status}"`);
  detachController();
  emit('jobs.lifecycle', { completed: id, killed: slow });
};

/** ch.3 nested fibers + provide + the dependency cascade: a child mounted
 * through ctx.plugin disposes recursively with its parent; ctx.provide
 * answers; provider unload disposes the dependent, restore reloads it. */
const cascadePhase = async (ctx) => {
  log.debug('cascade phase begin', {});
  await writeTree('forms-nested', MANIFEST('forms-nested'), NESTED_SOURCE);
  await writeTree('forms-customer', MANIFEST('forms-customer'), CUSTOMER_SOURCE);
  await mountOk(ctx, 'forms-nested');
  demand(globalThis.__formsNested?.child === true, 'the nested child did not load');
  demand(ctx.get?.('formsProvided')?.hello() === 'provided', 'ctx.provide did not answer');
  emit('nested.provided', { child: true, provide: true });
  await mountOk(ctx, 'forms-customer');
  demand(globalThis.__formsCustomer?.alive === true, 'the dependent did not load on its required service');
  void await unmountWorkspacePlugin('forms-service', { prefix: PREFIX });
  demand(globalThis.__formsCustomer?.alive === false, 'the dependent survived its provider unload');
  emit('cascade.disposed', { alive: globalThis.__formsCustomer.alive });
  await mountOk(ctx, 'forms-service');
  demand(globalThis.__formsCustomer?.alive === true, 'the dependent did not reload with its service');
  emit('cascade.reloaded', { alive: globalThis.__formsCustomer.alive });
  void await unmountWorkspacePlugin('forms-customer', { prefix: PREFIX });
  const off = await unmountWorkspacePlugin('forms-nested', { prefix: PREFIX });
  demand(off.unmounted === true, 'nested unmount refused');
  demand(globalThis.__formsNested?.child === false, 'the child survived its parent dispose');
  emit('nested.recursive', { child: globalThis.__formsNested.child });
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
 * the stream() call flows through the real LlmRuntime waterfall. */
const llmPhase = async (ctx) => {
  log.debug('llm phase begin', {});
  await writeTree('forms-llm', MANIFEST('forms-llm'), LLM_SOURCE);
  await mountOk(ctx, 'forms-llm');
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
  void await unmountWorkspacePlugin('forms-llm', { prefix: PREFIX });
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
  await configPhase(ctx);
  await eventsPhase(ctx);
  await toolPhase(ctx);
  await jobsPhase(ctx);
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
