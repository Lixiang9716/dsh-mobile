/**
 * M3 on-device fetch-install scenario `m3.fetch-install` — the M3 scope
 * items proven ON DEVICE over the real gateway (carrier host, iOS):
 *
 *   - the dsh-notes package is served BY THE LOOPBACK CARRIER ITSELF
 *     (self-hosted plugin source — no external network): the scenario
 *     hands the package bytes to the carrier over the bus seam
 *     ({type:"http.serve", path, bodyB64}) and then installs them through
 *     installFromFetch with the REAL gateway httpFetch — a genuine
 *     on-device HTTP round trip, streaming body → bytes → §4 pipeline;
 *   - two crash-simulated pending receipts are STARTUP-REPLAYED
 *     (staged-verifies → committed; staging-incomplete → rolled-back);
 *   - install-time negotiation runs inside the pipeline (the carrier
 *     descriptor offers all nine primitives — the pass case; the reject
 *     case is proven on the CLI in m3.complete);
 *   - the config layer patch (profiles/m3-complete/cordis.patch.json) is
 *     consumed host-side BEFORE eval: it selected the ACTIVE Web Client
 *     and the toolbar slot allow-set (carrier-side evidence,
 *     scenario m3.fetch-carrier); the scenario projects one slot the
 *     configured set DENIES and the one it admits.
 *
 * Session phase is m2.session-shaped: the host.info readiness signal
 * arrives only after the page acked the admitted slot, the mock LLM
 * streams token deltas as an event sequence, one tool call runs through
 * the subprocess plugin and persists via dsh-fs. Carrier events ride the
 * separate scenario m3.fetch-carrier so the two one-to-one checkers never
 * interleave.
 */
import { createLogger } from 'logger.js';
import { fsRead, httpFetch, onEvent } from 'gateway.js';
import { createRegistry } from 'registry.js';
import { installFromFetch } from 'install-fetch.js';
import { readJournal, simulateCrash, replayPendingReceipts } from 'receipt-journal.js';
import { sha256Hex } from 'sha256.js';
import * as fsPlugin from 'system-plugins/dsh-fs/index.js';
import * as subprocessPlugin from 'system-plugins/dsh-subprocess-quickjs/index.js';
import * as uiPlugin from 'system-plugins/dsh-ui/index.js';
import { buildNotesTgz, NOTES_MANIFEST_BYTES } from 'fixtures/dsh-notes.js';
import { NOTES_PLUGIN_SOURCE } from 'fixtures/dsh-notes-source.js';

const SCENARIO = 'm3.fetch-install';
const log = createLogger('m3.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const onStep = (name, fields) => emit(`install.${name}`, fields);
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

const toText = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');
const toBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

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
  log.debug('wait for event', { name });
  for (;;) {
    const at = buffered.findIndex((ev) => ev.event === name);
    if (at >= 0) return buffered.splice(at, 1)[0];
    const ev = await new Promise((resolve) => waiters.push(resolve));
    buffered.push(ev);
  }
};

/** Session projection push (session-projection@0): one JSON line over the
 * bus seam, shuttled host-side to the carrier WS and rendered by the active
 * Web Client. The carrier enforces the CONFIGURED slot allow-set here: a
 * slot.register outside the set is denied (carrier-side evidence) and never
 * delivered to the page. */
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};

/** Hand the package bytes to the carrier: an in-memory route served by the
 * loopback HTTP server itself. The fetch below is a REAL httpFetch over
 * 127.0.0.1 — no external network, no fetch stub. */
const serveFromCarrier = (path, bytes) => {
  log.debug('carrier route register', { path, bytes: bytes.length });
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  globalThis.__dshBusPost?.(JSON.stringify({
    type: 'http.serve', path, bytes: bytes.length, bodyB64: globalThis.btoa(binary),
  }));
};

const SESSION_ID = 's-m3-0001';
const PKG_PATH = '/packages/dsh-notes-0.1.0.tar';
const RESULT_PATH = 'm3-fetch-install/result.txt';
const RESULT_TEXT = 'm3-fetch-install result: 5 deltas'; // 33 ASCII bytes
const TURN_ONE = ['Hello', ' from', ' DSH'];
const TURN_TWO = [' Saved', ' ok'];

/** The package ARRIVES over the loopback carrier: real httpFetch →
 * streaming body → the §4 pipeline, with the receipt journal recording
 * pending → committed. */
