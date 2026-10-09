// dsh:logging-exempt (test: the verdict is the assertion output)
/**
 * watchdog-abort-wire.test.mjs — the AR abort-render seam's SPINE regression
 * guard (node --test, under test/panel/spine/run.sh; the real runtime over
 * the vendored closure, the same harness as composer-journal.test.mjs).
 *
 * THE DEFECT (the P1 #432 measured face, made user-visible): the vendored
 * chat page renders a failure notice only for turn/end reasons of kind
 * "error" (dsh-client-ui-chat failureFrom) and silence for "aborted" — and
 * the vendored agent-loop classifies EVERY cancel as aborted (the kill rides
 * agent.cancel(cause) → phase.abort.abort(cause); the loop's catch turns any
 * aborted signal into {kind:"aborted", reason: cause}). A watchdog kill — a
 * system failure the user did not choose — therefore rendered a BLANK reply.
 *
 * THE SEAM THIS PINS: the page never reads the journal directly; every
 * page-facing record rides OUR wireEvent projection (upstream/
 * web-write-streams.js) — the follow snapshot, the live event fan, and
 * session/page alike. wireTurnEndReason there presents the watchdog class
 * (cause kind "watchdog", chosen by upstream/turn-watchdog.js) as the error
 * it is for the user, and leaves every other abort class untouched — the
 * user's own cancel (cause kind "user", upstream/web-write.js session/cancel)
 * keeps its correct aborted silence. The journal itself stays honest: the
 * spine record keeps {kind:"aborted", reason:{kind:"watchdog",...}}.
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

/** A GLM-shaped SSE success body (one text round, finish stop). */
const glmSse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  + 'data: [DONE]\n\n';
const SUCCESS_BODY = glmSse([
  { choices: [{ delta: { content: 'working on it' } }] },
  {
    choices: [{
      delta: {},
      finish_reason: 'stop',
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }],
  },
]);

/** An endpoint that answers HEADERS and then goes silent forever — no body
 * bytes, no end: the P1 incident's wedge shape (a turn parked mid-stream
 * with zero semantic progress). */
const stageStalledEndpoint = () => {
  stagedHttp.set('http://127.0.0.1:17890/v1/chat/completions', () => {
    const bodyId = `body:stalled-${Date.now()}`;
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyId };
  });
};

/** A working endpoint whose FIRST body byte is delayed past `ms` — the turn
 * is genuinely running when the cancel lands. Timers are tracked and
 * `clearTestTimers()` reaps them: a parked node --test event loop after the
 * assertions would hold the runner for the delay. */
const testTimers = new Set();
const stageDelayedEndpoint = (ms) => {
  stagedHttp.set('http://127.0.0.1:17890/v1/chat/completions', (args) => {
    const bodyId = `body:delayed-${Date.now()}`;
    const timer = setTimeout(() => {
      testTimers.delete(timer);
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.body', chunkB64: b64(SUCCESS_BODY),
      }));
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.end',
      }));
    }, ms);
    testTimers.add(timer);
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyId };
  });
};
const clearTestTimers = () => {
  for (const timer of testTimers) clearTimeout(timer);
  testTimers.clear();
};

const wireTurnEnds = (frames) => frames
  .filter((f) => f.type === 'mux.item' && f.value?.type === 'event'
    && f.value.event?.type === 'turn/end')
  .map((f) => f.value.event);

/** The turn/end records a SNAPSHOT opening frame carries (records ride
 * inside the snapshot, wireEvent-shaped, unlike the live `event` frames). */
const snapshotWireTurnEnds = (frames) => frames
  .filter((f) => f.type === 'mux.item' && f.value?.type === 'snapshot')
  .flatMap((f) => f.value.records)
  .filter((r) => r?.event?.type === 'turn/end')
  .map((r) => r.event);

// The scenario's shared state: one boot, two page-driven sessions (the tests
// run sequentially in file order).
const WATCHDOG_SESSION = 's-spine-wd-0001';
const USER_SESSION = 's-spine-user-0001';
const state = {};

