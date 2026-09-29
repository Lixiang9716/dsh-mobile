#!/usr/bin/env node
// dsh:logging-exempt (node-side runner: console IS the product)
/**
 * run-mock.mjs — the driver's FULL mock loop, the build round's green
 * criterion. Boots the in-process SessionServe mock (canned dev-echo turn),
 * mounts the stub skin, and drives the whole surface through the real wire
 * client over real loopback HTTP+WS:
 *
 *   mount (shell + drawer + connection) → select-session (seed replay) →
 *   new-session (create + open) → submit (stream: reasoning/tool/text
 *   deltas, tool card streaming→waiting→ok, creation card, title, settle)
 *   → re-select (mid-history seed rebuild) → cancel (optimistic stop →
 *   已停止, tail dropped) → fail-loud legs (unknown intent, unknown view
 *   event) → teardown.
 *
 * Assertions poll conditions with deadlines (never blind sleeps) and the
 * process exits non-zero naming the first failed step. Transport facts
 * (mux frames routed) print as loop evidence.
 */

import { startMockServe } from './mock/mock-serve.mjs';
import { createSessionServe } from './wire/session-serve.js';
import { createDriver } from './driver.js';
import { createStubSkin } from './skin-stub.js';
import { assertViewEvent } from '../shared/view-events.js';

const DEADLINE_MS = 15_000;
const poll = async (what, fn) => {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = await fn(); // await: async predicates must be polled, not truthy-Promise'd
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`deadline exceeded waiting for: ${what}`);
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
  return ok;
};

const boot = async () => {
  const mock = await startMockServe();
  console.log(`[run-mock] mock serve on ${mock.baseUrl}`);
  const serve = createSessionServe({ baseUrl: mock.baseUrl });
  const skin = createStubSkin({ stream: null });
  const driver = createDriver({ skin, serve });
  await driver.mount();
  await poll('connection open', () => skin.transcript.includes('已连接'));
  await poll('sessions settle on the drawer', () => skin.transcript.includes('新会话'));
  return { mock, serve, skin, driver };
};

// 1 — cold start: shell + drawer + connection, never blank
const stepColdStart = (skin) => {
  const t = skin.transcript;
  check('cold start: DSH wordmark + 输入条 shell', t.includes('『DSH』') && t.includes('输入条'));
  check('cold start: drawer lists the seeded session', t.includes('s-dev-ly'));
  check('cold start: connection capsule', t.includes('已连接'));
};

// 2+3 — select-session, then new-session (create + open)
const stepSessions = async (skin, driver) => {
  skin.tap({ type: 'select-session', sessionId: 's-dev-lynx-0000' });
  await poll('session follow open', () => driver.activeSession() === 's-dev-lynx-0000');
  check('select-session: follow attached', driver.activeSession() === 's-dev-lynx-0000');
  skin.tap({ type: 'new-session' });
  const created = await poll('new session created+opened', () => {
    const id = driver.activeSession();
    return typeof id === 'string' && id !== 's-dev-lynx-0000' ? id : null;
  });
  await poll('drawer shows the new session', () => skin.transcript.includes(created.slice(0, 8)));
  check('new-session: created and opened', created.startsWith('s-dev-lynx-'), created);
  return created;
};

// 4 — submit: the full echo turn streams through the fold
const stepEchoTurn = async (skin) => {
  const markers = new Set();
  const watcher = setInterval(() => {
    for (const m of ['生成中…', '准备中', '等待结果', '完成', '▍']) {
      if (skin.transcript.includes(m)) markers.add(m);
    }
  }, 15);
  skin.tap({ type: 'submit', text: '画出极光' });
  await poll('prompt admitted', () => skin.transcript.includes('[你] 画出极光'));
  await poll('turn settled (title + creation + stop chip gone)',
    () => skin.transcript.includes('桌面回声鲸鱼')
      && skin.transcript.includes('回合结束') === false
      && !markers.has('▍') === false && !skin.transcript.includes('生成中…'));
  clearInterval(watcher);
  const t = skin.transcript;
  check('turn: user bubble echoed', t.includes('[你] 画出极光'));
  check('turn: assistant reply settled', t.includes('dev 回声') && t.includes('渲染检查'));
  check('turn: tool card collapsed to 完成 with OUT', t.includes('bash · 完成') && t.includes('AGENTS.md'));
  check('turn: creation card', t.includes('桌面回声鲸鱼'));
  check('turn: three card states all seen live',
    markers.has('准备中') && markers.has('等待结果') && markers.has('完成'),
    `seen: ${[...markers].join(',')}`);
  check('turn: session title settled', t.includes('画出极光'));
};

