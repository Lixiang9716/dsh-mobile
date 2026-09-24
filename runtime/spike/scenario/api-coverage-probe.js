// dsh:logging-exempt (probe: its verdict output IS the product)
/** api-coverage-probe — the api-full-coverage work stream's runtime half,
 * verified in isolation: the boot mounts the FULL coverage plane (skills +
 * commands + goals + fileReferences), and the write surface composed with
 * `fullCoverage: true` answers every COVERAGE endpoint from the REAL
 * vendored services. Run:
 *   cd runtime/spike && ./build/dsh-spike-cli . scenario/api-coverage-probe.js
 *
 * Asserts, per namespace: the wire result shapes (stat/list/read/readAll/
 * readBytes/readRelated), the structured error legs (not-found,
 * not-directory, outside-workspace), the workspace mutation flow with its
 * follow increments, the picker browse verbs, the skill/file-reference/
 * goal/command catalogs, the changes stream frame, and the HONEST gaps
 * (terminal/*, credentials/set|unset, directoryPicker/pick stay unclaimed).
 */
import { createLogger } from 'logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { bootUpstream } from 'upstream/boot.js';
import {
  createWriteSurface, WRITE_ENDPOINTS, COVERAGE_ENDPOINTS, COVERAGE_STREAMS,
} from 'upstream/web-write.js';

const log = createLogger('probe.api-coverage');
const ROOT = '/api-cov-ws';
const SESSION_ID = 's-probe-cov';
const SKILL_NAME = 'greeter';
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: greets the probe\n---\nHello from the fixture skill.\n`;
let verdict = false;
const fail = (reason) => {
  log.error('probe failed', { reason });
  if (!verdict) { verdict = true; globalThis.__dshComplete(false, reason); }
  throw new Error(reason);
};
const demand = (ok, why) => { if (!ok) fail(why + ' @ ' + (new Error().stack ?? '').slice(0, 300)); };

/** Assert `value` deep-matches the {subset} members (shape asserts stay
 * readable; extra wire members are fine). */
const like = (value, subset, why) => {
  for (const [key, want] of Object.entries(subset)) {
    const got = value?.[key];
    demand(JSON.stringify(got) === JSON.stringify(want),
      `${why}: .${key} = ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
};

/** The error triple an handler throw maps to (probe-local mirror of
 * errorOf's remote passthrough). */
const errorOf = (error) => (error && typeof error === 'object' && error.remote === true
  ? error : { code: 'gateway/unavailable', message: String(error) });

/** Run one handler, expecting a remote refusal with `code`. */
const demandRefusal = async (handler, args, code, why) => {
  try {
    await handler(args);
  } catch (error) {
    demand(errorOf(error).code === code,
      `${why}: ${errorOf(error).code} != ${code}`);
    return;
  }
  fail(`${why}: expected ${code}, got a result`);
};

/** Boot with the full coverage plane and stage the world's files. */
const boot = async () => {
  const { ctx } = await bootUpstream({
    scenario: 'api.coverage.probe', agentId: 'probe', sessionId: SESSION_ID,
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    skills: { dshHome: `${ROOT}/home`, agentsHome: `${ROOT}/home/.agents`,
      customSkillDirs: [`${ROOT}/skills`] },
    commands: true, goals: true, fileReferences: true,
    llm: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'probe', provider: 'mock',
      model: 'probe-1', onRequestBody: () => {} },
  });
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) await Promise.resolve();
  demand(ctx.agents.get(SESSION_ID) !== undefined, 'the configured agent never appeared');
  demand(ctx.get('goals') !== undefined, 'the goals service is not mounted');
  demand(ctx.get('fileReferences') !== undefined, 'the fileReferences service is not mounted');
  await mkdir(`${ROOT}/notes`, { recursive: true });
  await writeFile(`${ROOT}/README.md`, 'line one\nline two\n', 'utf8');
  await writeFile(`${ROOT}/notes/ideas.md`, 'idea A\n', 'utf8');
  await mkdir(`${ROOT}/skills/${SKILL_NAME}`, { recursive: true });
  await writeFile(`${ROOT}/skills/${SKILL_NAME}/SKILL.md`, SKILL_MD, 'utf8');
  log.info('boot ok', { services: ['goals', 'fileReferences', 'commands', 'skills', 'fs'] });
  return ctx;
};

