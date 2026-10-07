/**
 * Agent-flow scenario `agent.flow` — prompt override + skill loading over the
 * vendored upstream skill family, in ONE session (the 打通流程 E2E).
 *
 * Flow: the mobile profile boot (upstream/boot.js) mounts the vendored skill
 * family beside the spine — dsh-skill (the `ctx.skills` registry),
 * dsh-skill-filesystem (project/custom/user discovery over the `fs` service,
 * mounted with `watch:false`: the runtime has no fs-event/timer seam for
 * chokidar, which the npm-bridges seam answers with a loud linkage shim),
 * dsh-tool-skill (the model-facing `skill` tool + durable session catalog) —
 * and the SystemPrompt's own personaPrefix override. The scenario then:
 *   1. stages a minimal fixture skill (`<root>/skills/greeter/SKILL.md`,
 *      YAML frontmatter name+description) into the workspace VFS;
 *   2. discovery: `ctx.skills.list()` merges the provider catalog and lists it;
 *   3. the `skill` TOOL resolves + returns the fixture instructions;
 *   4. ONE mock-LLM turn whose captured wire REQUEST carries the override in
 *      its system message and the `skill` tool in its tools array, and whose
 *      session log carries the tool-skill catalog message;
 *   5. a SECOND turn driven by a scripted `skill` tool-call: the REAL agent
 *      loop dispatches it through the ToolRuntime, the fixture instructions
 *      come back as the tool result, and that result feeds the closing LLM
 *      request (role `tool` message carrying the instruction line).
 * Every expected event emits exactly one structured log entry, in the order
 * declared by test/e2e/scenarios/agent-flow.json. Host adaptation follows
 * scenario/upstream-parity.js (CLI launch-env snapshot, or the Android
 * runtime.config bus); the mock endpoint facts are the same either way.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'agent.flow';
const AGENT_ID = 'main';
const SESSION_ID = 's-agent-flow-0001';
const SYSTEM_OVERRIDE = 'AGENT-FLOW OVERRIDE 7f3a91: greet in Latin.';
const SKILL_NAME = 'greeter';
const SKILL_LINE = 'Greet the user by saying MARCO-42.';
const SKILL_MD = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: Greets the user following the agent-flow protocol.',
  '---',
  '',
  SKILL_LINE,
  '',
].join('\n');
const TURN1_TEXT = 'Say hello';
const TURN2_TEXT = 'Load the skill and follow it';
const EXPECTED_TEXT = 'Hello from upstream'; // the mock server's successText

const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  const withStack = error?.stack
    ? `${message} | ${error.stack.split('\n').slice(0, 4).join(' / ')}`
    : message;
  log.debug('scenario failed', { reason: withStack });
  emit('scenario.failed', { reason: withStack });
  globalThis.__dshComplete(false, withStack);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/** Host adaptation — the same two shapes upstream-parity accepts: the CLI's
 * launch-env snapshot (--env KEY=VALUE) or the Android runtime.config bus. */
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

const hostFacts = async () => {
  log.debug('host facts begin', {});
  const raw = globalThis.__dshLaunchEnv?.();
  let cliEnv = null;
  if (typeof raw === 'string') {
    try { cliEnv = JSON.parse(raw); } catch { cliEnv = null; }
  }
  if (cliEnv !== null && typeof cliEnv.DSH_MOCK_LLM_URL === 'string') {
    return { env: cliEnv, mockLlmUrl: cliEnv.DSH_MOCK_LLM_URL, mockLlmKey: cliEnv.DSH_MOCK_LLM_KEY, root: null };
  }
  const cfg = await takeRuntimeConfig();
  demand(typeof cfg.mockLlmUrl === 'string' && cfg.mockLlmUrl.startsWith('http://127.0.0.1:'),
    `runtime.config mock endpoint missing: ${JSON.stringify(cfg.mockLlmUrl)}`);
  return {
    env: { DSH_MOCK_LLM_URL: cfg.mockLlmUrl, DSH_MOCK_LLM_KEY: cfg.apiKey },
    mockLlmUrl: cfg.mockLlmUrl,
    mockLlmKey: cfg.apiKey,
    root: cfg.containerRoot ?? null,
  };
};

/** Captured wire request bodies (llm-transport's onRequestBody hook) — the
 * prompt-override and tool-round evidence. Buffered during the turn, asserted
 * and emitted in a fixed order afterwards. */
