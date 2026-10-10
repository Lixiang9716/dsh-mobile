// dsh:logging-exempt (scenario; the logger face is the seat's emit)
/**
 * create-calendar-live — the cordis-native creation chain as ONE scenario:
 * a REAL-backend turn ("做一个日历插件") driven directly on the agent (the
 * real-create pattern — NO page in the critical path), then the LIVE MOUNT
 * through plugin-mount.js: native approval → registry → __dshModuleDefine
 * dynamic import → ctx.plugin — the plugin's own apply() runs and drives
 * its card. The model decides the tool call for real; the mount chain is
 * the product pipeline; the evidence is plugin.mount.* + plugin.running.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsList } from 'gateway.js';
import { utf8Decode } from 'llm.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootUpstream } from 'upstream/boot.js';
import { mountWorkspacePlugin } from 'plugin-mount.js';

const SCENARIO = 'create.calendar.live';
const AGENT_ID = 'main';
const SESSION_ID = 's-calendar-live-0001';
const CONFIG_PATH = 'llm/config.json';
const PROMPT = '做一个日历插件。用 plugin_create 工具,name=calendar-plugin,'
  + 'title=日历,kind=calendar。立刻调用工具,不要用文字回答。';

const log = createLogger('calendar.live.dsh');
const emit = (event, fields = {}) =>
  log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const message = reason instanceof Error ? `${reason.message} @ ${reason.stack ?? JSON.stringify({ f: reason.fileName, l: reason.lineNumber })}` : String(reason);
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

/** The staged credential (the serve seat's credential file — polled, no
 * timer sleep: each failed fsRead is itself a round trip that yields). */
const readStagedConfig = async () => {
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

const spineOptions = (cfg, containerRoot) => ({
  scenario: SCENARIO,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
  cwd: containerRoot,
  creation: true,
  container: {
    cwd: containerRoot,
    scopeRoot: containerRoot,
    tmpdir: `${containerRoot}/tmp`,
    home: `${containerRoot}/home`,
    env: {},
    argv: ['dsh', '--profile', 'mobile'],
  },
  llm: {
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    provider: 'openai-compatible',
    model: cfg.model,
    userEndpoint: true,
    readIdleTimeoutMs: 300_000,
    adapterName: 'openai-compatible chat-completions (gateway httpFetch, calendar live)',
    transportLabel: 'gateway httpFetch → real backend (calendar live demo)',
  },
});

const listTree = async (root) => {
  const out = [];
  try {
    const listing = await fsList('app', root === '' ? '.' : root);
    const entries = typeof listing === 'object' && listing !== null
      ? (listing.entries ?? listing.files ?? listing) : listing;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = typeof entry === 'string' ? entry : (entry.name ?? '');
      if (name) out.push(root === '' ? name : `${root}/${name}`);
    }
  } catch { /* an absent tree is an honest empty */ }
  return out;
};

const main = async (ctx) => {
  emit('calendar/spine/booted', { sessionId: SESSION_ID });

  emit('calendar/turn/begin', { prompt: PROMPT });
  const agent = ctx.agents.get(SESSION_ID);
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: PROMPT }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  emit('calendar/turn/settled', {});

  const files = await listTree('plugins/calendar-plugin');
  emit('calendar/files', { files });
  if (files.length === 0) {
    fail('the model did not author plugins/calendar-plugin (no tool call)');
    return;
  }

  // THE LIVE MOUNT: approval (native) → registry → dynamic import →
  // ctx.plugin — the plugin's apply() runs as a result.
  const outcome = await mountWorkspacePlugin(ctx, 'calendar-plugin');
  if (!outcome.mounted) {
    fail(`mount refused at ${outcome.step}: ${outcome.reason ?? ''}`);
    return;
  }
  emit('calendar/mounted', { spec: outcome.spec, version: outcome.version });
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true,
    `create.calendar.live: mounted ${outcome.spec}@${outcome.version}`);
};

// Mirror the composer's bus machinery (web-boot.js's deliver): every staging
// message feeds the runtime half (the presets seed mounts the VFS); the
// real turn boots once the spine composition is live (web.plugins → booted).
import { createWebBootRuntime } from 'upstream/web-boot.js';
let booted = false;
let webRuntime = null;
let spineCtx = null;
const pending = [];
globalThis.__dshBusOnMessage = (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  // The host pump does NOT await this handler: messages racing the async
  // boot queue and replay once the runtime half exists.
  if (webRuntime === null && msg.type !== 'runtime.config') {
    pending.push(msg);
    return;
  }
  if (msg.type === 'runtime.config') {
    pending.push(msg);
    (async () => {
      try {
        const { bytes: rootBytes } = await fsRead('app', 'real-create/root.json');
        const { containerRoot } = JSON.parse(utf8Decode(rootBytes));
        const cfg = await readStagedConfig();
        emit('calendar/config/loaded', { baseUrl: cfg.baseUrl, model: cfg.model });
        emit('calendar/boot/pre', {
          spine: typeof spineOptions, boot: typeof bootUpstream,
          wso: typeof writeSurfaceOptions, cwbr: typeof createWebBootRuntime,
          fsRead: typeof fsRead, utf8: typeof utf8Decode });
        const opts = spineOptions(cfg, containerRoot);
      demand(typeof bootUpstream === 'function', `bootUpstream=${typeof bootUpstream}`);
      const booted = await bootUpstream(opts);
      demand(booted && typeof booted.ctx === 'object', 'bootUpstream returned no ctx');
      const ctx = booted.ctx;
        spineCtx = ctx;
        const wsoMod = await import('web-live/write-surface-options.js');
        demand(typeof wsoMod.writeSurfaceOptions === 'function',
          `wso=${typeof wsoMod.writeSurfaceOptions}`);
        webRuntime = createWebBootRuntime({
          ctx, post: () => {},
          write: wsoMod.writeSurfaceOptions(pending[0], ctx, cfg),
        });
        demand(typeof webRuntime?.deliver === 'function', 'webRuntime lacks deliver');
        for (const m of pending.splice(0)) webRuntime.deliver(m);
        if (!booted) {
          booted = true;
          main(spineCtx).catch((error) => fail(error));
        }
      } catch (error) { fail(error); }
    })();
    return;
  }
  webRuntime.deliver(msg);
};
