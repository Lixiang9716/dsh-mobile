// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * next-mode.mjs — `dev-carrier.mjs --client next`: the SAME auth-lite +
 * /api + mux surface, but the fallback seat serves OUR client
 * (presentation/web-client-v2/web, zero injection rows — the page owns
 * its whole boot) and the claim surface grows a LIVE dev turn:
 * session/create mints a session, session/prompt appends the durable
 * user/message and runs a canned echo turn streamed over session/follow
 * (assistant-stream chunk frames + durable records), exercising the full
 * render path — streaming tail, markdown, tool cards, collapse groups.
 *
 * Honest by construction: every served fact is this file's own fixture
 * behavior, labeled dev-echo in the turn content; nothing pretends to be
 * the runtime. session/cancel IS claimed here (a real local cancel), so
 * the stop button is exercisable end-to-end. The BYOK onboarding legs
 * (onboarding/status|save|clear) answer from the shared in-memory mock
 * keychain (onboarding-route.mjs) — the web-client-v2 panel boots in the
 * loop; the onboarding/test probe stream stays gateway/unimplemented (see
 * that module's honest boundary).
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnboarding, onboardingOutcome } from './onboarding-route.mjs';
import { acceptUpgrade } from './ws-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', map: 'application/json',
};

const wireEvent = (record) => ({
  type: 'event',
  event: {
    type: record.type, seq: record.seq, time: record.time ?? 0, data: record.data ?? {},
  },
});

const state = () => {
  let nextId = 1;
  let nextSeq = 1;
  return {
    sessions: new Map(), // id → {id, createdAt, journal, followers, running, title}
    mint: () => `s-dev-next-${String(nextId++).padStart(4, '0')}`,
    seq: () => nextSeq++,
    onboarding: createOnboarding(), // the BYOK mock keychain (onboarding-route.mjs)
  };
};

/** The canned turn script: durable bookends, the live stream frames, and
 * the durable settle records (parameterized by turn so every echo is a
 * fresh attempt identity). */
const echoScript = (turn, promptText) => {
  const attemptId = `dev-a${turn}`;
  const callId = `dev-c${turn}`;
  const step = 1;

  const appShell = appShellScriptFor(turn, promptText, attemptId);
  if (appShell) return appShell;

  const reply = [
    `**dev 回声** — 你说的是：${promptText}`,
    '',
    '## 渲染检查',
    '- 行内 `code`、**粗体**、*斜体*、[链接](https://example.com)',
    '- 列表第二项',
    '',
    '```js',
    'const greeting = "hello from the fence";',
    'console.log(greeting);',
    '```',
  ].join('\n');
  return {
    steps: [
      { type: 'turn/start', data: { turn } },
      { type: 'step/start', data: { turn, step } },
    ],
    stream: [
      { type: 'start', attemptId, turn, step },
      { type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', index: 0, text: '整理一次回声回复（dev 载体，非真实模型）…' } },
      { type: 'chunk', attemptId, chunk: { type: 'tool-call-delta', index: 1, id: callId, name: 'bash', argumentsDelta: '{"command"' } },
      { type: 'chunk', attemptId, chunk: { type: 'tool-call-delta', index: 1, id: callId, argumentsDelta: ':"ls -la"}' } },
      { type: 'chunk', attemptId, chunk: { type: 'text-delta', index: 2, text: reply } },
      { type: 'end', attemptId },
    ],
    settle: [
      { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } },
      { type: 'tool/call', data: { turn, step, callId, name: 'bash', arguments: '{"command":"ls -la"}' } },
      { type: 'tool/result', data: { turn, step, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'total 24\ndrwxr-xr-x  12 dev  staff   384 Jan  1 12:00 .\n-rw-r--r--   1 dev  staff  8192 Jan  1 12:00 AGENTS.md' }] }] } } },
      { type: 'step/end', data: { turn, step } },
      { type: 'turn/end', data: { turn, reason: { kind: 'stop' } } },
      { type: 'session/title', data: { title: promptText.slice(0, 12) || 'dev 会话' } },
      { type: 'deliverables/presented', data: { turn, callId, files: [{ path: 'creations/blue-compact.html', description: '桌面回声鲸鱼' }] } },
    ],
  };
};

/** Drive one echo turn through `session`: the bookends land in the durable
 * journal, the stream frames ride the live followers (retained in
 * activeFrames so a re-open snapshot can resume the tail). */
