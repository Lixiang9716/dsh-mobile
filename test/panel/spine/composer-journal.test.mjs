// dsh:logging-exempt (test: the verdict is the assertion output)
/**
 * composer-journal.test.mjs — the composer journal's SPINE regression guard
 * (node --test, under test/panel/spine/run.sh; the first Node-side suite
 * that boots the REAL runtime — runtime/dsh/upstream/boot.js over the
 * vendored closure through the node_modules farm, provision-modules.mjs).
 *
 * WHY THIS EXISTS (T-0208 + T-0209, both 2026-10-09): the interactive seat's
 * turn journal was twice reported as "zero entry" / "one record only", and
 * twice the diagnosis dissolved into the REQUEST CURSOR, not the journal:
 * `session/page` with `throughSeq: -1` returns `{records: []}` BY DESIGN and
 * with `throughSeq: 0` returns exactly the log's FIRST event — a healthy
 * page-created byok journal's first event is `agent/inbox/spliced` (the
 * prompt's queue splice), so a throughSeq-0 page against it reads `1 record
 * (agent/inbox/spliced)`. T-0209's real-backend variant (byok glm, reasoning
 * deltas + tool calls) was reproduced against the REAL vendored spine here
 * and on the REAL bigmodel wire: the journal and every projection face are
 * complete. This suite pins that contract so the next "empty history" report
 * can be triaged against a green/red gate instead of a device capture:
 *
 *   1. a byok-shaped turn (GLM wire: reasoning_content deltas, content,
 *      incremental tool_calls, a second round after the tool) journals
 *      `user/message` and `assistant/message` as append-surface events;
 *   2. `session/page` at the log cursor returns the WHOLE log, wire records
 *      carrying their surfaceOp;
 *   3. `session/page` at -1 and at 0 return the by-design truncations;
 *   4. the reopen (a fresh `session/follow` attach) carries the complete log
 *      in its snapshot, cursor at the tail, projections folded.
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

/** One GLM-shaped SSE body: reasoning_content deltas, content, tool_calls,
 * finish_reason — the bigmodel wire shape, chunk by chunk. */
const glmSse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  + 'data: [DONE]\n\n';

const ROUND1 = glmSse([
  { choices: [{ delta: { reasoning_content: 'The user wants a todo recorded.' } }] },
  { choices: [{ delta: { reasoning_content: 'Writing the todo first.' } }] },
  { choices: [{ delta: { content: 'Recording that now.' } }] },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'call-glm-1', type: 'function',
          function: { name: 'todo_write', arguments: '{"todos":[{"content":' },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '"pin the contract","status":"in_progress"}]}' },
        }],
      },
    }],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]);

const ROUND2 = glmSse([
  { choices: [{ delta: { reasoning_content: 'Todo written.' } }] },
  { choices: [{ delta: { content: 'Todo recorded.' } }] },
  {
    choices: [{
      delta: {},
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }],
  },
]);

/** Stage the scripted byok endpoint: round 1 reasons, replies, calls
 * todo_write; round 2 closes the turn after the tool result. */
const stageGlmEndpoint = () => {
  let round = 0;
  stagedHttp.set('http://127.0.0.1:17890/v1/chat/completions', (args) => {
    round += 1;
    const bodyId = `body:glm-${round}`;
    const text = round === 1 ? ROUND1 : ROUND2;
    setTimeout(() => {
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.body', chunkB64: b64(text),
      }));
      globalThis.__dshGatewayOnEvent(JSON.stringify({
        callId: bodyId, event: 'http.end',
      }));
    }, 10);
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyId };
  });
};

const messageRecords = (records) => records.filter((r) =>
  r.event.type === 'user/message' || r.event.type === 'assistant/message');

// The scenario's shared state: one boot, one page-driven session (the tests
// run sequentially in file order).
const SESSION = 's-spine-byok-0001';
const state = {};

/** The interactive seat's write-surface options (route kind byok); the spine
 * provider rides the caller's ctx (writeSurface overrides it). */
const surfaceOptions = (ctx) => ({
  root: '/profiles/default',
  provider: 'bigmodel',
  model: 'glm-5.3-flash',
  baseURL: 'http://127.0.0.1:17890/v1',
  routeKind: 'byok',
  spine: () => state.spineInventory(ctx),
  stagedPlugins: () => [],
});