const wireBodies = [];

const bootPhase = async (facts) => {
  log.debug('boot phase begin', {});
  let root = facts.root;
  if (root === null) {
    const resolved = await fsScope.resolve('scope://app/');
    root = resolved?.path;
  }
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(root)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root,
    onEvent: emit,
    container: {
      cwd: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      env: facts.env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    // The prompt-override seam: the vendored SystemPrompt's own personaPrefix
    // config (the prompt's persona section), riding every assembled request.
    systemPrompt: { personaPrefix: SYSTEM_OVERRIDE },
    // The SKILL row: the vendored skill family over a staged fixture dir.
    skills: {
      dshHome: `${root}/home`,
      agentsHome: `${root}/home/.agents`,
      customSkillDirs: [`${root}/skills`],
    },
    llm: {
      baseURL: facts.mockLlmUrl,
      apiKey: facts.mockLlmKey,
      provider: 'mock',
      model: 'mock-1',
      onRequestBody: (body) => wireBodies.push(body),
    },
  });
  log.debug('boot phase done', { root });
  return { ctx, root };
};

/** The skill plane mounted: the registry service, the model-facing tool, and
 * the filesystem provider answering through discovery (the mounted truth —
 * the same style tool-fs-probe verifies the file-tools row with). */
const skillPlanePhase = (ctx) => {
  log.debug('skill plane phase begin', {});
  demand(ctx.get('skills') !== undefined, 'the skills registry service is not mounted');
  const tool = ctx.tools.get('skill');
  demand(tool !== undefined, 'the skill tool is not registered');
  emit('skill/plane/mounted', { service: 'skills', tool: 'skill', registry: 'vendored @deepseek-ai/dsh-skill' });
};

/** Stage the fixture skill AFTER boot (the workspace world mounts at boot),
 * then prove discovery: the registry's merged catalog lists it. */
const discoveryPhase = async (ctx, root) => {
  log.debug('discovery phase begin', {});
  const dir = `${root}/skills/${SKILL_NAME}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/SKILL.md`, SKILL_MD, 'utf8');
  emit('fixture/staged', { path: `${dir}/SKILL.md`, bytes: SKILL_MD.length });
  const skills = await ctx.skills.list({ cwd: root });
  const greeter = skills.find((skill) => skill.name === SKILL_NAME);
  demand(greeter !== undefined, `skill "${SKILL_NAME}" not discovered: ${JSON.stringify(skills.map((s) => s.name))}`);
  emit('skills/listed', { names: skills.map((skill) => skill.name), source: greeter.source, provider: greeter.provider });
};

/** The `skill` tool through the REAL ToolRuntime dispatch: resolution +
 * instructions. */
const toolLoadPhase = async (ctx) => {
  log.debug('tool load phase begin', {});
  const outcome = await ctx.tools.execute({
    name: 'skill',
    arguments: { name: SKILL_NAME },
    callId: `${SCENARIO}.skill-load`,
    signal: new AbortController().signal,
  });
  demand(outcome.isError !== true, `the skill tool failed: ${JSON.stringify(outcome).slice(0, 300)}`);
  demand(outcome.value?.content === SKILL_LINE,
    `the skill tool returned unexpected content: ${JSON.stringify(outcome.value).slice(0, 300)}`);
  emit('skill/loaded', { name: outcome.value.name, provider: outcome.value.provider });
};

/** Wait (bounded, fail loud) for the configured agent — creation is async
 * past the AgentLoop mount (the upstream-parity wait). */
const awaitAgent = async (ctx) => {
  log.debug('await agent begin', { sessionId: SESSION_ID });
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get(SESSION_ID) !== undefined, `agent "${SESSION_ID}" never appeared in the registry`);
  demand(ctx.sessions.get(SESSION_ID) !== undefined, `session "${SESSION_ID}" never appeared in the store`);
  return ctx.agents.get(SESSION_ID);
};