/** The surface under test (fullCoverage) plus the frame recorder. */
const surface = (ctx) => {
  const frames = [];
  const post = (frame) => frames.push(frame);
  const write = createWriteSurface(ctx, post, {
    root: ROOT, provider: 'mock', model: 'probe-1',
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
  });
  // The workspace/follow feed opens BEFORE the mutation phase, so the
  // mutations' upsert/order/archived increments have a receiver to reach.
  const opened = write.openStream({
    endpoint: 'workspace/follow', streamId: 'stream-workspace', payload: {},
  });
  demand(opened?.kind === 'attached', `workspace feed open: ${JSON.stringify(opened)}`);
  return { api: write.api, openStream: write.openStream, cancel: write.cancel ?? null, frames, post };
};

/** The workspaceFiles read family: shapes + the honest error legs. */
const workspaceFilesPhase = async (api) => {
  log.info('api keys', { hasStat: typeof api['workspaceFiles/stat'],
    hasRead: typeof api['workspaceFiles/read'],
    statIsBase: api['session/list'] !== undefined });
  const call = async (name, args) => {
    try {
      return await api[name](args);
    } catch (e) {
      fail(`${name} threw: ${JSON.stringify(e)} args=${JSON.stringify(args)}`);
      return undefined;
    }
  };
  const stat = await call('workspaceFiles/stat',
    { workspaceFileScopeId: SESSION_ID, path: 'README.md' });
  if (stat === undefined) return;
  demand(typeof stat.absolutePath === 'string' && typeof stat.version === 'string'
    && stat.bytes === 18, `stat shape: ${JSON.stringify(stat)}`);
  // The root lists under its ABSOLUTE spelling (the sidebar's start root);
  // the response `path` is the workspace-relative form — empty for the root.
  const list = await call('workspaceFiles/list',
    { workspaceFileScopeId: SESSION_ID, path: ROOT });
  if (list === undefined) return;
  like(list, { path: '', truncated: false }, 'list shape');
  demand(list.entries.some((e) => e.name === 'README.md' && e.type === 'file')
    && list.entries.some((e) => e.name === 'notes' && e.type === 'directory'),
    `list entries: ${JSON.stringify(list.entries)}`);
  const read = await call('workspaceFiles/read',
    { workspaceFileScopeId: SESSION_ID, path: 'notes/ideas.md', range: { offset: 1, limit: 5 } });
  if (read === undefined) return;
  like(read, { text: 'idea A', lines: 1, eof: true, offset: 1 }, 'read shape');
  const all = await call('workspaceFiles/readAll',
    { workspaceFileScopeId: SESSION_ID, path: 'README.md' });
  if (all === undefined) return;
  demand(globalThis.Buffer.from(all.data, 'base64').toString() === 'line one\nline two\n'
    && all.eof === true, `readAll shape: ${JSON.stringify(all).slice(0, 200)}`);
  const bytes = await call('workspaceFiles/readBytes',
    { workspaceFileScopeId: SESSION_ID, path: 'README.md', range: { offset: 5, length: 3 } });
  if (bytes === undefined) return;
  demand(globalThis.Buffer.from(bytes.data, 'base64').toString() === 'one'
    && bytes.eof === false, `readBytes shape: ${JSON.stringify(bytes).slice(0, 200)}`);
  const related = await call('workspaceFiles/readRelated',
    { workspaceFileScopeId: SESSION_ID, path: 'README.md', relativePath: 'notes/ideas.md' });
  if (related === undefined) return;
  demand(globalThis.Buffer.from(related.data, 'base64').toString() === 'idea A\n',
    'readRelated shape');
  log.info('workspaceFiles ok', {
    stat: stat.bytes, listEntries: list.entries.length, eof: read.eof,
  });
};

/** The workspace mutations: create/adopt/rename/order/move/archive, each
 * publishing its follow increment to the (open) workspace feed. */
