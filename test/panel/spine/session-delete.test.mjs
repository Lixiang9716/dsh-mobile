// dsh:logging-exempt (test: the verdict is the assertion output)
/**
 * session-delete.test.mjs — session/delete's SPINE regression guard
 * (node --test, under test/panel/spine/run.sh; the real-runtime suite).
 *
 * WHY THIS EXISTS (T-0210, 2026-10-10): the 2026-10-10 terminal
 * verification left six probe sessions on the device because the Phase-B
 * carrier answered no session/delete (nor any archive) — the page could
 * create sessions but never retire them. The endpoint now lands on the
 * write surface with the vendored teardown semantic (AgentHandle.dispose —
 * the only removal capability the vendored dsh-agent/dsh-session family
 * exposes; no upstream session/delete exists at the pin). This suite pins
 * the contract against the REAL spine:
 *
 *   1. create → prompt (scripted byok turn) → delete answers
 *      `{accepted: true}`; session/list stops carrying the id;
 *      session/page answers session/not-found with the id in details;
 *      a second delete answers session/not-found (the store is the
 *      projection source — nothing was faked);
 *   2. the seeded workspace's sessionIds drop the id (the
 *      workspace/follow baseline matches the list);
 *   3. the boot carrier refuses with gateway/unavailable /
 *      no-dispose-capability (the vendored capability contract: only the
 *      holder tears an agent down, and the loop owns that handle);
 *   4. a RUNNING turn refuses with session/agent-busy /
 *      reason:'running' — cancel is the explicit verb; once the turn
 *      settles the same session deletes cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagedHttp, disposeSeams } from './spine-seams.mjs';

// Anchored at THIS file (never cwd): test/panel/spine → repo root.
const HERE = pathResolve(fileURLToPath(import.meta.url), '..');
const RUNTIME = pathResolve(HERE, '..', '..', '..', 'runtime', 'dsh');
const runtime = (rel) => pathToFileURL(join(RUNTIME, rel)).href;

// The seam install must precede the runtime import (the npm-bridges register
// through __dshModuleDefine at module body time).
await import('./spine-seams.mjs');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** One GLM-shaped single-round SSE body: reasoning, content, finish stop. */
const glmSse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  + 'data: [DONE]\n\n';
const SIMPLE = glmSse([
  { choices: [{ delta: { reasoning_content: 'Acknowledged.' } }] },
  { choices: [{ delta: { content: 'Done.' } }] },
  {
    choices: [{
      delta: {},
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }],
  },
]);

/** Stage the scripted byok endpoint. Round 1 (the first turn) answers at
 * once; round 2 (the running-refusal turn) HOLDS its body for
 * `holdRound2Ms` so the delete probe races a genuinely running turn. */
const stageEndpoint = ({ holdRound2Ms = 0 } = {}) => {
  let round = 0;
  stagedHttp.set('http://127.0.0.1:17890/v1/chat/completions', (args) => {
    round += 1;
    const bodyId = `body:sd-${round}`;
    const delay = round === 2 ? holdRound2Ms : 10;
    setTimeout(() => {
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.body', chunkB64: b64(SIMPLE),
      }));
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.end',
      }));
    }, delay);
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyId };
  });
};

const state = {};
const BOOT_SESSION = 's-spine-boot-0001';
const SETTLE = (label, promise, ms = 30000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(
    () => reject(new Error(`${label} did not settle in ${String(ms)}ms`)), ms)),
]);

/** Poll `probe()` until truthy or the deadline passes (rule 8: conditions,
 * not clocks — the sleep only paces the poll). */
