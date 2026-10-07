// dsh:logging-exempt (spine-boot module, the session-live template's class:
// the demand/take/post helper trio never logs — the mounted logger carries
// every canonical line the creation turn emits)
/**
 * real-create.js — the CREATE-mode live demo behind the whale creation
 * client: the FULL upstream spine boots on the STAGED real backend (the
 * llm.live-stream credential handshake verbatim, `userEndpoint: true`),
 * the whale page mounts as the carrier web root, and ONE REAL turn —
 * "create a Pomodoro clock" — runs with the creation row mounted
 * (workspace files as deliverables). The assistant's deltas project into
 * the page LIVE (token-delta over session-projection@0), the created file
 * tree is listed from the workspace when the turn settles, and the
 * `realcreate/summary` marker tells the runner to screenshot.
 *
 * This is a DEMO leg, not an acceptance leg: a creative turn's records are
 * the model's own, so there is no one-to-one manifest — the evidence is the
 * capture, the workspace listing, and the screenshot.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite, fsList } from 'gateway.js';
import { utf8Decode, utf8Encode } from 'llm.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';

const SCENARIO = 'real.create';
const AGENT_ID = 'main';
const SESSION_ID = 's-real-create-0001';
const CONFIG_PATH = 'llm-live-stream/config.json';
const PROMPT = '用 write 工具在当前工作区真实创建一个番茄时钟插件：目录 pomodoro-clock/，'
  + '必须写出三个文件——manifest.json（插件清单）、plugin.js（25 分钟专注 + 5 分钟休息的番茄钟计时逻辑）、'
  + 'card.json（显示倒计时和开始/重置按钮的卡片）。不要只在回复里给代码：用工具把每个文件写到磁盘上，'
  + '写完后用 read 工具核对 pomodoro-clock/manifest.json 存在，最后告诉我创建了哪些文件。';

const log = createLogger('real.create.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};
const fail = (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};


/** The staged credential (the llm.live-stream handshake's path). The send
 * lands ASYNCHRONOUSLY after the stage-ready marker, so the read polls until
 * the file carries the real config. NO timer sleep: this host's timers never
 * fire (the timerSchedule denial, T2's known boundary) — an awaited
 * setTimeout would hang the poll forever; each failed fsRead is itself a
 * gateway round trip that yields the runtime thread to the host pump. */
const readStagedConfig = async () => {
  log.debug('staged config poll begin', { path: CONFIG_PATH });
  const deadline = Date.now() + 120_000;
  for (;;) {
    let cfg = null;
    try {
      cfg = JSON.parse(utf8Decode((await fsRead('app', CONFIG_PATH)).bytes));
    } catch { cfg = null; }
    if (cfg !== null && typeof cfg.baseUrl === 'string'
        && cfg.baseUrl.indexOf('https://') === 0) {
      return cfg;
    }
    if (Date.now() > deadline) {
      throw new Error('the staged credential never appeared within 120s');
    }
  }
};

/** One REAL upstream turn; resolves when idle. */
const runTurn = async (agent, text) => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

