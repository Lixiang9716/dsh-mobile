#!/usr/bin/env node
// dsh:logging-exempt (test driver: the verdict IS the product)
/**
 * session-preset-join.mjs — the T-0209 empirical leg, runnable on any host
 * with node + the vendored closure (no dsh-cli build): it boots the REAL
 * mobile spine through upstream/boot.js with the preset-join seat's exact
 * flag shape (presetJoin + commands + goals + skills), composes the REAL
 * write surface (upstream/web-write.js createWriteSurface), drives the
 * PAGE's own wire (session/create → session/prompt) against a loopback
 * chat-completions capture server, and asserts on the request the model
 * actually receives:
 *
 *   A. presetJoin seat  → the created session's agent composedPreset is
 *      'mobile', the wired system prompt carries the mobile preset's persona
 *      section, and the preset-only tool rows (ask_user_question,
 *      exit_plan_mode, present) are in the wire's tool catalog;
 *   B. no presetJoin    → composedPreset undefined, NO persona section, no
 *      preset-only tools (the empty global layer — the negative control);
 *   C. the join's observability line (the T-0209 fix) lands in the unified
 *      sink naming the session and the preset it composed from — the pair
 *      that settles the vendored publish-time warn from logs alone.
 *
 * The vendored publish warn is EXPECTED for both sessions (it fires inside
 * agents.create, before the join); the assertion is that A is covered
 * anyway — warn-as-noise proven, not assumed.
 *
 * usage: node test/upstream-suite/session-preset-join.mjs
 * preconditions: the vendored closure materialized (vendor/ensure-dsh.sh)
 * AND the node resolution layout (ci/parity-node-modules.sh).
 */
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { AsyncLocalStorage as NodeAls } from 'node:async_hooks';

register('./session-preset-join-hooks.mjs', import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, '../..');
const REG_DIR = pathResolve(HERE, '.runtime-modules');

let failures = 0;
const demand = (cond, what) => {
  if (cond) {
    console.log(`P5_OK ${what}`);
    return;
  }
  failures++;
  console.error(`P5_FAIL ${what}`);
};

// --- the C-host seams the boot graph touches, Node-side ---
mkdirSync(REG_DIR, { recursive: true });
globalThis.__dshModuleDefine = (name, source) => {
  writeFileSync(pathResolve(REG_DIR, encodeURIComponent(name) + '.mjs'), source);
};
const als = new NodeAls();
globalThis.__asyncContextGet = () => als.getStore();
globalThis.__asyncContextSet = (v) => als.enterWith(v);

const NM = pathResolve(ROOT, 'runtime/dsh/vendor/node_modules');
globalThis.__dshBundleRequire = (base, rel) => {
  let baseFile;
  if (typeof base === 'string' && base.startsWith('file:')) {
    baseFile = fileURLToPath(base);
  } else if (typeof base === 'string' && base.startsWith('/')) {
    baseFile = pathResolve(ROOT, 'runtime/dsh', base.slice(1));
  } else if (typeof base === 'string' && !base.startsWith('.') && existsSync(pathResolve(NM, base))) {
    baseFile = pathResolve(NM, base, 'package.json');
  } else {
    baseFile = pathResolve(HERE, String(base));
  }
  return readFileSync(pathResolve(dirname(baseFile), rel), 'utf8');
};

// --- the unified-sink capture (the fix's assertion face) ---
const sinkLines = [];
globalThis.__DSH_LOG_SINK__ = (line) => sinkLines.push(line);

// --- the mobile preset docs, staged patched (the host seed rule) ---
const { patchPresetSeedFiles } = await import('upstream/preset-mobile-rows.js');
const stageDirs = [
  pathResolve(NM, '@deepseek-ai/dsh-agent-presets/presets/mobile'),
  pathResolve(ROOT, 'runtime/dsh/vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile'),
];
{
  const files = {};
  for (const name of ['preset.yml', 'agent.cordis.yml']) {
    files[`/vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile/${name}`] = {
      bytes: new Uint8Array(readFileSync(pathResolve(
        ROOT, 'runtime/dsh/presets-mobile/mobile', name))),
      mtimeMs: 0,
    };
  }
  patchPresetSeedFiles(files);
  for (const dir of stageDirs) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [path, file] of Object.entries(files)) {
      writeFileSync(pathResolve(dir, path.split('/').pop()), file.bytes);
    }
  }
}