// 5 — re-select: mid-history mount rebuilds from the seed burst
const stepReselect = async (skin, driver, created) => {
  skin.tap({ type: 'select-session', sessionId: 's-dev-lynx-0000' });
  await poll('switched away', () => driver.activeSession() === 's-dev-lynx-0000');
  skin.tap({ type: 'select-session', sessionId: created });
  await poll('re-opened', () => driver.activeSession() === created);
  await poll('seed rebuild done', () => skin.transcript.includes('dev 回声'));
  const t = skin.transcript;
  check('re-select: seed replay rebuilds the thread (no blank mount)',
    t.includes('[你] 画出极光') && t.includes('bash · 完成') && t.includes('桌面回声鲸鱼'));
};

// 6 — cancel: optimistic stop, then 已停止 with the tail dropped. The view
// settles one server tick before the mock's running flag does — wait for
// the wire truth (session/list running=false) or the prompt legitimately
// fails session/busy (the driver surfaces that honestly).
const stepCancel = async (skin, serve, created) => {
  await poll('mock session idle (running=false)', async () => {
    const value = await serve.list();
    const item = (value?.items ?? []).find((s) => s.sessionId === created);
    return item?.running === false;
  });
  skin.tap({ type: 'submit', text: '数到三就行' });
  await poll('second turn streaming', () => skin.transcript.includes('生成中…')
    || skin.transcript.includes('准备中'));
  skin.tap({ type: 'cancel' });
  await poll('cancelled settle', () => skin.transcript.includes('已停止'));
  await poll('tail dropped, running idle', () => !skin.transcript.includes('生成中…')
    && !skin.transcript.includes('▍'));
  const t = skin.transcript;
  check('cancel: 已停止 status, no hung tail', t.includes('已停止'));
  check('cancel: the cancelled reply never settled as text',
    !t.includes('数到三就行（dev') || !t.includes('dev 回声** — 你说的是：数到三就行\n'));
};

// 7 — fail loud: unknown intent and unknown view event both throw
const stepFailLoud = (skin) => {
  let threw = false;
  try { skin.tap({ type: 'explode' }); } catch { threw = true; }
  check('fail loud: unknown intent throws', threw);
  threw = false;
  try { skin.pushViewEvent({ type: 'alien' }); } catch { threw = true; }
  check('fail loud: unknown view event throws', threw);
  threw = false;
  try { assertViewEvent({ type: 'session-settled', kind: 'user-message' }); } catch { threw = true; }
  check('fail loud: malformed payload throws', threw);
};

const report = (skin) => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[run-mock] ${results.length - failed.length}/${results.length} checks green`);
  if (failed.length > 0) {
    console.error('[run-mock] FAILED:', failed.map((f) => f.name).join(' | '));
    console.error('[run-mock] final transcript:\n' + skin.transcript);
    process.exit(1);
  }
  console.log('[run-mock] full mock loop GREEN');
};

const run = async () => {
  const { mock, serve, skin, driver } = await boot();
  stepColdStart(skin);
  const created = await stepSessions(skin, driver);
  await stepEchoTurn(skin);
  await stepReselect(skin, driver, created);
  await stepCancel(skin, serve, created);
  stepFailLoud(skin);
  console.log(`[run-mock] mux frames: ${serve.diag.frames} routed: ${serve.diag.routed} dropped: ${serve.diag.dropped} throws: ${serve.diag.throws}`);
  check('transport: frames actually routed', serve.diag.routed > 20, `routed=${serve.diag.routed}`);
  await driver.teardown();
  await mock.close();
  report(skin);
};

run().catch((error) => {
  console.error('[run-mock] loop aborted:', error);
  process.exit(1);
});