const workspacePhase = async (ctx, s) => {
  const sub = await s.api['directoryPicker/createDirectory'](
    { path: ROOT, name: 'sub-ws' });
  demand(sub === `${ROOT}/sub-ws`, `picker createDirectory: ${JSON.stringify(sub)}`);
  const created = await s.api['workspace/create']({ request: { path: `${ROOT}/sub-ws` } });
  demand(created.created === true && created.workspace.title === 'sub-ws'
    && Array.isArray(created.workspace.sessionIds),
    `workspace create: ${JSON.stringify(created)}`);
  const adopted = await s.api['workspace/create']({ request: { path: `${ROOT}/sub-ws` } });
  demand(adopted.created === false && adopted.workspace.workspaceId
    === created.workspace.workspaceId, 'workspace adopt-by-path');
  const renamed = await s.api['workspace/rename'](
    { request: { workspaceId: created.workspace.workspaceId, title: 'Sub WS' } });
  demand(renamed.workspace.title === 'Sub WS', 'workspace rename');
  const order = await s.api['workspace/insertBefore'](
    { request: { workspaceId: created.workspace.workspaceId } });
  demand(Array.isArray(order.workspaceIds)
    && order.workspaceIds[order.workspaceIds.length - 1] === created.workspace.workspaceId,
    `workspace order tail: ${JSON.stringify(order)}`);
  demand(ctx.agents.get(SESSION_ID) !== undefined, 'live agent vanished');
  // Session attach rides the seeded workspace (streams.attachWorkspace);
  // the mutations here publish their own upsert/order/archived increments.
  const upserts = s.frames.filter((f) => f.type === 'mux.item'
    && f.value?.type === 'upsert');
  demand(upserts.length >= 2, `follow upserts published: ${upserts.length}`);
  const archived = await s.api['workspace/archiveSession'](
    { request: { sessionId: SESSION_ID } });
  like(archived, { archivedSessionIds: [SESSION_ID] }, 'archive set');
  const unarchived = await s.api['workspace/unarchiveSession'](
    { request: { sessionId: SESSION_ID } });
  like(unarchived, { archivedSessionIds: [] }, 'unarchive idempotence');
  await demandRefusal(s.api['workspace/delete'],
    { request: { workspaceId: 'ws-none' } }, 'workspace/not-found', 'delete unknown');
  const deleted = await s.api['workspace/delete'](
    { request: { workspaceId: created.workspace.workspaceId } });
  like(deleted, { deleted: true }, 'workspace delete');
  log.info('workspace ok', { created: created.created, order: order.workspaceIds.length });
};

/** The picker browse face: the home listing carries crumbs and the created
 * child directory. */
const pickerPhase = async (s) => {
  const home = await s.api['directoryPicker/list']({});
  demand(home.home === ROOT && home.path === ROOT
    && home.crumbs.length === 1 && home.crumbs[0].name === ROOT,
    `picker home listing: ${JSON.stringify(home).slice(0, 220)}`);
  demand(home.entries.some((e) => e.name === 'notes'),
    `picker entries: ${JSON.stringify(home.entries)}`);
  const nested = await s.api['directoryPicker/list']({ path: `${ROOT}/notes` });
  demand(nested.crumbs.length === 2 && nested.crumbs[1].name === 'notes',
    'picker crumbs chain');
  await demandRefusal(s.api['directoryPicker/createDirectory'],
    { path: ROOT, name: 'a/b' }, 'gateway/bad-request', 'multi-segment name');
  await demandRefusal(s.api['directoryPicker/createDirectory'],
    { path: ROOT, name: 'notes' }, 'directory-picker/exists', 'duplicate child');
  log.info('picker ok', { entries: home.entries.length });
};