// --- the loopback chat-completions capture server ---
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    chunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    chunk({ id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta: { content: 'Hello from upstream' }, finish_reason: null }] });
    chunk({ id: 'c3', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
server.unref(); // the driver's own control flow ends the process — never a live-server hang
const MOCK_URL = `http://127.0.0.1:${server.address().port}/v1`;

const { bootUpstream } = await import('upstream/boot.js');
const { createWriteSurface } = await import('upstream/web-write.js');
const WS = '/p5probe';

const { ctx } = await bootUpstream({
  scenario: 'session.preset-join', agentId: 'p5-agent', sessionId: 's-p5-boot',
  cwd: WS, onEvent: () => {},
  // The preset-join seat's exact flag shape (the harmony seats boot this):
  presetJoin: true,
  commands: true,
  goals: true,
  skills: { dshHome: `${WS}/home`, agentsHome: `${WS}/home/agents`, customSkillDirs: [] },
  container: {
    cwd: WS, tmpdir: `${WS}/tmp`, home: `${WS}/home`, scopeRoot: WS,
    env: {}, argv: ['dsh', '--profile', 'mobile'],
  },
  llm: { baseURL: MOCK_URL, apiKey: 'probe-key', provider: 'mock', model: 'mock-1' },
});

const surface = (presetJoin) => createWriteSurface(ctx, () => {}, {
  root: WS, provider: 'mock', model: 'mock-1', baseURL: MOCK_URL,
  routeKind: 'mock', ...(presetJoin ? { presetJoin: true } : {}),
  spine: () => [], stagedPlugins: () => [],
});

const turn = async (api, requestId) => {
  const before = requests.length;
  const created = await api['session/create']({ request: {} });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${requestId}: session/create minted no session`);
  }
  await api['session/prompt']({ request: {
    sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: 'ping' }],
  } });
  let guard = 0;
  while (ctx.agents.get(sessionId) === undefined && guard++ < 1000000) await Promise.resolve();
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) throw new Error(`${requestId}: the session agent never appeared`);
  await agent.whenIdle();
  for (let i = 0; i < 4000 && requests.length === before; i++) await Promise.resolve();
  if (requests.length === before) throw new Error(`${requestId}: the turn never reached the wire`);
  return { sessionId, request: requests[before], agent };
};

const service = ctx.get('agentPresets');
if (service === undefined) throw new Error('the agentPresets service is not mounted');

// --- A: the presetJoin seat ---
const sinkBeforeA = sinkLines.length;
const a = await turn(surface(true).api, 'p5-req-a');
const joined = service.composedPreset(a.agent.ctx);
demand(joined === 'mobile', `A: composedPreset is 'mobile' (got ${JSON.stringify(joined)})`);
const sysA = (a.request.messages ?? []).filter((m) => m.role === 'system')
  .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
demand(sysA.includes('You are a coding agent powered by'),
  'A: the wired system prompt carries the mobile preset persona section');
demand(sysA.includes('Your working directory is'),
  'A: the wired system prompt carries the persona cwd suffix');
const toolNamesA = (a.request.tools ?? []).map((t) => t.function?.name);
for (const presetOnly of ['ask_user_question', 'exit_plan_mode', 'present']) {
  demand(toolNamesA.includes(presetOnly), `A: the wire tool catalog carries '${presetOnly}' (a preset-only row)`);
}
demand((a.request.messages ?? []).some((m) => m.role === 'user'
  && typeof m.content === 'string' && m.content.includes('ping')),
  'A: the turn is real (the user message reached the wire)');

// --- B: the historical seat (no presetJoin) — the negative control ---
const b = await turn(surface(false).api, 'p5-req-b');
const joinedB = service.composedPreset(b.agent.ctx);
demand(joinedB === undefined, `B: composedPreset stays undefined (got ${JSON.stringify(joinedB)})`);
const sysB = (b.request.messages ?? []).filter((m) => m.role === 'system')
  .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
demand(!sysB.includes('You are a coding agent powered by'),
  'B: NO preset persona in the wired system prompt (the empty global layer)');
const toolNamesB = (b.request.tools ?? []).map((t) => t.function?.name);
for (const presetOnly of ['ask_user_question', 'exit_plan_mode', 'present']) {
  demand(!toolNamesB.includes(presetOnly), `B: '${presetOnly}' absent without the join`);
}

// --- C: the join's observability line (the fix) ---
const joinLines = sinkLines.slice(sinkBeforeA)
  .map((l) => JSON.parse(l))
  .filter((r) => r.module === 'web-write' && r.message === 'session preset joined');
const joinRecord = joinLines.find((r) => r.data?.[0]?.sessionId === a.sessionId);
demand(joinRecord !== undefined && joinRecord.data?.[0]?.preset === 'mobile'
  && joinRecord.level === 'debug',
  `C: the join debug line names session ${a.sessionId} -> 'mobile'`
  + (joinRecord === undefined ? ' (no record)' : ` (got ${JSON.stringify(joinRecord.data)})`));

console.log(`P5_VERDICT ${JSON.stringify({
  joined: { composedPreset: joined, persona: sysA.includes('You are a coding agent powered by'), tools: toolNamesA.length },
  negative: { composedPreset: joinedB ?? null, persona: false, tools: toolNamesB.length },
  joinDebugLine: joinRecord?.data?.[0] ?? null,
})}`);
server.close();
process.exitCode = failures > 0 ? 1 : 0;
