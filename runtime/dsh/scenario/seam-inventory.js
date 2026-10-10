/**
 * Scenario `seam.inventory` — the runtime answer to the upstream capability
 * seams catalog (reference/capability-seams): boot the PRODUCTION-EQUIVALENT
 * mobile spine (every product flag on, composition plane included), then
 * report which cordis services actually resolve and which plugin runtimes
 * the registry holds. The gap against the upstream catalog is classified in
 * docs/plugin-dev.md — mounted / host-gateway equivalent / mobile wall /
 * desktop-only.
 *
 * Deterministic; no model. Artifacts:
 * runtime/dsh/artifacts/macos-cli-seam-inventory/.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'seam.inventory';
const AGENT_ID = 'main';
const SESSION_ID = 's-seam-inventory-0001';

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

/** The upstream catalog's service names that a mobile host could
 * plausibly serve, plus the mobile spine's own mounts. The probe reads
 * each through the service resolver — the same truth inject sees. */
const CANDIDATES = [
  // the mobile spine's core (expected present)
  'sessions', 'agents', 'systemPrompt', 'tools', 'sessionProjections',
  'settings', 'agentLoop', 'llm', 'tokenMeter', 'jobs', 'userQuestions',
  'subagentModelSelection', 'shell', 'shellEnv',
  // the coverage/composition planes (gated rows) — the vendored classes
  // register under the PLURAL names (goal@… super(ctx, "goals"), etc.)
  'goals', 'commands', 'agentPresets', 'skills', 'fileReferences',
  // vendored seams the closure carries — presence is the finding
  'credentials', 'approval', 'web', 'compaction', 'sessionPersistence',
  'sessionQuery', 'sessionTitle', 'attachments', 'schedule', 'planMode',
  'messageFeedback', 'sessionFeedback', 'invariant', 'configEditor',
  'setting', 'workspaceRegistry', 'mcpResources', 'spillStore',
  'subprocess', 'sandbox', 'terminals', 'workflowEngine', 'lsp',
];

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
    // The production serve seat's identity: every product plane on,
    // including the skills plane (the harmony-composer spelling: dshHome on
    // the container home, agentsHome under it, no custom dirs).
    presetJoin: true, commands: true, goals: true,
    fileReferences: true, creation: true,
    skills: { dshHome: `${root}/home`, agentsHome: `${root}/home/agents`,
      customSkillDirs: [] },
  });
  emit('spine.booted', { sessionId: SESSION_ID });
  return ctx;
};

/** The Context/Registry/Fiber/Service API reference
 * (reference/cordis-api/*): every documented kernel member exists on THIS
 * engine — the plugin-author contract holds verbatim. */
const cordisFacePhase = async (ctx) => {
  log.debug('cordis face begin', {});
  const methods = ['plugin', 'inject', 'get', 'set', 'provide', 'accessor',
    'mixin', 'extend', 'isolate', 'intercept', 'effect', 'on', 'once',
    'emit', 'bail', 'serial', 'waterfall', 'parallel'];
  const missing = methods.filter((m) => typeof ctx[m] !== 'function');
  demand(missing.length === 0, `cordis Context API methods missing: ${missing.join(', ')}`);
  // The service-instance members (the doc's own spelling: ctx.events IS the
  // EventsService, ctx.registry the RegistryService, ctx.reflect the
  // reflection layer, ctx.fiber the owning fiber, ctx.logger the logger).
  const instances = ['registry', 'reflect', 'logger', 'events', 'fiber'];
  const absentInstances = instances.filter((m) => ctx[m] == null);
  demand(absentInstances.length === 0,
    `cordis Context API service members missing: ${absentInstances.join(', ')}`);
  // The Service API's kernel symbols (reference/cordis-api/service): every
  // documented static exists on the vendored Service base.
  const { Service } = await import('@deepseek-ai/cordis');
  const symbols = ['init', 'check', 'config', 'invoke', 'extend', 'tracker',
    'resolveConfig'];
  const missingSymbols = symbols.filter((k) => typeof Service[k] !== 'symbol');
  demand(missingSymbols.length === 0,
    `cordis Service kernel symbols missing: ${missingSymbols.join(', ')}`);
  emit('cordis.face', { methods: methods.length, instances: instances.length,
    serviceSymbols: symbols.length });
};

const main = async () => {
  log.debug('main begin', {});
  const ctx = await bootPhase();

  // The registry inventory (cordis-tutorial ch.6's diagnostic walk): every
  // plugin runtime the composition actually holds, sorted.
  const runtimes = [];
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers ?? []) {
      if (fiber?.name) runtimes.push(fiber.name);
    }
  }
  const registry = [...new Set(runtimes)].sort();
  demand(registry.length > 0, 'the registry walk found no fibers');

  // The service probe: one resolver read per candidate name.
  const present = [];
  const absent = [];
  for (const name of CANDIDATES) {
    if (ctx.get(name) !== undefined) present.push(name);
    else absent.push(name);
  }
  demand(present.includes('sessions') && present.includes('tools')
    && present.includes('llm') && present.includes('jobs'),
  `the core spine services are not all present: ${JSON.stringify(present)}`);
  emit('inventory.probed', { present, absent });

  await cordisFacePhase(ctx);

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'pass');
};

main().catch((error) => fail(error));
