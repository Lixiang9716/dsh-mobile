/**
 * M2 session scenario `m2.session` — the first MINI agent session over the
 * system implementation plugins. 100% platform-neutral: it imports only the
 * gateway shim, the unified logger, the service registry, and the three
 * system plugins (bundle-root-relative `system-plugins/...`, present in
 * every bundle layout); no WS, no UI, no host-specific seam.
 *
 * Flow: registry boots and installs dsh-fs / dsh-subprocess-quickjs / dsh-ui
 * → the host readiness signal (host.info gateway event: port 0 on the CLI
 * backend, the carrier port behind a mounted Web Client) → session created →
 * mock-LLM streams token deltas as an event sequence (D8) → one tool call
 * routed through the subprocess plugin, whose task persists its result via
 * the fs service under scope "app" → session completes with the transcript.
 * Every expected event emits exactly one structured log entry, in the order
 * declared by tools/e2e/scenarios/m2-session.json.
 */
import { createLogger } from 'logger.js';
import { onEvent } from 'gateway.js';
import { createRegistry } from 'registry.js';
import * as fsPlugin from 'system-plugins/dsh-fs/index.js';
import * as subprocessPlugin from 'system-plugins/dsh-subprocess-quickjs/index.js';
import * as uiPlugin from 'system-plugins/dsh-ui/index.js';

const SCENARIO = 'm2.session';
const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

/* Bridge events arrive in host order; the scenario consumes them by name,
 * buffering anything that arrives while it waits for another kind. */
const buffered = [];
const waiters = [];
onEvent((ev) => {
  const wake = waiters.shift();
  if (wake) wake(ev);
  else buffered.push(ev);
});
const nextEvent = async (name) => {
  for (;;) {
    const at = buffered.findIndex((ev) => ev.event === name);
    if (at >= 0) return buffered.splice(at, 1)[0];
    const ev = await new Promise((resolve) => waiters.push(resolve));
    buffered.push(ev);
  }
};

/** Session projection push (session-projection@0): one JSON line over the
 * bus seam, shuttled host-side to the carrier WS and rendered by the active
 * Web Client. Hosts without a bus sink drop it silently (the CLI backend),
 * so the E2E log stream is identical everywhere. */
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};

const SESSION_ID = 's-m2-0001';
const RESULT_PATH = 'm2-session/result.txt';
const RESULT_TEXT = 'm2-session result: 5 deltas'; // 27 ASCII bytes
const TURN_ONE = ['Hello', ' from', ' DSH'];
const TURN_TWO = [' Saved', ' ok'];

/** Task step 1 (pure compute): a tiny work unit on the runtime queue. */
const computeStep = async (ctx) => {
  ctx.report('computed');
  log.debug('task compute step done');
  return 'deltas=5';
};

/** Task step 2 (persist): routes the task's result through dsh-fs under the
 * session's granted scope — the tool result lands in app storage. */
const persistStep = async (ctx) => {
  log.debug('task persist step begin', { path: RESULT_PATH });
  return await ctx.fs.writeText('app', RESULT_PATH, RESULT_TEXT);
};

/** Streams one mock-LLM turn: token deltas as an event sequence. Returns
 * the full text so the transcript assembles from what actually streamed. */
const streamTurn = async (turn, tokens, startIndex) => {
  emit('llm.stream.started', { turn });
  let text = '';
  for (let i = 0; i < tokens.length; i++) {
    await null; // each delta settles on its own runtime-queue tick
    text += tokens[i];
    emit('llm.delta', { index: startIndex + i, text: tokens[i] });
    project({ kind: 'token-delta', index: startIndex + i, text: tokens[i] });
  }
  return text;
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const registry = createRegistry();
  registry.install({ manifest: fsPlugin.manifest, module: fsPlugin });
  registry.install({ manifest: subprocessPlugin.manifest, module: subprocessPlugin });
  registry.install({ manifest: uiPlugin.manifest, module: uiPlugin });
  emit('plugins.installed', { count: registry.pluginIds().length, services: 'fs,subprocess,ui' });

  // Host readiness: the CLI backend signals before the pump loop; carrier
  // hosts signal when the presentation surface is attached (same contract).
  await nextEvent('host.info');
  emit('host.ready', { signalled: true });

  const fs = registry.service('fs');
  const subprocess = registry.service('subprocess');
  const session = { id: SESSION_ID, transcript: [], deltas: 0, toolCalls: 0 };
  emit('session.created', { sessionId: session.id, scope: 'app' });
  project({ kind: 'session', id: session.id, scope: 'app' });
  emit('agent.started', { model: 'mock-mini', tools: 1 });
  project({ kind: 'agent', model: 'mock-mini', tools: 1 });

  const turn1 = await streamTurn(1, TURN_ONE, 0);
  session.transcript.push(turn1);
  session.deltas += TURN_ONE.length;
  session.toolCalls += 1;
  emit('llm.stream.completed', { turn: 1, deltas: TURN_ONE.length, toolCalls: 1 });

  emit('tool.invoked', { name: 'notes.persist', call: 't-1' });
  project({ kind: 'tool', name: 'notes.persist', phase: 'invoke' });
  let stepNo = 0;
  const handle = subprocess.spawn({
    id: 'task-1',
    context: { fs },
    steps: [computeStep, persistStep],
  });
  emit('subprocess.spawned', { taskId: handle.id, steps: 2 });
  handle.on('progress', (ev) => {
    if (typeof ev.step !== 'number') return; // label-only reports stay internal
    stepNo = ev.step;
    emit('subprocess.progress', { taskId: handle.id, step: ev.step });
  });
  const outcome = await handle.done;
  demand(outcome.ok, `subprocess task failed: ${outcome.error}`);
  demand(stepNo === 2, `task reported ${stepNo} steps, expected 2`);
  emit('fs.write.ok', { written: outcome.result.written, path: RESULT_PATH });
  demand(outcome.result.written === RESULT_TEXT.length, 'persisted byte count drifted');
  emit('subprocess.completed', { taskId: handle.id, ok: outcome.ok });
  emit('tool.result', { name: 'notes.persist', call: 't-1', ok: outcome.ok });
  project({ kind: 'tool', name: 'notes.persist', phase: 'result', ok: outcome.ok });

  const turn2 = await streamTurn(2, TURN_TWO, TURN_ONE.length);
  session.transcript.push(turn2);
  session.deltas += TURN_TWO.length;
  emit('llm.stream.completed', { turn: 2, deltas: TURN_TWO.length, toolCalls: 0 });

  const stored = await fs.readText('app', RESULT_PATH);
  demand(stored.text === RESULT_TEXT, 'roundtrip text drifted');
  emit('session.completed', {
    sessionId: session.id,
    status: 'pass',
    deltas: session.deltas,
    toolCalls: session.toolCalls,
    persisted: true,
  });
  project({
    kind: 'complete',
    status: 'pass',
    deltas: session.deltas,
    toolCalls: session.toolCalls,
  });
  globalThis.__dshComplete(true, 'ok');
}