const runEchoTurn = (session, promptText, seq, done) => {
  const turn = (session.nextTurn = (session.nextTurn ?? 0) + 1);
  const { steps, stream, settle } = echoScript(turn, promptText);
  const post = (record) => {
    session.journal.push(record);
    for (const follower of session.followers) follower.send(wireEvent(record));
  };
  const broadcast = (frame) => {
    for (const follower of session.followers) follower.send(frame);
  };
  let cancelled = false;
  session.cancelTurn = () => { cancelled = true; };
  let index = 0;
  const tick = () => {
    try {
      console.error('[tick-probe]', turn, index, 'of', steps.length + stream.length + settle.length);
      if (cancelled) return finishCancelled(session, post, seq, turn, done);
      if (index < steps.length) {
        post({ ...steps[index++], seq: seq(), time: Date.now() / 1000 });
        return setTimeout(tick, 30);
      }
      if (index < steps.length + stream.length) {
        stepFrame(session, stream[index++ - steps.length]);
        return setTimeout(tick, 55);
      }
      if (index < steps.length + stream.length + settle.length) {
        post({ ...settle[index++ - steps.length - stream.length], seq: seq(), time: Date.now() / 1000 });
        return setTimeout(tick, 40);
      }
    } catch (error) {
      console.error('[dev-web-carrier:next] turn tick threw:', error);
    }
    session.running = false;
    done();
  };
  setTimeout(tick, 30);
};

const stepFrame = (session, frame) => {
  session.activeFrames.push(frame);
  if (frame.type === 'end') session.activeFrames = [];
  for (const follower of session.followers) follower.send(frame);
};

const finishCancelled = (session, post, seq, turn, done) => {
  session.activeFrames = [];
  post({
    type: 'turn/end', seq: seq(), time: Date.now() / 1000,
    data: { turn, reason: { kind: 'cancelled' } },
  });
  session.running = false;
  done();
};

/** Seed the fixture session so the home list is not empty. */
const seedFrom = (machine, sessionsFixture, journalPath) => {
  const journal = existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
    : [];
  for (const item of sessionsFixture.items ?? []) {
    machine.sessions.set(item.sessionId, {
      id: item.sessionId, createdAt: item.updatedAt ?? 0,
      journal, followers: new Set(), running: false, activeFrames: [],
      title: item.sessionId === 's-dev-carrier-0001' ? 'dev 载体示例' : undefined,
    });
  }
};

/** The onboarding arm: the shared mock-keychain legs (onboarding-route.mjs);
 * an unknown onboarding verb stays the carrier's unimplemented business. */
const serveOnboarding = (machine, endpoint, bodyText, respond) => {
  const outcome = onboardingOutcome(machine.onboarding, endpoint, requestOf(bodyText)?.args);
  if (outcome === null) {
    return fail(respond, bodyText, 'gateway/unimplemented',
      `endpoint ${endpoint} is not implemented by the dev carrier`);
  }
  return outcome.ok ? ok(respond, bodyText, outcome.value)
    : fail(respond, bodyText, outcome.error.code, outcome.error.message);
};