/** Boot the real spine on the scripted byok route. */
const bootSpine = async () => {
  const { bootUpstream, spineInventory } = await import(runtime('upstream/boot.js'));
  const { createWriteSurface } = await import(runtime('upstream/web-write.js'));
  const { ctx } = await bootUpstream({
    scenario: 'spine.composer-journal',
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

/** One write surface capturing its posted frames into `sink`. */
const writeSurface = (sink) => state.createWriteSurface(
  state.ctx, (f) => sink.push(f), surfaceOptions(state.ctx));

const journalEvents = () => state.ctx.sessions.get(SESSION).snapshotEvents();

const pageRequest = (throughSeq) => state.write.api['session/page']({
  request: { address: { kind: 'session', sessionId: SESSION },
    throughSeq, maxMessages: 50 },
});

test('the byok-shaped turn journals append-surface messages', { timeout: 60000 }, async () => {
  stageGlmEndpoint();
  await bootSpine();
  state.write = writeSurface([]);

  await state.write.api['session/create']({ sessionId: SESSION });
  const turnEnded = new Promise((resolveTurn) => {
    state.ctx.on('session/event', (session, event) => {
      if (session?.id === SESSION && event?.type === 'turn/end') resolveTurn(event);
    });
  });
  await state.write.api['session/prompt']({
    sessionId: SESSION,
    requestId: 'req-spine-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'Record a todo: pin the contract' }],
  });
  await Promise.race([
    turnEnded,
    new Promise((_, rejectTurn) => setTimeout(
      () => rejectTurn(new Error('the turn did not settle in 30s')), 30000)),
  ]);

  const events = journalEvents();
  const surface = (type) => events.find((event) => event.type === type);
  assert.ok(surface('user/message') !== undefined, 'no user/message in the journal');
  assert.equal(surface('user/message').surfaceOp, 'append',
    'user/message lost its append surfaceOp');
  assert.ok(surface('assistant/message') !== undefined, 'no assistant/message in the journal');
  assert.equal(surface('assistant/message').surfaceOp, 'append',
    'assistant/message lost its append surfaceOp');
  const blocks = surface('assistant/message').data.message.content
    .map((block) => block.type);
  assert.ok(blocks.includes('reasoning'), `no reasoning block (got ${blocks})`);
  assert.ok(blocks.includes('text'), `no text block (got ${blocks})`);
  assert.ok(blocks.includes('tool-call'), `no tool-call block (got ${blocks})`);
});

test('session/page at the cursor returns the whole log with its surface markers', { timeout: 60000 }, async () => {
  const events = journalEvents();
  const page = await pageRequest(state.ctx.sessions.get(SESSION).seq - 1);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.records.map((r) => r.event.seq), events.map((e) => e.seq),
    'the tail page is not the whole log');
  assert.ok(messageRecords(page.records).length >= 2,
    'the tail page lost the turn messages');
  // The wire envelope: the official client REQUIRES surfaceOp on the four
  // surface-eligible message events — dropping it fails the page's history
  // load (web-write-streams.js wireEvent's own contract note).
  for (const record of messageRecords(page.records)) {
    assert.equal(record.event.surfaceOp, 'append',
      `${record.event.type} rode the wire without its surfaceOp`);
  }
});

test('session/page cursor truncations are by design (-1 empty, 0 first event)', { timeout: 60000 }, async () => {
  const events = journalEvents();
  const atMinusOne = await pageRequest(-1);
  assert.deepEqual(atMinusOne.records, [],
    'throughSeq -1 must return an empty page (by design), not the log');
  const atZero = await pageRequest(0);
  assert.deepEqual(atZero.records.map((r) => r.event.type),
    [events[0].type],
    'throughSeq 0 must return exactly the first event (by design)');
});

test('the reopen (a fresh session/follow attach) carries the complete log', { timeout: 60000 }, async () => {
  const events = journalEvents();
  const frames = [];
  const reopen = writeSurface(frames);
  reopen.openStream({
    streamId: 'reopen-1',
    endpoint: 'session/follow',
    payload: { args: { request: {
      address: { sessionId: SESSION }, assistantStream: true,
    } } },
  });
  const snapshot = frames.find((f) => f.type === 'mux.item')?.value;
  assert.ok(snapshot?.type === 'snapshot', 'the reopen attach got no snapshot frame');
  assert.equal(snapshot.cursor, events[events.length - 1].seq,
    'the reopen snapshot cursor is not the journal tail');
  assert.deepEqual(snapshot.records.map((r) => r.event.seq), events.map((e) => e.seq),
    'the reopen snapshot is missing journal events');
  assert.ok(messageRecords(snapshot.records).length >= 2,
    'the reopen snapshot lost the turn messages');
  assert.ok(snapshot.projections?.values?.modelSelection !== undefined,
    'the reopen snapshot carries no modelSelection projection');
  reopen.dispose();
  // The spine's watchdog keeps a standing timer armed; without this the
  // runner's event loop parks for the watchdog budget after the assertions.
  disposeSeams();
});