/** List the workspace tree to depth 2 (the created files, by name). */
const listTree = async (root) => {
  const out = [];
  const walk = async (rel, depth) => {
    const listing = await fsList('app', rel === '' ? '.' : rel);
    const entries = typeof listing === 'object' && listing !== null
      ? (listing.entries ?? listing.files ?? listing) : listing;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = typeof entry === 'string' ? entry : (entry.name ?? JSON.stringify(entry));
      out.push(rel === '' ? name : `${rel}/${name}`);
      if (depth > 0 && typeof entry === 'object' && entry.isDirectory) {
        await walk(`${rel}/${name}`.replace(/^\//, ''), depth - 1);
      }
    }
  };
  try {
    await walk('', 1);
  } catch (e) {
    log.debug('workspace listing partial', { error: e.message, listed: out.length });
  }
  return out;
};

/** The spine boot options: the creation row mounted, the llm route the
 * STAGED real backend, and the assistant's content deltas projected into the
 * whale page live (reasoning chunks stay out of the transcript view). */
const spineOptions = (cfg, containerRoot) => ({
  scenario: SCENARIO,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
  cwd: containerRoot,
  creation: true,
  onEvent: emit,
  container: {
    cwd: containerRoot,
    // The scope root == the container: the shell tool's workspace gate
    // demands the workspace start with __dshProfileScopeRoot, and this
    // seat's fs scope root IS the container (the bare-spelling posture).
    scopeRoot: containerRoot,
    tmpdir: `${containerRoot}/tmp`,
    home: `${containerRoot}/home`,
    env: {},
    argv: ['dsh', '--profile', 'mobile'],
  },
  llm: {
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    provider: 'bigmodel',
    model: cfg.model,
    userEndpoint: true,
    // A reasoning model's first byte can take minutes over the emulator
    // network — the loop-u2 read-idle guard's 120s default would cut every
    // attempt mid-thinking (measured: three consecutive 120s cuts).
    readIdleTimeoutMs: 300_000,
    adapterName: 'bigmodel coding-plan chat-completions (gateway httpFetch, live create demo)',
    transportLabel: 'gateway httpFetch → real bigmodel backend (CREATE-mode live demo)',
    onSse: (info) => {
      const text = info?.text ?? info?.delta?.text
        ?? (typeof info?.delta === 'string' ? info.delta : '');
      if (typeof text === 'string' && text.length > 0) {
        project({ kind: 'token-delta', index: 0, text });
      }
    },
  },
});

const main = async () => {
  log.debug('main begin', {});
  // The container root rides a FILE the host stages before the eval (no bus
  // delivery race): fs scope app IS that root, so a scope-relative read.
  const { bytes: rootBytes } = await fsRead('app', 'real-create/root.json');
  const { containerRoot } = JSON.parse(utf8Decode(rootBytes));
  demand(typeof containerRoot === 'string' && containerRoot.startsWith('/'),
    `profile container not staged: ${JSON.stringify(containerRoot)}`);

  const cfg = await readStagedConfig();
  emit('realcreate/config/loaded', { baseUrl: cfg.baseUrl, model: cfg.model });

  const { ctx } = await bootUpstream(spineOptions(cfg, containerRoot));
  const session = ctx.sessions.get(SESSION_ID);
  demand(session !== undefined, `session "${SESSION_ID}" never appeared in the store`);
  emit('realcreate/spine/booted', { sessionId: SESSION_ID });

  project({ kind: 'session', id: SESSION_ID, scope: 'app' });
  project({ kind: 'agent', model: cfg.model });

  emit('realcreate/turn/begin', { prompt: PROMPT });
  await runTurn(ctx.agents.get(SESSION_ID), PROMPT);
  await reportAndComplete(ctx, session);
};

/** Post-turn reporting: the tool round trips projected after the fact (the
 * loop does not expose live tool hooks), the created file tree verbatim from
 * the fs primitive, and the completion markers. */
const reportAndComplete = async (ctx, session) => {
  const events = session.snapshotEvents();
  for (const record of events) {
    if (record.type === 'tool/call') {
      project({ kind: 'tool', name: record.data?.tool ?? record.data?.name ?? 'tool', phase: 'invoke' });
    } else if (record.type === 'tool/result') {
      project({ kind: 'tool', name: 'tool', phase: 'result', ok: true });
    }
  }

  // The created files: the workspace tree, verbatim from the fs primitive.
  const files = await listTree('');
  emit('realcreate/files', { files });
  project({ kind: 'token-delta', index: 0, text: `\n[workspace] ${files.join('  ')}` });

  const assistant = events.find((record) => record.type === 'assistant/message');
  const text = ((assistant?.data?.message?.content ?? assistant?.data?.content ?? [])
    .filter((block) => block.type === 'text').map((block) => block.text).join('')) || '';
  emit('realcreate/summary', { files: files.length, replyChars: text.length });
  project({ kind: 'complete', status: 'pass' });
  globalThis.__dshComplete(true, `real.create: creation turn settled (${files.length} workspace entries)`);
};

main().catch(fail);