const apiHandler = (machine, url, bodyText, respond) => {
  const endpoint = url.pathname.slice('/api/'.length);
  if (endpoint === 'session/list') {
    const items = [...machine.sessions.values()].map((session) => ({
      sessionId: session.id,
      updatedAt: session.createdAt,
      running: session.running,
      blank: session.journal.length === 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt);
    return ok(respond, bodyText, { items });
  }
  if (endpoint === 'session/create') {
    const id = machine.mint();
    machine.sessions.set(id, {
      id, createdAt: Date.now() / 1000, journal: [],
      followers: new Set(), running: false, activeFrames: [],
    });
    return ok(respond, bodyText, { sessionId: id });
  }
  const session = machine.sessions.get(requestOf(bodyText)?.sessionId);
  if (endpoint === 'session/prompt') {
    console.error('[carrier-probe] session/prompt arrived; session.running =', session.running);
    if (session === undefined) return fail(respond, bodyText, 'session/not-found', 'unknown session');
    if (session.running) return fail(respond, bodyText, 'session/busy', 'dev turn already running');
    const text = (requestOf(bodyText)?.content ?? [])
      .filter((block) => block?.type === 'text').map((block) => block.text).join('');
    session.running = true;
    session.journal.push({
      type: 'user/message', seq: machine.seq(), time: Date.now() / 1000,
      data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    });
    for (const follower of session.followers) {
      follower.send(wireEvent(session.journal.at(-1)));
    }
    runEchoTurn(session, text, machine.seq, () => {});
    return ok(respond, bodyText, { accepted: true });
  }
  if (endpoint === 'session/cancel') {
    if (session === undefined) return fail(respond, bodyText, 'session/not-found', 'unknown session');
    session.cancelTurn?.();
    return ok(respond, bodyText, { cancelled: true });
  }
  if (endpoint.startsWith('onboarding/')) {
    return serveOnboarding(machine, endpoint, bodyText, respond);
  }
  return fail(respond, bodyText, 'gateway/unimplemented', `endpoint ${endpoint} is not implemented by the dev carrier`);
};

const rpcIdOf = (bodyText) => {
  try { return JSON.parse(bodyText)?.rpcId ?? ''; } catch { return ''; }
};
const ok = (respond, bodyText, value) => respond(200, 'application/json',
  JSON.stringify({ type: 'server-response', rpcId: rpcIdOf(bodyText), result: { ok: true, value } }));
const requestOf = (bodyText) => {
  try {
    const body = JSON.parse(bodyText);
    return body?.payload?.args?.request ?? body?.payload?.request
      ?? body?.payload ?? {};
  } catch { return {}; }
};
const fail = (respond, bodyText, code, message) => respond(200, 'application/json',
  JSON.stringify({
    type: 'server-response', rpcId: rpcIdOf(bodyText),
    result: { ok: false, error: { code, message, details: {} } },
  }));

const handleMux = (machine, ws, text) => {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type !== 'open' || typeof msg.streamId !== 'string') return;
  const request = msg.payload?.args?.request ?? msg.payload?.args ?? {};
  const sessionId = request.address?.sessionId ?? request.sessionId;
  const session = machine.sessions.get(sessionId);
  if (session === undefined) {
    return ws.sendText(JSON.stringify({
      type: 'error', streamId: msg.streamId,
      error: { code: 'gateway/unavailable', message: `session ${JSON.stringify(sessionId ?? null)} is not attached`, details: {} },
    }));
  }
  if (msg.endpoint !== 'session/follow') {
    if (msg.endpoint === 'workspace/follow' || msg.endpoint === '$events') return;
    return ws.sendText(JSON.stringify({
      type: 'error', streamId: msg.streamId,
      error: { code: 'gateway/unimplemented', message: `stream ${msg.endpoint} not implemented`, details: {} },
    }));
  }
  const send = (value) => ws.sendText(JSON.stringify({ type: 'item', streamId: msg.streamId, value }));
  send({
    type: 'snapshot',
    header: { version: 3, id: session.id, createdAt: session.createdAt, isSeeded: false },
    cursor: session.journal.length - 1,
    records: session.journal.map(wireEvent),
    hasMore: false,
    projections: { asOfSeq: session.journal.length - 1, values: {} },
    assistantStream: session.activeFrames.length > 0
      ? { revision: 1, activeAttempt: {
        attemptId: session.activeFrames[0].attemptId,
        startedAfterSeq: session.journal.length - 1,
        turn: session.activeFrames[0].turn, step: session.activeFrames[0].step,
        nextIndex: session.activeFrames.length, stream: session.activeFrames,
      } }
      : { revision: 0 },
  });
  const follower = { streamId: msg.streamId, send };
  session.followers.add(follower);
  const sweep = () => session.followers.delete(follower);
  ws.onClose(sweep);
};

const buildHandler = (machine, webRoot, token, isAuthed) => (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const respond = (status, mime, body, headers = {}) => {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'Content-Type': mime, 'Content-Length': buf.length, ...headers });
    res.end(buf);
  };
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return serveApi(machine, req, url, respond);
    }
    serveStatic(respond, req, res, url, webRoot, token, isAuthed);
  } catch (error) {
    console.error('[dev-web-carrier:next] request failed:', error?.stack ?? error);
    respond(400, 'text/plain', '');
  }
};

const serveApi = (machine, req, url, respond) => {
  if (req.method !== 'POST') return respond(405, 'text/plain', '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      apiHandler(machine, url, Buffer.concat(chunks).toString('utf8'), respond);
    } catch (error) {
      console.error('[dev-web-carrier:next] api handler failed:', error?.stack ?? error);
      respond(400, 'text/plain', '');
    }
  });
};

const serveStatic = (respond, req, res, url, webRoot, token, isAuthed) => {
  if (!isAuthed(req)) return authReject(respond, res, url, token);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const abs = normalize(join(webRoot, rel));
  if (!abs.startsWith(webRoot + sep) || !existsSync(abs) || statSync(abs).isDirectory()) {
    return respond(404, 'text/plain', '');
  }
  const ext = abs.split('.').pop();
  const body = readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
};

