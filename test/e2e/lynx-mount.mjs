#!/usr/bin/env node
// dsh:logging-exempt (test-side scenario entry: the structured log IS the product)
/**
 * lynx-mount.mjs — the lynx.mount E2E scenario entry, CLI host (plain Node;
 * the leg mirrors runtime/dsh/ci/run-settings-surfaces-e2e.sh's evidence
 * discipline: unified-logger lines through __DSH_LOG_SINK__, the
 * dsh.spike.log: prefix, a one-to-one manifest under test/e2e/scenarios/,
 * and __dshComplete as the only exit).
 *
 * ONE leg, TWO faces over the same RenderSurfaceClient seam (the
 * replaceability proof):
 *   --skin lynx (default) — driver/skin-lynx.js host:'cli': the bundle's REAL
 *     seam core (shared/surface-core.js, the module compiled into
 *     main.lynx.bundle) + the artifact sha256 verification; pixels stay
 *     engine-only and the log says so.
 *   --skin stub           — driver/skin-stub.js: the plain-text transcription.
 *
 * The driver loop is identical for both faces: mock SessionServe (the canned
 * dev-echo turn) over real loopback HTTP+WS → adapter → seam. A logging
 * wrapper on the seam records every message-delta / tool-card-phase view
 * event as it is pushed, fires the seed.replayed record exactly when the
 * seed-end view event crosses the seam, and records the intents as the skin
 * raises them. Nothing here is pre-played — every record is what the loop
 * actually pushed, and both faces must satisfy their manifest one-to-one.
 */
import { createLogger } from '../../runtime/dsh/logger.js';
import { startMockServe } from '../../presentation/lynx-client/driver/mock/mock-serve.mjs';
import { createSessionServe } from '../../presentation/lynx-client/driver/wire/session-serve.js';
import { createDriver } from '../../presentation/lynx-client/driver/driver.js';
import { createStubSkin } from '../../presentation/lynx-client/driver/skin-stub.js';
import { createLynxSkin } from '../../presentation/lynx-client/driver/skin-lynx.js';

// The unified sink, CLI-host face: the same one-JSON-line contract the spike
// hosts embed, prefixed so test/e2e/check.mjs can extract it.
if (globalThis.__DSH_LOG_SINK__ === undefined) {
  globalThis.__DSH_LOG_SINK__ = (line) => process.stdout.write(`dsh.spike.log: ${line}\n`);
}
// The completion contract, CLI-host face: honor a host-provided hook, else
// bridge it to the process exit — the spike host exits on __dshComplete, and
// a Node process with open loopback handles would otherwise linger after the
// scenario is over.
if (globalThis.__dshComplete === undefined) {
  globalThis.__dshComplete = (ok, reason) => {
    if (!ok) {
      console.error(`lynx-mount: scenario failed: ${reason ?? 'unspecified'}`);
      process.exit(1);
    }
  };
}

const SCENARIO = 'lynx.mount';
const log = createLogger('lynx.mount');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const stack = reason instanceof Error ? ` | ${reason.stack?.split('\n').slice(1, 3).join(' / ')}` : '';
  emit('scenario.failed', { reason: `${String(reason)}${stack}` });
  globalThis.__dshComplete(false, `${String(reason)}${stack}`);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

const DEADLINE_MS = 20_000;
const poll = async (what, fn) => {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`deadline exceeded waiting for: ${what}`);
};

const skinOf = (flag) => {
  if (flag === 'stub') return createStubSkin({ stream: null });
  if (flag === 'lynx') return createLynxSkin({ host: 'cli' });
  throw new Error(`unknown --skin ${flag} (lynx | stub)`);
};

/** The seam logging wrapper: the streaming substance and the intents are
 * recorded as they cross; the seed.replayed record fires ONLY when the
 * reselect armed the sink (flow.expectSeed) and the seed-end view event then
 * crosses — one record, at its construction-determined position after the
 * replayed burst. */
const withLogging = (skin, flow) => ({
  mount: () => skin.mount(),
  teardown: () => skin.teardown(),
  onIntent: (handler) => skin.onIntent((intent) => {
    emit('intent.observed', { type: intent.type, face: skin.face });
    handler(intent);
  }),
  pushViewEvent: (event) => {
    if (event.type === 'message-delta') {
      emit('view.message.delta', { kind: event.kind, face: skin.face });
    } else if (event.type === 'tool-card-phase') {
      emit('view.tool.phase', { phase: event.phase, face: skin.face });
    } else if (event.type === 'session-settled' && event.kind === 'seed-end'
      && flow.expectSeed) {
      flow.expectSeed = false;
      emit('seed.replayed', {
        sessionId: flow.created,
        rebuilt: 'mid-history, no blank mount',
      });
    }
    skin.pushViewEvent(event);
  },
});