const fetchInstallPhase = async (registry, packageBytes) => {
  log.debug('fetch install phase begin');
  registry.install({ manifest: subprocessPlugin.manifest, module: subprocessPlugin });
  registry.install({ manifest: uiPlugin.manifest, module: uiPlugin });
  registry.install({ manifest: fsPlugin.manifest, module: fsPlugin });
  emit('fs.ready', { service: 'fs' });

  const info = await nextEvent('carrier.info'); // fired when the page connected
  emit('carrier.ready', { source: 'carrier.info', port: info.port });
  serveFromCarrier(PKG_PATH, packageBytes);
  emit('fixture.built', { members: 2, bytes: packageBytes.length });

  const result = await installFromFetch({
    fetchImpl: httpFetch, // the REAL gateway primitive over the loopback carrier
    url: `http://127.0.0.1:${info.port}${PKG_PATH}`,
    id: 'dsh-notes',
    trust: {
      blobSha256: sha256Hex(packageBytes),
      manifestSha256: sha256Hex(NOTES_MANIFEST_BYTES),
    },
    txId: 'm3-f001',
    on: onStep,
    journal: true,
  });

  const journal = await readJournal();
  demand(journal.length === 2 && journal[0].txId === 'm3-f001'
    && journal[0].receipt.status === 'pending' && journal[1].receipt.status === 'committed',
  'journal pending→committed order drifted');
  emit('install.receipt.asserted', {
    status: result.receipt.status, id: result.receipt.id, version: result.receipt.version,
    blobSha256: result.receipt.blobSha256, journalLines: journal.length,
  });
  globalThis.__dshModuleDefine(result.moduleId, toText(result.entrySource));
  registry.install({ manifest: result.manifest, module: await import(result.moduleId) });
  registry.service('notes'); // fail loud unless activation registered it
  emit('installed.loaded', { id: result.manifest.id, moduleId: result.moduleId });
  return result;
};

/** Toolbar slots: one the CONFIGURED allow-set denies (carrier drops it —
 * the page never renders it), then the one the plugin actually owns. */
const projectSlots = () => {
  log.debug('project toolbar slots', { count: 2 });
  project({ kind: 'slot.register', id: 'debug.console', label: 'debug', by: 'dsh.spike' });
  project({ kind: 'slot.register', id: 'notes.toolbar', label: 'notes', by: 'dsh-notes' });
};

/** Two crash-simulated transactions (staged tree + PENDING receipt, nothing
 * promoted), then the §4 startup replay resolves both. */
const replayPhase = async (result, packageBytes) => {
  log.debug('replay phase begin');
  const files = {
    'manifest.json': NOTES_MANIFEST_BYTES,
    'bundle/index.js': toBytes(NOTES_PLUGIN_SOURCE),
  };
  const common = { manifest: result.manifest, files, blobBytes: packageBytes };
  await simulateCrash({ txId: 'm3-f002', ...common });
  emit('crash.simulated', { txId: 'm3-f002', mode: 'staged-verifies', files: 2 });
  await simulateCrash({ txId: 'm3-f003', ...common, omit: ['bundle/index.js'] });
  emit('crash.simulated', { txId: 'm3-f003', mode: 'staging-incomplete', files: 1 });

  const summary = await replayPendingReceipts({
    on: (name, fields) => emit(`replay.${name}`, fields),
  });
  demand(summary.committed === 1 && summary.rolledBack === 1, 'replay summary drifted');
  const journal = await readJournal();
  const lastFor = (txId) => journal.filter((e) => e.txId === txId).pop();
  demand(lastFor('m3-f002').receipt.status === 'committed'
    && lastFor('m3-f003').receipt.status === 'rolled-back', 'replay receipts drifted');
  emit('replay.receipt.asserted', {
    txId: 'm3-f002', status: 'committed', journalLines: journal.length,
  });
  // The rolled-back leg must not have touched the FETCH-INSTALLED tree.
  const still = (await fsRead('app', `${result.pkgDir}/manifest.json`)).bytes;
  demand(sha256Hex(still) === result.integrity.manifestSha256,
    'rollback touched the installed tree');
  emit('replay.tree.intact', { verified: true });
};

/** Task steps (compute + persist) — same shape as m2.session. */
const computeStep = async (ctx) => {
  ctx.report('computed');
  log.debug('task compute step done');
  return 'deltas=5';
};
const persistStep = async (ctx) => {
  log.debug('task persist step begin', { path: RESULT_PATH });
  return await ctx.fs.writeText('app', RESULT_PATH, RESULT_TEXT);
};

const streamTurn = async (turn, tokens, startIndex) => {
  log.debug('stream turn', { turn, tokens: tokens.length });
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

/** The one tool call: a subprocess task whose persist step writes the task
 * result via dsh-fs under scope "app". */
const persistViaSubprocess = async (fs, subprocess) => {
  log.debug('tool call begin', { name: 'notes.persist' });
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
};

/** The session phase (m2.session-shaped): token deltas as an event
 * sequence, one subprocess tool call persisting via dsh-fs. */
const sessionPhase = async (registry) => {
  log.debug('session phase begin');
  await nextEvent('host.info'); // gated on the page acking the ADMITTED slot
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

  await persistViaSubprocess(fs, subprocess);

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
};

const main = async () => {
  log.debug('main begin');
  emit('gateway.negotiated', { version: 'gateway@1' });
  const registry = createRegistry();
  const packageBytes = buildNotesTgz();
  const result = await fetchInstallPhase(registry, packageBytes);
  projectSlots();
  await replayPhase(result, packageBytes);
  await sessionPhase(registry);
  globalThis.__dshComplete(true, 'ok');
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  // An uncaught rejection would otherwise die silently between pumps —
  // route every failure through the scenario verdict (fail loud, rule 5).
  await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
}