const authReject = (respond, res, url, token) => {
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    return respond(303, 'text/plain', '', {
      'Set-Cookie': `dsh-dev-carrier=${token}; Path=/; HttpOnly`, Location: '/',
    });
  }
  respond(401, 'text/plain', '');
};

export const startNextCarrier = ({ repoRoot, port, sessionsFixture, journalPath }) => {
  const webRoot = join(repoRoot, 'presentation/web-client-v2/web');
  const machine = state();
  seedFrom(machine, sessionsFixture, journalPath);
  const token = randomBytes(16).toString('hex');
  const COOKIE = 'dsh-dev-carrier';
  const isAuthed = (req) => (req.headers.cookie ?? '').split(';')
    .map((c) => c.trim()).some((c) => c === `${COOKIE}=${token}`);
  const server = createServer(buildHandler(machine, webRoot, token, isAuthed));
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/remote.mux' || !isAuthed(req)) return socket.destroy();
    console.log('[dev-web-carrier:next] mux upgrade accepted');
    socket.on('close', () => console.log('[dev-web-carrier:next] mux socket closed'));
    const ws = acceptUpgrade(req, socket);
    if (ws !== null) ws.onText((text) => handleMux(machine, ws, text));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, token }));
  });
};

/** The app-shell leg: a prompt naming a known app theme renders that theme
 * as an appshell_render tool call whose result echoes the spec — the exact
 * shape the plugin emits, mocked carrier-side (no runtime here). Themes are
 * matched by regex; unknown prompts fall through to the echo turn. */
const APP_SHELL_THEMES = {
  wechat: { label: '微信', re: /微信|wechat|weixin/i, accent: '#07C160',
    tabs: ['微信', '通讯录', '发现', '我'] },
  netease: { label: '网易云音乐', re: /网易云|云音乐|netease/i, accent: '#ec4141',
    tabs: ['我的', '音乐馆', '云村', '账号'] },
  alipay: { label: '支付宝', re: /支付宝|alipay|支付/i, accent: '#1677FF',
    tabs: ['首页', '理财', '生活', '我的'] },
};

const appShellScriptFor = (turn, promptText, attemptId) => {
  const appKey = Object.keys(APP_SHELL_THEMES).find(
    (k) => APP_SHELL_THEMES[k].re.test(promptText));
  if (!appKey) return null;
  const app = APP_SHELL_THEMES[appKey];
  const spec = {
    spec: 'app-shell/0.9', theme: { accent: app.accent, mode: 'light' },
    tabs: app.tabs, actions: ['demo.tap'],
    screen: { type: 'column', children: [
      { type: 'banner-card', title: app.label, subtitle: '由一句话生成 · app-shell/0.9' },
      { type: 'service-grid', items: [
        { icon: '📷', label: '入口一' }, { icon: '💳', label: '入口二' },
        { icon: '🚌', label: '入口三' }, { icon: '⚡', label: '入口四' },
      ] },
      { type: 'hcard-row', items: [
        { cover: { emoji: '🎵', color: '#5a7cd4' }, title: '精选 A', sub: 'demo' },
        { cover: { emoji: '🌙', color: '#4d9e5f' }, title: '精选 B', sub: 'demo' },
      ] },
      { type: 'mini-player', cover: { emoji: '▶', color: app.accent }, title: '演示条目', sub: '点按动作回流', action: 'demo.tap' },
    ] },
  };
  const appCallId = `dev-app${turn}`;
  const appText = `已按你的描述生成 **${app.label}** 表面（app-shell/0.9 · 声明式组件树）——卡片上「打开」进入全屏，点按元素动作回流。`;
  return {
    steps: [
      { type: 'turn/start', data: { turn } },
      { type: 'step/start', data: { turn, step: 1 } },
    ],
    stream: [
      { type: 'start', attemptId, turn, step: 1 },
      { type: 'chunk', attemptId, chunk: { type: 'text-delta', index: 0, text: appText } },
      { type: 'end', attemptId },
    ],
    settle: [
      { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: appText }] } } },
      { type: 'tool/call', data: { turn, step: 1, callId: appCallId, name: 'appshell_render', arguments: JSON.stringify({ fixture: appKey }) } },
      { type: 'tool/result', data: { turn, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: appCallId, isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, title: app.label, spec }) }] }] } } },
      { type: 'step/end', data: { turn, step: 1 } },
      { type: 'turn/end', data: { turn, reason: { kind: 'stop' } } },
      { type: 'session/title', data: { title: app.label + ' · 生成表面' } },
    ],
  };
};