const surfaceOptions = (ctx) => ({
  root: '/profiles/default',
  provider: 'bigmodel',
  model: 'glm-5.3-flash',
  baseURL: 'http://127.0.0.1:17890/v1',
  routeKind: 'byok',
  spine: () => state.spineInventory(ctx),
  stagedPlugins: () => [],
});

const bootSpine = async () => {
  const { bootUpstream, spineInventory } = await import(runtime('upstream/boot.js'));
  const { createWriteSurface } = await import(runtime('upstream/web-write.js'));
  const { ctx } = await bootUpstream({
    scenario: 'spine.watchdog-abort-wire',
    agentId: 'main',
    sessionId: 's-spine-boot-0001',
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

/** Bounded poll (real timers — the staged endpoints ride setTimeout) for the
 * session's agent to reach `running`. */
const awaitRunning = async (sessionId) => {
  for (let guard = 0; guard < 500; guard++) {
    const agent = state.ctx.agents.get(sessionId);
    if (agent?.status === 'running') return agent;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the agent for "${sessionId}" never reached running`);
};

/** Await the session's spine turn/end event (bounded). */
const awaitSpineTurnEnd = (sessionId) => new Promise((resolve, reject) => {
  const off = state.ctx.on('session/event', (session, event) => {
    if (session?.id === sessionId && event?.type === 'turn/end') {
      try { off(); } catch {} // eslint-disable-line no-useless-catch
      resolve(event);
    }
  });
  setTimeout(() => reject(new Error(`"${sessionId}" turn never settled in 20s`)), 20000);
});

/** One write surface capturing its posted frames into `sink`, plus a live
 * session/follow attach for `sessionId`. */
const attachFollow = (sink, streamId, sessionId) => {
  const write = state.createWriteSurface(state.ctx, (f) => sink.push(f),
    surfaceOptions(state.ctx));
  write.openStream({
    streamId,
    endpoint: 'session/follow',
    payload: { args: { request: {
      address: { sessionId }, assistantStream: true,
    } } },
  });
  return write;
};

/** The watchdog kill's wire reason shape, asserted with its face named. */
const assertErrorReason = (event, where) => {
  assert.equal(event.data.reason.kind, 'error',
    `${where}: still aborted — the page shows a blank reply`);
  assert.equal(event.data.reason.error.code, 'watchdog', where);
  assert.match(event.data.reason.error.message,
    /^turn aborted: no turn progress for 400ms$/, where);
};

/** The reopened-history face: a fresh session/follow attach's snapshot. */
const assertErrorSnapshot = (sessionId, streamId) => {
  const frames = [];
  const reopen = attachFollow(frames, streamId, sessionId);
  const snapshot = frames.find((f) => f.type === 'mux.item')?.value;
  assert.ok(snapshot?.type === 'snapshot', 'the reopen attach got no snapshot frame');
  const snapEnd = snapshotWireTurnEnds(frames)[0];
  assert.ok(snapEnd, 'the snapshot carries no turn/end');
  assertErrorReason(snapEnd, 'snapshot');
  return reopen;
};

/** The history-window face: session/page rides the same projection. */
const assertErrorPage = async (sessionId) => {
  const page = await state.write.api['session/page']({
    request: { address: { kind: 'session', sessionId },
      throughSeq: state.ctx.sessions.get(sessionId).seq - 1, maxMessages: 50 },
  });
  const pageEnd = page.records.find((r) => r.event.type === 'turn/end')?.event;
  assert.ok(pageEnd, 'session/page carries no turn/end');
  assertErrorReason(pageEnd, 'session/page');
};

test('a watchdog kill reaches the page as kind-error with a readable message', { timeout: 60000 }, async () => {
  stageStalledEndpoint();
  await bootSpine();
  state.write = state.createWriteSurface(state.ctx, () => {},
    surfaceOptions(state.ctx));
  await state.write.api['session/create']({ sessionId: WATCHDOG_SESSION });

  // The REAL watchdog factory (upstream/turn-watchdog.js) over the REAL
  // agents registry, at a test-sized budget — the same makeTurnWatchdog the
  // mounted plugin uses; only the budget differs (300s is a test-hostility,
  // not a behavior).
  const { makeTurnWatchdog } = await import(runtime('upstream/turn-watchdog.js'));
  const watchdog = makeTurnWatchdog({
    budgetMs: 400,
    listRunning: () => state.ctx.agents.list(),
  });

  const follow = [];
  const liveSurface = attachFollow(follow, 'wd-live-1', WATCHDOG_SESSION);
  await state.write.api['session/prompt']({
    sessionId: WATCHDOG_SESSION,
    requestId: 'req-wd-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'stall forever' }],
  });
  const agent = await awaitRunning(WATCHDOG_SESSION);
  assert.equal(agent.status, 'running');
  watchdog.markProgress(); // arm: the turn is live and about to go silent
  const spineEnd = await awaitSpineTurnEnd(WATCHDOG_SESSION);
  watchdog.dispose();

  // The JOURNAL stays honest: aborted, cause watchdog, message readable.
  assert.equal(spineEnd.data.reason.kind, 'aborted',
    'the spine turn/end must keep the honest aborted classification');
  assert.equal(spineEnd.data.reason.reason?.kind, 'watchdog');
  assert.match(spineEnd.data.reason.reason?.message ?? '', /no turn progress for 400ms/);

  // THE WIRE (the page's view): kind error, readable message — on the live
  // fan, the reopened snapshot, and session/page alike.
  assert.ok(wireTurnEnds(follow).length >= 1, 'no live turn/end reached the wire');
  assertErrorReason(wireTurnEnds(follow)[0], 'live');
  const reopen = assertErrorSnapshot(WATCHDOG_SESSION, 'wd-reopen-1');
  reopen.dispose();
  await assertErrorPage(WATCHDOG_SESSION);
  liveSurface.dispose();
});

test('a user cancel keeps the aborted silence on the wire', { timeout: 60000 }, async () => {
  stageDelayedEndpoint(8_000); // the turn is genuinely running; the reply lands long after
  await state.write.api['session/create']({ sessionId: USER_SESSION });

  // The follow attaches AFTER the create: openFollow rejects an unattached
  // session (fail loud), and this is the page's own order anyway.
  const follow = [];
  const liveSurface = attachFollow(follow, 'user-live-1', USER_SESSION);
  await state.write.api['session/prompt']({
    sessionId: USER_SESSION,
    requestId: 'req-user-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'start, then I cancel you' }],
  });
  await awaitRunning(USER_SESSION);

  // The REAL user path: the write surface's session/cancel endpoint.
  await state.write.api['session/cancel']({ request: { sessionId: USER_SESSION } });
  await awaitSpineTurnEnd(USER_SESSION);

  const spineEnd = state.ctx.sessions.get(USER_SESSION).snapshotEvents()
    .find((e) => e.type === 'turn/end');
  assert.equal(spineEnd.data.reason.kind, 'aborted',
    'the user-cancel spine record must stay aborted');
  assert.equal(spineEnd.data.reason.reason?.kind, 'user');

  // The wire agrees with the user's own choice: aborted stays aborted.
  const live = wireTurnEnds(follow)[0];
  assert.ok(live, 'no live turn/end reached the wire');
  assert.equal(live.data.reason.kind, 'aborted',
    'a USER cancel must keep its aborted silence on the wire');
  assert.equal(live.data.reason.reason?.kind, 'user');
  liveSurface.dispose();
});

test('a completed turn/end passes through the projection untouched', { timeout: 60000 }, async () => {
  stageDelayedEndpoint(0);
  const done = [];
  const control = attachFollow(done, 'user-live-2', USER_SESSION);
  await state.write.api['session/prompt']({
    sessionId: USER_SESSION,
    requestId: 'req-user-2',
    mode: 'queue',
    content: [{ type: 'text', text: 'finish cleanly' }],
  });
  await awaitSpineTurnEnd(USER_SESSION);
  const ends = wireTurnEnds(done);
  const completed = ends[ends.length - 1];
  assert.ok(completed, 'the control turn/end never reached the wire');
  assert.equal(completed.data.reason.kind, 'completed',
    'a completed turn/end must pass through the projection untouched');
  control.dispose();
  clearTestTimers();
  disposeSeams();
});
