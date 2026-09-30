// dsh:logging-exempt (test file: real local servers, no logging surface)
/**
 * driver-loop.test.js — run-mock.mjs's 18 internal checks, formalized as
 * vitest cases over the SAME real pair: the in-process mock serve
 * (canned dev-echo turn) on real loopback HTTP+WS, the real wire client
 * (session-serve → api/mux over ws-lite), the real driver, the stub skin.
 * The checks keep the runner's names and assertion substance 1:1 — the
 * runner stays the standalone green criterion; this file makes the same
 * behaviors a `npm test` citizen (and coverage evidence for the driver
 * face). Edge legs beyond the runner's 18 are marked EDGE: prompt before
 * entering a session, follow of a session the serve does not know (error
 * frame → honest 会话流不可用 + the follow left), a session/create answer
 * without a sessionId (fail loud into 创建失败), prompt/cancel on unknown
 * sessions (the wire error triple through the real mock endpoints), and
 * the lynx faces' no-engine wall + artifact verification.
 *
 * Assertions poll conditions with deadlines (rules.md §8) — never sleeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServe } from '../driver/mock/mock-serve.mjs';
import { createSessionServe } from '../driver/wire/session-serve.js';
import { createDriver } from '../driver/driver.js';
import { createStubSkin } from '../driver/skin-stub.js';
import { assertViewEvent } from '../shared/view-events.js';
import { createLynxSkin, verifyBundleArtifact } from '../driver/skin-lynx.js';

const DEADLINE_MS = 10_000;
const poll = async (what, fn) => {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = await fn(); // await: async predicates must be polled, not truthy-Promise'd
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`deadline exceeded waiting for: ${what}`);
};

// The 18 runner checks share one booted loop (the steps depend on each
// other exactly like run-mock's), so the describes below run sequentially
// over one mock serve; edge legs boot their own.
const ctx = {};
beforeAll(async () => {
  const mock = await startMockServe();
  const serve = createSessionServe({ baseUrl: mock.baseUrl });
  const skin = createStubSkin({ stream: null });
  const driver = createDriver({ skin, serve });
  await driver.mount();
  await poll('connection open', () => skin.transcript.includes('已连接'));
  await poll('sessions settle on the drawer', () => skin.transcript.includes('新会话'));
  Object.assign(ctx, { mock, serve, skin, driver });
  ctx.markers = new Set();
  ctx.watcher = setInterval(() => {
    for (const m of ['生成中…', '准备中', '等待结果', '完成', '▍']) {
      if (ctx.skin.transcript.includes(m)) ctx.markers.add(m);
    }
  }, 15);
});
afterAll(async () => {
  clearInterval(ctx.watcher);
  if (ctx.driver) await ctx.driver.teardown();
  if (ctx.mock) await ctx.mock.close();
});

// 1 — cold start: shell + drawer + connection, never blank
describe('cold start (runner checks 1-3)', () => {
  it('shows the DSH wordmark + 输入条 shell', () => {
    const t = ctx.skin.transcript;
    expect(t.includes('『DSH』') && t.includes('输入条')).toBe(true);
  });
  it('drawer lists the seeded session', () => {
    expect(ctx.skin.transcript.includes('s-dev-ly')).toBe(true);
  });
  it('connection capsule', () => {
    expect(ctx.skin.transcript.includes('已连接')).toBe(true);
  });
});

// EDGE — submit before any session: honest 尚未进入会话, no optimistic flip
describe('edge: submit with no session attached', () => {
  it('fails loud into 尚未进入会话 and does not start a turn', async () => {
    ctx.skin.tap({ type: 'submit', text: '太早了' });
    await poll('尚未进入会话 status', () => ctx.skin.transcript.includes('尚未进入会话'));
    const t = ctx.skin.transcript;
    expect(t.includes('[ ↑ 发送 ]')).toBe(true); // not running: no optimistic stop chip
  });
});

// 2+3 — select-session, then new-session (create + open)
describe('sessions: select + create + open (runner checks 4-5)', () => {
  it('select-session: follow attached', async () => {
    ctx.skin.tap({ type: 'select-session', sessionId: 's-dev-lynx-0000' });
    await poll('session follow open',
      () => ctx.driver.activeSession() === 's-dev-lynx-0000');
    expect(ctx.driver.activeSession()).toBe('s-dev-lynx-0000');
  });
  it('new-session: created and opened', async () => {
    ctx.skin.tap({ type: 'new-session' });
    const created = await poll('new session created+opened', () => {
      const id = ctx.driver.activeSession();
      return typeof id === 'string' && id !== 's-dev-lynx-0000' ? id : null;
    });
    await poll('drawer shows the new session', () => ctx.skin.transcript.includes(created.slice(0, 8)));
    expect(created.startsWith('s-dev-lynx-')).toBe(true);
    ctx.created = created;
  });
});

// 4 — submit: the full echo turn streams through the fold
describe('echo turn (runner checks 6-11)', () => {
  it('user bubble echoed', async () => {
    ctx.skin.tap({ type: 'submit', text: '画出极光' });
    await poll('prompt admitted', () => ctx.skin.transcript.includes('[你] 画出极光'));
    expect(ctx.skin.transcript.includes('[你] 画出极光')).toBe(true);
  });
  it('turn settles: reply, tool card, creation, title — all through the fold', async () => {
    await poll('turn settled (title + creation + cursor retired)',
      () => ctx.skin.transcript.includes('桌面回声鲸鱼')
        && ctx.markers.has('▍') // the turn really streamed live
        && !ctx.skin.transcript.includes('生成中…'));
    const t = ctx.skin.transcript;
    expect(t.includes('dev 回声') && t.includes('渲染检查')).toBe(true); // assistant reply settled
    expect(t.includes('bash · 完成') && t.includes('AGENTS.md')).toBe(true); // tool card collapsed with OUT
    expect(t.includes('桌面回声鲸鱼')).toBe(true); // creation card
    expect(ctx.markers.has('准备中') && ctx.markers.has('等待结果') && ctx.markers.has('完成')).toBe(true);
    expect(t.includes('画出极光')).toBe(true); // session title settled
    expect(t.includes('回合结束')).toBe(false); // a normal stop is silent, never a warn row
  });
});

// 5 — re-select: mid-history mount rebuilds from the seed burst
describe('re-select seed rebuild (runner check 12)', () => {
  it('seed replay rebuilds the thread (no blank mount)', async () => {
    ctx.skin.tap({ type: 'select-session', sessionId: 's-dev-lynx-0000' });
    await poll('switched away', () => ctx.driver.activeSession() === 's-dev-lynx-0000');
    ctx.skin.tap({ type: 'select-session', sessionId: ctx.created });
    await poll('re-opened', () => ctx.driver.activeSession() === ctx.created);
    await poll('seed rebuild done', () => ctx.skin.transcript.includes('dev 回声'));
    const t = ctx.skin.transcript;
    expect(t.includes('[你] 画出极光') && t.includes('bash · 完成') && t.includes('桌面回声鲸鱼')).toBe(true);
  });
});

// 6 — cancel: optimistic stop, then 已停止 with the tail dropped. The view
// settles one server tick before the mock's running flag does — wait for
// the wire truth (session/list running=false), as the runner does.
describe('cancel (runner checks 13-14)', () => {
  it('已停止 status, no hung tail, cancelled reply never settles', async () => {
    await poll('mock session idle (running=false)', async () => {
      const value = await ctx.serve.list();
      const item = (value?.items ?? []).find((s) => s.sessionId === ctx.created);
      return item?.running === false;
    });
    ctx.skin.tap({ type: 'submit', text: '数到三就行' });
    await poll('second turn streaming', () => ctx.skin.transcript.includes('生成中…')
      || ctx.skin.transcript.includes('准备中'));
    ctx.skin.tap({ type: 'cancel' });
    await poll('cancelled settle', () => ctx.skin.transcript.includes('已停止'));
    await poll('tail dropped, running idle', () => !ctx.skin.transcript.includes('生成中…')
      && !ctx.skin.transcript.includes('▍'));
    const t = ctx.skin.transcript;
    expect(t.includes('已停止')).toBe(true);
    expect(t.includes('数到三就行（dev') || t.includes('dev 回声** — 你说的是：数到三就行\n')).toBe(false);
  });
});

// 7 — fail loud: unknown intent and unknown view event both throw
describe('fail loud (runner checks 15-17)', () => {
  it('unknown intent throws', () => {
    expect(() => ctx.skin.tap({ type: 'explode' })).toThrow();
  });
  it('unknown view event throws', () => {
    expect(() => ctx.skin.pushViewEvent({ type: 'alien' })).toThrow();
  });
  it('malformed payload throws', () => {
    expect(() => assertViewEvent({ type: 'session-settled', kind: 'user-message' })).toThrow();
  });
});

// EDGE — the follow of a session the serve does not know: an error frame,
// surfaced honestly (会话流不可用), and the dead follow left.
describe('edge: follow of an unknown session (stream error path)', () => {
  it('surfaces 会话流不可用 and leaves the session', async () => {
    ctx.driver.openSession('s-ghost');
    await poll('error surfaced', () => ctx.skin.transcript.includes('会话流不可用（gateway/unavailable）'));
    expect(ctx.driver.activeSession()).toBe(null);
  });
});

// 18 — transport: frames actually routed
describe('transport (runner check 18)', () => {
  it('mux frames actually routed', () => {
    expect(ctx.serve.diag.routed).toBeGreaterThan(20);
  });
});

// EDGE — the mock serve's endpoint guards, through the real wire client.
describe('edge: mock endpoint guards via the real envelope', () => {
  it('prompt on an unknown session rejects session/not-found', async () => {
    await expect(ctx.serve.prompt('s-ghost', 'x'))
      .rejects.toMatchObject({ code: 'session/not-found' });
  });
  it('cancel on an unknown session rejects session/not-found', async () => {
    await expect(ctx.serve.cancel('s-ghost'))
      .rejects.toMatchObject({ code: 'session/not-found' });
  });
  it('cancel on a live idle session succeeds (mock accepts it quietly)', async () => {
    await expect(ctx.serve.cancel('s-dev-lynx-0000')).resolves.toMatchObject({ cancelled: true });
  });
});

describe('edge: a session/create answer without a sessionId', () => {
  it('fails loud into 创建失败, never a blank follow', async () => {
    const { createServer } = await import('node:http');
    let seen = 0;
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw === '' ? {} : JSON.parse(raw); // an upgrade probe rides in with no body
        const value = seen++ === 0 ? { items: [] } : {}; // create: no sessionId
        const buf = Buffer.from(JSON.stringify({
          type: 'server-response', rpcId: body.rpcId, result: { ok: true, value },
        }), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
        res.end(buf);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const serve = createSessionServe({ baseUrl });
    const skin = createStubSkin({ stream: null });
    const driver = createDriver({ skin, serve });
    await driver.mount();
    try {
      skin.tap({ type: 'new-session' });
      await poll('创建失败 surfaced', () => skin.transcript.includes('创建失败'));
      expect(driver.activeSession()).toBe(null); // no follow opened on a bogus create
    } finally {
      await driver.teardown();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('lynx face: artifact verification + the no-engine wall (node-real)', () => {
  it('verifyBundleArtifact verifies the committed bundle and records its sha256', () => {
    const artifact = verifyBundleArtifact();
    expect(artifact.bytes).toBeGreaterThan(1024);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('engine mode refuses to mount without a Lynx engine, naming the wall', async () => {
    delete globalThis.__dshRenderSurface;
    const skin = createLynxSkin();
    await expect(skin.mount()).rejects.toThrow(/no Lynx engine/);
  });
  it('cli-host mode drives the bundle seam core: mount, fold, intent, teardown', async () => {
    const skin = createLynxSkin({ host: 'cli' });
    await skin.mount();
    expect(skin.face).toBe('lynx');
    expect(skin.mountMode).toMatch(/cli: bundle seam core/);
    expect(skin.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    const intents = [];
    skin.onIntent((intent) => intents.push(intent));
    skin.pushViewEvent(assertViewEvent({ type: 'session-settled', kind: 'user-message', text: '桥' }));
    expect(skin.transcript.includes('[你] 桥')).toBe(true);
    skin.tap({ type: 'cancel' });
    expect(intents).toEqual([{ type: 'cancel' }]);
    await skin.teardown();
    expect(() => skin.tap({ type: 'cancel' })).toThrow(/no intent handler/);
  });
});