const boot = async (flag) => {
  const skin = skinOf(flag);
  const flow = { created: null, expectSeed: false };
  const wrapped = withLogging(skin, flow);
  await skin.mount();
  emit('face.mounted', {
    face: skin.face,
    mode: skin.face === 'lynx' ? skin.mountMode : 'plain-text transcription of the fold',
    artifactBytes: skin.artifact?.bytes ?? null,
    artifactSha256: skin.artifact?.sha256 ?? null,
  });
  const mock = await startMockServe();
  const serve = createSessionServe({ baseUrl: mock.baseUrl });
  const driver = createDriver({ skin: wrapped, serve });
  await driver.mount();
  emit('serve.listening', { loopback: true, carrier: 'mock session-serve (dev-echo fixture)' });
  await poll('connection open', () => skin.transcript.includes('已连接'));
  emit('connection.opened', {});
  await poll('drawer settle', () => skin.transcript.includes('新会话'));
  emit('drawer.settled', { sessions: 1 });
  return { mock, serve, skin, driver, flow };
};

const selectAndCreate = async (skin, driver, flow) => {
  skin.tap({ type: 'select-session', sessionId: 's-dev-lynx-0000' });
  await poll('first follow', () => driver.activeSession() === 's-dev-lynx-0000');
  emit('session.selected', { sessionId: 's-dev-lynx-0000' });
  skin.tap({ type: 'new-session' });
  const created = await poll('created', () => {
    const id = driver.activeSession();
    return typeof id === 'string' && id !== 's-dev-lynx-0000' ? id : null;
  });
  await poll('drawer grows', () => skin.transcript.includes(created.slice(0, 8)));
  flow.created = created;
  emit('session.created', { sessionId: created });
  return created;
};

const echoTurn = async (skin) => {
  skin.tap({ type: 'submit', text: '画出极光' });
  emit('prompt.submitted', { text: '画出极光' });
  await poll('admitted', () => skin.transcript.includes('[你] 画出极光'));
  emit('prompt.admitted', {});
  await poll('turn settled', () => skin.transcript.includes('桌面回声鲸鱼')
    && !skin.transcript.includes('生成中…'));
  const t = skin.transcript;
  demand(t.includes('[DSH]') && t.includes('dev 回声'), 'the assistant bubble never settled');
  demand(t.includes('bash · 完成') && t.includes('AGENTS.md'),
    'the tool card never collapsed to 完成 with output');
  demand(t.includes('桌面回声鲸鱼'), 'the creation card never rendered');
  emit('turn.settled', { tool: 'bash · 完成', creation: '桌面回声鲸鱼' });
};

const reselectAndCancel = async (skin, serve, driver, created, flow) => {
  // Arm the seed sink, then re-open: the seed.replayed record fires when the
  // replay burst's seed-end crosses the seam (after the burst's tool events).
  flow.expectSeed = true;
  skin.tap({ type: 'select-session', sessionId: created });
  await poll('mock idle', async () => {
    const value = await serve.list();
    const item = (value?.items ?? []).find((s) => s.sessionId === created);
    return item?.running === false;
  });
  skin.tap({ type: 'submit', text: '数到三就行' });
  await poll('streaming', () => skin.transcript.includes('生成中…')
    || skin.transcript.includes('准备中'));
  emit('cancel.requested', {});
  skin.tap({ type: 'cancel' });
  await poll('cancelled', () => skin.transcript.includes('已停止'));
  emit('cancel.settled', { status: '已停止', tail: 'dropped' });
  demand(driver.activeSession() === created, 'active session drifted');
};

const failLoudLegs = (skin) => {
  let threw = false;
  try { skin.tap({ type: 'explode' }); } catch { threw = true; }
  demand(threw, 'an unknown intent did NOT fail loud');
  emit('fail.loud.intent', { threw: true });
  threw = false;
  try { skin.pushViewEvent({ type: 'alien' }); } catch { threw = true; }
  demand(threw, 'an unknown view event did NOT fail loud');
  emit('fail.loud.view-event', { threw: true });
};

const main = async () => {
  const flag = process.argv[process.argv.indexOf('--skin') + 1] ?? 'lynx';
  const { mock, serve, skin, driver, flow } = await boot(flag);
  const created = await selectAndCreate(skin, driver, flow);
  await echoTurn(skin);
  await reselectAndCancel(skin, serve, driver, created, flow);
  failLoudLegs(skin);
  emit('loop.complete', { face: skin.face, status: 'pass' });
  await driver.teardown();
  await mock.close();
  globalThis.__dshComplete(true, `${SCENARIO} ${flag} green`);
};

main().catch(fail);
