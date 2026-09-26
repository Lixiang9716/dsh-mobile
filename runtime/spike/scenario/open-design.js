/**
 * Open Design scenario `open.design` — the dsh-open-design system plugin
 * driving the Open Design daemon over gateway httpFetch.
 *
 * Flow: the mobile profile boot mounts the plugin beside the spine (the
 * launch env carries DSH_OPEN_DESIGN_URL + the BYOK route). The daemon is
 * the loopback mock (ci/mock-open-design-server.mjs — the same test-vehicle
 * pattern as the mock LLM), and the scenario drives the REAL ToolRuntime
 * dispatch of the three tools:
 *
 *   1. offered: the configured host serves all three open_design tools;
 *   2. projects.create → list → get → save_file, the daemon round-trips;
 *   3. generate: the BYOK proxy leg — the daemon streams the artifact as
 *      SSE deltas, the plugin reassembles it (the OD-MOCK-77f3 marker
 *      proves the deltas arrived intact, not a swallowed stream);
 *   4. artifact save (shareable URL) + lint (the daemon's findings);
 *   5. negative: an unknown verb names the valid verbs instead of throwing.
 *
 * Every expected event emits exactly one structured log entry, in the order
 * declared by test/e2e/scenarios/open-design.json; artifacts land under
 * runtime/spike/artifacts/macos-cli-open-design/.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'open.design';
const AGENT_ID = 'main';
const SESSION_ID = 's-open-design-0001';
const MARKER = 'OD-MOCK-77f3';

const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
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

const launchEnv = () => {
  log.debug('launch env phase begin', {});
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};

/** One tool call through the REAL ToolRuntime dispatch, returning the
 * plugin's structured outcome ({ok, result}). */
const call = async (ctx, name, args) => {
  log.debug('tool dispatch', { name });
  const outcome = await ctx.tools.execute({
    name,
    arguments: args,
    callId: `${SCENARIO}.${name}`,
    signal: new AbortController().signal,
  });
  demand(outcome?.isError !== true, `${name} dispatch failed: ${JSON.stringify(outcome?.error ?? outcome).slice(0, 300)}`);
  const value = outcome.value;
  demand(value !== undefined && typeof value.result === 'string', `${name} returned no result text`);
  return value;
};

const bootPhase = async (env) => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
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
      env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: env.DSH_MOCK_LLM_URL,
      apiKey: env.DSH_MOCK_LLM_KEY,
      provider: 'mock',
      model: 'mock-1',
    },
  });
  log.debug('boot phase done', { root });
  return ctx;
};

const offeredPhase = (ctx) => {
  log.debug('offered phase begin', {});
  const visible = ctx.tools?.view?.(undefined)?.visible;
  demand(visible instanceof Map, 'the tool layer exposed no visibility view');
  const names = ['open_design_projects', 'open_design_generate', 'open_design_artifact'];
  for (const name of names) {
    demand(visible.has(name), `the open_design tool ${name} is not offered`);
  }
  emit('od/offered', { tools: names.length });
};

const projectsPhase = async (ctx) => {
  log.debug('projects phase begin', {});
  const created = JSON.parse(await call(ctx, 'open_design_projects', {
    verb: 'create', name: 'Aurora Deck', kind: 'prototype',
  }).then((v) => v.result));
  demand(created.ok === true && typeof created.project?.id === 'string', `create failed: ${JSON.stringify(created).slice(0, 200)}`);
  emit('od.project/created', { id: created.project.id, name: created.project.name });

  const listed = JSON.parse(await call(ctx, 'open_design_projects', { verb: 'list' }).then((v) => v.result));
  demand(listed.ok === true && listed.count === 1, `list failed: ${JSON.stringify(listed).slice(0, 200)}`);
  emit('od.project/listed', { count: listed.count });

  const detail = JSON.parse(await call(ctx, 'open_design_projects', {
    verb: 'get', id: created.project.id,
  }).then((v) => v.result));
  demand(detail.ok === true && detail.project?.id === created.project.id, `get failed: ${JSON.stringify(detail).slice(0, 200)}`);
  emit('od.project/fetched', { files: Array.isArray(detail.files) ? detail.files.length : 0 });

  const saved = JSON.parse(await call(ctx, 'open_design_projects', {
    verb: 'save_file', id: created.project.id, fileName: 'index.html', content: '<!DOCTYPE html><title>seed</title>',
  }).then((v) => v.result));
  demand(saved.ok === true && saved.file?.name === 'index.html', `save_file failed: ${JSON.stringify(saved).slice(0, 200)}`);
  emit('od.project/fileSaved', { name: saved.file.name, size: saved.file.size });

  return created.project.id;
};

const generatePhase = async (ctx, projectId) => {
  log.debug('generate phase begin', {});
  const outcome = JSON.parse(await call(ctx, 'open_design_generate', {
    prompt: 'A dark aurora-themed landing card.',
    projectId,
  }).then((v) => v.result));
  demand(outcome.ok === true, `generate failed: ${JSON.stringify(outcome).slice(0, 200)}`);
  demand(outcome.model === 'mock-designer-1', `generate lost the model: ${JSON.stringify(outcome.model)}`);
  demand(outcome.artifact.includes(MARKER), 'the reassembled artifact misses the mock marker');
  emit('od.generate/completed', { model: outcome.model, chars: outcome.chars });
  return outcome.artifact;
};

const artifactPhase = async (ctx, html) => {
  log.debug('artifact phase begin', {});
  const saved = JSON.parse(await call(ctx, 'open_design_artifact', {
    verb: 'save', identifier: 'od-proj-001', title: 'Aurora Deck', html,
  }).then((v) => v.result));
  demand(saved.ok === true && typeof saved.url === 'string' && typeof saved.path === 'string',
    `save failed: ${JSON.stringify(saved).slice(0, 200)}`);
  emit('od.artifact/saved', { url: saved.url, path: saved.path });

  const linted = JSON.parse(await call(ctx, 'open_design_artifact', { verb: 'lint', html })
    .then((v) => v.result));
  demand(linted.ok !== false && Array.isArray(linted.findings) && linted.findings.length === 1,
    `lint failed: ${JSON.stringify(linted).slice(0, 200)}`);
  emit('od.artifact/linted', { findings: linted.findings.length, severity: linted.findings[0].severity });
};

const negativePhase = async (ctx) => {
  log.debug('negative phase begin', {});
  const refused = await call(ctx, 'open_design_projects', { verb: 'explode' });
  demand(refused.ok === false, 'an unknown verb did not refuse');
  demand(refused.result.includes('list|get|create|update|delete|save_file'),
    `the refusal does not name the verbs: ${refused.result.slice(0, 120)}`);
  emit('od.verb/refused', { named: true });
};

const main = async () => {
  log.debug('main begin', {});
  const env = launchEnv();
  demand(typeof env.DSH_OPEN_DESIGN_URL === 'string' && env.DSH_OPEN_DESIGN_URL.startsWith('http://127.0.0.1:'),
    `the daemon URL is not the loopback mock: ${JSON.stringify(env.DSH_OPEN_DESIGN_URL)}`);
  const ctx = await bootPhase(env);
  emit('session/created', { sessionId: SESSION_ID });
  emit('agent/created', { id: AGENT_ID, sessionId: SESSION_ID });

  offeredPhase(ctx);
  const projectId = await projectsPhase(ctx);
  const html = await generatePhase(ctx, projectId);
  await artifactPhase(ctx, html);
  await negativePhase(ctx);

  emit('upstream/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    openDesign: 'system-plugins/dsh-open-design over gateway httpFetch',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