const driveTurn = async (agent, text) => {
  log.debug('drive turn', { text });
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

const wireSystemMessage = (body) =>
  (Array.isArray(body?.messages) ? body.messages : []).find((message) => message.role === 'system');

/** Turn 1: the prompt-override turn. Asserts on the CAPTURED wire request
 * (the system message carries the override; the tools array carries the
 * skill tool), on the assistant text, and on the durable session catalog the
 * tool-skill pre-step listener published. */
const overridePhase = (ctx, session) => {
  log.debug('override phase begin', {});
  const body = wireBodies[wireBodies.length - 1];
  demand(body !== undefined, 'no wire request was captured');
  const system = wireSystemMessage(body);
  demand(system !== undefined, `no system message in the wire request: ${JSON.stringify(body.messages?.map((m) => m.role))}`);
  demand(system.content.includes(SYSTEM_OVERRIDE) === true,
    `the system message misses the override: ${JSON.stringify(system.content.slice(0, 160))}`);
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name) : [];
  demand(tools.includes('skill') === true, `the wire request's tools miss "skill": ${JSON.stringify(tools)}`);
  emit('prompt/override/asserted', { role: 'system', override: SYSTEM_OVERRIDE, toolsCarrySkill: true });

  const events = session.snapshotEvents();
  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, 'no assistant/message in the session log');
  const text = (assistant.data?.message?.content ?? assistant.data?.content ?? [])
    .filter((block) => block.type === 'text').map((block) => block.text).join('');
  demand(text === EXPECTED_TEXT, `assistant text is "${text}"`);
  emit('turn/completed', { turn: 1, text });

  const catalog = events.find((record) => record.type === 'user/message'
    && (record.data?.source?.kind ?? record.data?.message?.source?.kind) === 'skill-catalog');
  demand(catalog !== undefined, 'no skill-catalog record in the session log');
  const catalogMessage = catalog.data?.source !== undefined ? catalog.data : catalog.data?.message;
  const entries = catalogMessage?.source?.entries ?? [];
  demand(entries.some((entry) => entry.name === SKILL_NAME),
    `the catalog entries miss "${SKILL_NAME}": ${JSON.stringify(entries)}`);
  emit('catalog/published', { entries: entries.map((entry) => entry.name) });
};

/** Turn 2: the mock streams a `skill` tool-call; the REAL agent loop
 * dispatches it through the ToolRuntime, the fixture instructions come back,
 * and the closing wire request carries them as a role `tool` message. */
const toolRoundPhase = (ctx, session) => {
  log.debug('tool round phase begin', {});
  const events = session.snapshotEvents();
  const call = events.find((record) => record.type === 'tool/call'
    && (record.data?.tool === 'skill' || record.data?.name === 'skill'));
  demand(call !== undefined, 'no tool/call for the skill tool in the session log');
  const callArguments = call.data?.arguments;
  demand(typeof callArguments === 'string' && callArguments.includes(`"${SKILL_NAME}"`) === true,
    `the skill tool-call arguments are not the fixture name: ${JSON.stringify(callArguments)}`);
  emit('tool/called', { tool: 'skill', arguments: callArguments });

  const result = events.filter((record) => record.type === 'tool/result').pop();
  const resultText = JSON.stringify(result?.data ?? {});
  demand(resultText.includes(SKILL_LINE), `the tool/result misses the instructions: ${resultText.slice(0, 260)}`);
  emit('tool/result/asserted', { tool: 'skill', hasInstructions: true });

  const closing = wireBodies[wireBodies.length - 1];
  const fed = (Array.isArray(closing?.messages) ? closing.messages : [])
    .some((message) => message.role === 'tool' && (message.content ?? '').includes('MARCO-42'));
  demand(fed === true, 'the closing wire request carries no role-tool message with the instructions');
  emit('tool/result/fed/request', { role: 'tool' });
  emit('turn/completed', { turn: 2, toolRound: true });
};

const main = async () => {
  log.debug('main begin', {});
  const facts = await hostFacts();
  const { ctx, root } = await bootPhase(facts);
  emit('session/created', { sessionId: SESSION_ID });
  emit('agent/created', { id: AGENT_ID, sessionId: SESSION_ID });

  skillPlanePhase(ctx);
  await discoveryPhase(ctx, root);
  await toolLoadPhase(ctx);

  const agent = await awaitAgent(ctx);
  await driveTurn(agent, TURN1_TEXT);
  overridePhase(ctx, ctx.sessions.get(SESSION_ID));

  await driveTurn(agent, TURN2_TEXT);
  toolRoundPhase(ctx, ctx.sessions.get(SESSION_ID));

  emit('upstream/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    skills: 'vendored dsh-skill + skill-filesystem + tool-skill over the gateway fs',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