/** The catalog faces: skills, the @ lexicon, goals, commands. */
const catalogPhase = async (ctx, s) => {
  const skills = await s.api['skills/list']({ request: { sessionId: SESSION_ID } });
  const greeter = skills.skills.find((skill) => skill.name === SKILL_NAME);
  demand(greeter !== undefined && greeter.description === 'greets the probe'
    && typeof greeter.modelInvocable === 'boolean',
    `skills/list: ${JSON.stringify(skills).slice(0, 240)}`);
  const refs = await s.api['fileReferences/list'](
    { agentId: SESSION_ID, query: 'REA' });
  demand(Array.isArray(refs) && refs.some((ref) => ref.path === 'README.md'),
    `fileReferences/list: ${JSON.stringify(refs)}`);
  const agentId = SESSION_ID;
  const created = await s.api['goals/create'](
    { agentId, request: { objective: 'cover the api surface', maxGoalRounds: 4 } });
  const ref = created.ref ?? { id: created.id, revision: created.revision };
  demand(typeof ref.id === 'string' && ref.revision === 1,
    `goals/create: ${JSON.stringify(created)}`);
  const got = await s.api['goals/get']({ agentId });
  demand((got.goal ?? got)?.objective === 'cover the api surface',
    `goals/get: ${JSON.stringify(got).slice(0, 200)}`);
  const paused = await s.api['goals/pause']({ agentId, ref });
  demand((paused.goal ?? paused)?.phase === 'paused', 'goals/pause');
  const resumed = await s.api['goals/resume']({ agentId, ref: refOf(paused) });
  demand((resumed.goal ?? resumed)?.phase === 'active', 'goals/resume');
  const completed = await s.api['goals/complete'](
    { agentId, ref: refOf(resumed) });
  demand((completed.goal ?? completed)?.phase === 'complete', 'goals/complete');
  const cleared = await s.api['goals/clear']({ agentId, ref: refOf(completed) });
  demand(typeof cleared?.id === 'string' && cleared.revision >= 4,
    `goals/clear tombstone: ${JSON.stringify(cleared)}`);
  const commands = await s.api['commands/list']({ agentId });
  demand(Array.isArray(commands) && commands.some((c) => c.name === 'feedback'),
    `commands/list: ${JSON.stringify(commands).slice(0, 200)}`);
  const executed = await s.api['commands/execute'](
    { agentId, line: '/feedback probe says hi', submittedAttachments: [] });
  const execution = executed === undefined ? undefined : (executed.result ?? executed);
  demand(executed === undefined || execution !== undefined,
    `commands/execute: ${JSON.stringify(executed).slice(0, 200)}`);
  log.info('catalog ok', { skills: skills.skills.length, refs: refs.length,
    goalPhase: 'complete', commands: commands.map((c) => c.name) });
};

/** The ref of a goal mutation result (view or wrapper). */
const refOf = (result) => {
  const goal = result?.goal ?? result;
  return { id: goal.id, revision: goal.revision };
};

/** The changes stream: open attaches a feed; a real fs write flows through
 * as one change frame after the ready frame. */