const waitFor = async (probe, label, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} not reached within ${String(ms)}ms`);
};

/** Boot the real spine on the scripted byok route. */
const bootSpine = async () => {
  const { bootUpstream, spineInventory } = await import(runtime('upstream/boot.js'));
  const { createWriteSurface } = await import(runtime('upstream/web-write.js'));
  const { ctx } = await bootUpstream({
    scenario: 'spine.session-delete',
    agentId: 'main',
    sessionId: BOOT_SESSION,
    cwd: '/profiles/default',
    container: {
      cwd: '/profiles/default',
      tmpdir: '/profiles/default/tmp',
      home: '/profiles/default/home',
      scopeRoot: '/profiles',
      env: {},
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: 'http://127.0.0.1:17890/v1',
      apiKey: 'spine-suite-key',
      provider: 'bigmodel',
      model: 'glm-5.3-flash',
      userEndpoint: true,
      adapterName: 'spine suite scripted byok endpoint',
    },
    onEvent: () => {},
  });
  state.ctx = ctx;
  state.spineInventory = spineInventory;
  state.createWriteSurface = createWriteSurface;
};

const writeSurface = (sink) => state.createWriteSurface(state.ctx,
  (f) => sink.push(f), {
    root: '/profiles/default',
    provider: 'bigmodel',
    model: 'glm-5.3-flash',
    baseURL: 'http://127.0.0.1:17890/v1',
    routeKind: 'byok',
    spine: () => state.spineInventory(state.ctx),
    stagedPlugins: () => [],
  });

const remoteThrow = async (invoke) => {
  try {
    await invoke();
  } catch (error) {
    assert.equal(error?.remote, true, 'the refusal left the wire shape');
    return error;
  }
  assert.fail('the handler answered success where a refusal was pinned');
};

test('delete retires a settled session from every projection face', { timeout: 60000 }, async () => {
  stageEndpoint();
  await bootSpine();
  state.write = writeSurface([]);
  const session = 's-spine-delete-0001';

  await state.write.api['session/create']({ sessionId: session });
  const turnEnded = new Promise((resolveTurn) => {
    state.ctx.on('session/event', (updated, event) => {
      if (updated?.id === session && event?.type === 'turn/end') resolveTurn(event);
    });
  });
  await state.write.api['session/prompt']({
    sessionId: session,
    requestId: 'req-sd-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'A turn to retire' }],
  });
  await SETTLE('the turn', turnEnded);

  // The delete itself.
  assert.deepEqual(
    await state.write.api['session/delete']({ request: { sessionId: session } }),
    { accepted: true }, 'delete did not answer accepted');

  // session/list stops carrying the id (and never carried it as running).
  const list = await state.write.api['session/list']({});
  assert.ok(list.items.every((item) => item.sessionId !== session),
    'session/list still carries the deleted id');

  // session/page answers the shared not-found resolution, id in details.
  const pageError = await remoteThrow(() => state.write.api['session/page']({
    request: { address: { kind: 'session', sessionId: session },
      throughSeq: -1, maxMessages: 50 },
  }));
  assert.equal(pageError.code, 'session/not-found');
  assert.equal(pageError.details.sessionId, session);

  // A second delete is the same not-found (the store, not a local flag).
  const again = await remoteThrow(() => state.write.api['session/delete']({
    request: { sessionId: session } }));
  assert.equal(again.code, 'session/not-found');
  assert.equal(again.details.sessionId, session);
});

test('the seeded workspace baseline drops the deleted id', { timeout: 60000 }, async () => {
  // The workspace/follow baseline a page re-attach reads must match the
  // list (session/create attached the id; delete detached it).
  const frames = [];
  const follower = writeSurface(frames);
  follower.openStream({
    streamId: 'ws-baseline',
    endpoint: 'workspace/follow',
    payload: {},
  });
  const baseline = frames.find((f) => f.type === 'mux.item')?.value;
  assert.equal(baseline?.type, 'baseline', 'no workspace baseline frame');
  for (const ws of baseline.value.items) {
    assert.ok(!ws.sessionIds.includes('s-spine-delete-0001'),
      'the workspace baseline still carries the deleted id');
  }
  follower.dispose();
});

test('the boot carrier refuses delete — no dispose capability held here', { timeout: 60000 }, async () => {
  const error = await remoteThrow(() => state.write.api['session/delete']({
    request: { sessionId: BOOT_SESSION } }));
  assert.equal(error.code, 'gateway/unavailable');
  assert.equal(error.details.reason, 'no-dispose-capability');
  assert.equal(error.details.sessionId, BOOT_SESSION);
});

test('a running turn refuses delete; the settled session deletes cleanly', { timeout: 60000 }, async () => {
  // Round 2 holds its SSE body so the turn is genuinely mid-flight.
  stageEndpoint({ holdRound2Ms: 4000 });
  const session = 's-spine-delete-0002';
  await state.write.api['session/create']({ sessionId: session });
  await state.write.api['session/prompt']({
    sessionId: session,
    requestId: 'req-sd-2',
    mode: 'queue',
    content: [{ type: 'text', text: 'A turn to be refused, then retired' }],
  });

  await waitFor(() => state.ctx.agents.get(session)?.status === 'running',
    'the running status');
  const busy = await remoteThrow(() => state.write.api['session/delete']({
    request: { sessionId: session } }));
  assert.equal(busy.code, 'session/agent-busy');
  assert.equal(busy.details.reason, 'running');
  assert.equal(busy.details.sessionId, session);

  // The turn settles; the SAME session now deletes.
  await waitFor(() => state.ctx.agents.get(session)?.status !== 'running',
    'the turn settle');
  assert.deepEqual(
    await state.write.api['session/delete']({ request: { sessionId: session } }),
    { accepted: true }, 'the settled session refused to delete');
  const list = await state.write.api['session/list']({});
  assert.ok(list.items.every((item) => item.sessionId !== session),
    'session/list still carries the second deleted id');
  disposeSeams();
});