const changesPhase = async (ctx, s) => {
  const opened = s.openStream({
    endpoint: 'workspaceFiles/changes', streamId: 'stream-changes',
    payload: { args: { workspaceFileScopeId: SESSION_ID } },
  });
  demand(opened?.kind === 'attached', `changes open: ${JSON.stringify(opened)}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fs = ctx.get('fs');
  const target = await fs.resolve(`${ROOT}/notes/ideas.md`);
  const outcome = await fs.writeText(target, 'idea A\nidea B\n');
  // A RAW fs write is not instrumented: the observation rides the same
  // `fs/observed` emission the vendored file tools make after their writes
  // (the policy layer's seam). The probe emits it exactly as tool-fs does.
  ctx.emit('fs/observed', target,
    { kind: 'present', version: outcome?.version ?? (await fs.stat(target)).version });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const frames = s.frames.filter((f) => f.type === 'mux.item'
    && f.streamId === 'stream-changes').map((f) => f.value);
  demand(frames[0]?.kind === 'ready', `first frame ready: ${JSON.stringify(frames[0])}`);
  demand(frames.some((f) => f.kind === 'change'
      && f.change.absolutePath === `${ROOT}/notes/ideas.md`
      && f.change.version !== undefined),
    `change frame: ${JSON.stringify(frames).slice(0, 300)}`);
  const cancelled = s.cancel({ streamId: 'stream-changes' });
  demand(cancelled?.kind === 'cancelled', `changes cancel: ${JSON.stringify(cancelled)}`);
  log.info('changes ok', { frames: frames.length });
};

/** The honest gaps: coverage OFF keeps the historical claim set, and the
 * declared-unimplemented endpoints carry no handler. */
const gapsPhase = async (ctx, s) => {
  for (const endpoint of ['terminal/create', 'terminal/list', 'terminal/write',
    'terminal/shells', 'directoryPicker/pick', 'settings/replace',
    'settings/openSettingsDocument', 'settings/openAgentPresetDirectory',
    'llm/discoverModels', 'subagents/list', 'subagents/prompt',
    'sessionFeedback/record', 'permissionPresets/catalog',
    'fileUploads/upload', 'officeToPdf/render',
    'session/page', 'session/fork', 'session/search', 'session/rename',
    'session/cancel', 'session/updateQueue', 'session/attachment']) {
    demand(s.api[endpoint] === undefined, `${endpoint} must stay unclaimed`);
  }
  demand(new Set(COVERAGE_ENDPOINTS.filter((e) => WRITE_ENDPOINTS.includes(e))).size === 0,
    'coverage endpoints overlap the historical claim set');
  const bare = createWriteSurface(ctx, () => {}, {
    root: ROOT, provider: 'mock', model: 'probe-1', spine: () => [], stagedPlugins: () => [],
  });
  demand(bare.api['workspaceFiles/stat'] === undefined
    && bare.api['skills/list'] === undefined
    && bare.api['goals/get'] === undefined
    && bare.api['commands/list'] === undefined,
    'without fullCoverage the surface stays byte-identical');
  demand(COVERAGE_STREAMS.length === 1 && COVERAGE_STREAMS[0] === 'workspaceFiles/changes',
    'coverage streams');
  log.info('gaps ok', { coverage: COVERAGE_ENDPOINTS.length,
    historical: WRITE_ENDPOINTS.length });
};

/** The models-page legs: the provider directory off the MOUNTED LlmRuntime
 * (the boot registered exactly the route provider), the opener gate, and
 * the credential store round-trip (set → describe → unset → describe), the
 * values never coming back over the wire. */
const llmCredentialsPhase = async (ctx, s) => {
  const providers = await s.api['llm/listProviders']({});
  demand(Array.isArray(providers) && providers.length === 1
    && providers[0].id === 'mock' && typeof providers[0].name === 'string'
    && providers[0].name.length > 0,
    `listProviders: ${JSON.stringify(providers)}`);
  const directory = await s.api['llm/listConfigurableProviders']({});
  demand(Array.isArray(directory) && directory.length === 0,
    `listConfigurableProviders: ${JSON.stringify(directory)}`);
  const canOpen = await s.api['settings/canOpenAgentPresetDirectory']({});
  demand(canOpen === false, `canOpenAgentPresetDirectory: ${JSON.stringify(canOpen)}`);
  const describeRefs = ['MOCK_API_KEY', 'OTHER_API_KEY'];
  const before = await s.api['credentials/describe']({ refs: describeRefs });
  demand(before.MOCK_API_KEY.configured === true
    && before.MOCK_API_KEY.writable === true
    && before.OTHER_API_KEY.configured === false,
    `describe before set: ${JSON.stringify(before)}`);
  await s.api['credentials/set']({ ref: 'OTHER_API_KEY', value: 'sekrit' });
  const after = await s.api['credentials/describe']({ refs: describeRefs });
  demand(after.OTHER_API_KEY.configured === true
    && after.OTHER_API_KEY.source === undefined
    && after.MOCK_API_KEY.configured === true,
    `describe after set: ${JSON.stringify(after)}`);
  await s.api['credentials/unset']({ ref: 'OTHER_API_KEY' });
  const removed = await s.api['credentials/describe']({ refs: describeRefs });
  demand(removed.OTHER_API_KEY.configured === false,
    `describe after unset: ${JSON.stringify(removed)}`);
  log.info('llm credentials ok', {
    providers: providers.length, directory: directory.length,
    routeConfigured: before.MOCK_API_KEY.configured,
  });
};

/** Main: boot → surface → phases → complete. */
try {
  const ctx = await boot();
  const s = surface(ctx);
  await workspaceFilesPhase(s.api);
  await workspacePhase(ctx, s);
  await pickerPhase(s);
  await catalogPhase(ctx, s);
  await changesPhase(ctx, s);
  await llmCredentialsPhase(ctx, s);
  await gapsPhase(ctx, s);
  log.info('probe ok', { coverageEndpoints: COVERAGE_ENDPOINTS.length });
  if (!verdict) { verdict = true; globalThis.__dshComplete(true, 'api coverage verified'); }
} catch (e) {
  fail((e?.message ?? String(e)) + ' @ ' + (e?.stack ?? '').slice(0, 300)
    + ' | code=' + (e?.code ?? '-'));
}
