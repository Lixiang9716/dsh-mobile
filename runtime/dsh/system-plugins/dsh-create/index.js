// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-create — the creation seat's product face, CORDIS-NATIVE (the
 * owner's bar: 基于cordis插件模式、在线插入,不是自造插件系统):
 *
 *   1. SCHEMA — plugin_create's args are the creation schema; the model
 *      authors the plugin's SOURCE (indexSource — a real cordis plugin
 *      exporting name/inject/apply) or takes the generated template.
 *   2. WRITE — the package lands at plugins/<name>/ (workspace grammar).
 *   3. LIVE MOUNT — plugin-mount.js's mountWorkspacePlugin(ctx, name) is
 *      the WHOLE product pipeline: the native presentApproval checkpoint
 *      (挂载插件…), the dsh.plugins/1 registry row, the __dshModuleDefine
 *      loader-seam registration + dynamic import() (real code, loaded
 *      post-boot), and ctx.plugin(ns) — the plugin is inserted INTO THE
 *      RUNNING SPINE as a real cordis plugin. Every step is
 *      plugin.mount.* E2E evidence.
 *   4. THE PLUGIN RUNS — its own apply() executes on mount: it posts the
 *      card.* bus lines itself (its own JS computes the face — a calendar
 *      computes today's date, a timer runs its own 1Hz re-arm loop). The
 *      host CardPlayerSurface only RENDERS what the plugin's code sends —
 *      the running is the plugin's, not this tool's.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fsWrite } from 'gateway.js';
import { mountWorkspacePlugin } from 'plugin-mount.js';
import { workspacePrefix, joinScoped } from 'workspace-registry.js';
import 'upstream/shims/timers.js';

const log = createLogger('dsh.create');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-create',
  version: '0.2.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', 'presentApproval'], optional: [] },
  hooks: { activate: 'activate' },
};

const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** The spine context, captured at apply — the live mount needs the REAL
 * cordis context (ctx.plugin). */
let spine = null;

/** The UTF-8 face (the workspace-registry resolution — quickjs has no
 * TextEncoder global by default; this MUST resolve, not construct). */
let utf8Encode = null;
const encodeUtf8 = async (text) => {
  if (utf8Encode === null) {
    const bufFace = await import('node:buffer').catch(() => undefined);
    utf8Encode = typeof bufFace?.encodeUtf8 === 'function'
      ? bufFace.encodeUtf8
      : (t) => new TextEncoder().encode(t);
  }
  return utf8Encode(text);
};

/** The generated plugin — a REAL cordis plugin whose apply() IS the run:
 * a timer runs its own one-shot re-arm loop; a calendar computes today's
 * date in its own JS. The card face is the plugin's own bus posts. */
const generatedIndex = ({ id, title, kind, durationMs }) => `// Authored by the creation turn — a real cordis plugin, mounted LIVE.
import 'upstream/shims/timers.js';
import { createLogger } from 'logger.js';
const log = createLogger('plugin.${id}');
const post = (msg) => globalThis.__dshBusPost?.(JSON.stringify(msg));
const CARD = 'create-${id}';
export const name = '${id}';
export const inject = [];
export const apply = (ctx) => {
  log.info('e2e', { scenario: 'plugin.${id}', event: 'plugin.running', kind: '${kind}' });
  post({ type: 'card.present', card: {
    id: CARD, kind: '${kind}', title: '${title}',
    subtitle: '创作插件 · 已在线挂载', durationMs: ${durationMs} } });
  log.info('e2e', { scenario: 'plugin.${id}', event: 'card.posted', id: CARD });
${
  kind === 'timer'
    ? `  let remaining = ${durationMs};
  (async () => {
    while (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      remaining -= 1000;
      post({ type: 'card.state', id: CARD, state: {
        remainingMs: remaining, label: '剩 ' + Math.ceil(remaining / 1000) + ' 秒' } });
    }
    post({ type: 'card.complete', id: CARD, message: '${title} 完成' });
  })();`
    : `  const now = new Date();
  const label = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0');
  post({ type: 'card.state', id: CARD, state: { label } });`
}
};
`;

/** Write the package (step: package.written). Returns {name,title} or a
 * refusal string. */
const writePackage = async (args, dir) => {
  const name = String(args.name ?? '');
  if (!PKG_ID.test(name)) {
    return `plugin_create: name must match ${PKG_ID} (got ${JSON.stringify(name)})`;
  }
  const kind = args.kind === undefined ? 'timer' : String(args.kind);
  const title = args.title === undefined ? name : String(args.title);
  const durationMs = Math.max(0, Math.trunc(Number(args.durationMs ?? 0)));
  if (kind === 'timer' && !(durationMs > 0)) {
    return 'plugin_create: timer cards need a positive durationMs';
  }
  const indexSource = typeof args.indexSource === 'string' && args.indexSource.length > 0
    ? args.indexSource
    : generatedIndex({ id: name, title, kind, durationMs });
  const pluginManifest = {
    id: name, name: title, version: '1.0.0', entry: 'index.js',
    capabilities: [], kind,
  };
  await fsWrite('app', `${dir}/manifest.json`,
    await encodeUtf8(`${JSON.stringify(pluginManifest, null, 2)}\n`));
  await fsWrite('app', `${dir}/index.js`, await encodeUtf8(indexSource));
  log.info('e2e', { scenario: 'create.card', event: 'package.written', name });
  return { name, title };
};

/** Live-mount through the cordis seam: approval → registry → dynamic
 * import → ctx.plugin — the plugin's apply() runs as a result. */
const execute = async (args) => {
  const name = String(args.name ?? '');
  const dir = joinScoped(workspacePrefix(), `plugins/${name}`);
  const written = await writePackage(args, dir);
  if (typeof written === 'string') return written;
  if (!spine) return 'plugin_create: no cordis spine on this seat (mount impossible)';
  const outcome = await mountWorkspacePlugin(spine, written.name);
  if (!outcome.mounted) {
    return `plugin_create: 挂载未完成(${outcome.step}): ${outcome.reason ?? ''}`;
  }
  return `插件「${written.title}」已作为真实 cordis 插件在线插入:审批通过 → 注册表落库 → `
    + '动态加载 → ctx.plugin 挂载,插件自身代码已在运行(plugin.mount.* 事件链为证)。';
};

const pluginCreateTool = () => defineTool({
  name: 'plugin_create',
  description: 'Create and insert a cordis plugin LIVE (创作模式). Call this '
    + 'when the user asks to 生成/创建/做一个 plugin (e.g. 做一个日历): you may '
    + 'AUTHOR the plugin source yourself (indexSource — a cordis plugin '
    + 'exporting name/inject/apply; its apply() runs on mount and drives '
    + 'its card via __dshBusPost card.* lines), or take the generated '
    + 'template (kind "timer" = countdown; anything else e.g. "calendar" = '
    + 'a date-face card). The plugin is mounted into the RUNNING spine '
    + 'after the user approves the native dialog — real online insertion.',
  parameters: {
    name: { type: 'string', required: true,
      description: 'Package id, kebab-case (e.g. "calendar-plugin").' },
    title: { type: 'string', required: true,
      description: 'Display title (approval dialog + card).' },
    kind: { type: 'string',
      description: 'Card kind: "timer" (needs durationMs) or e.g. "calendar".' },
    durationMs: { type: 'number',
      description: 'Timer duration in ms (1500000 = 25 min); omit for calendar.' },
    indexSource: { type: 'string',
      description: 'YOUR authored cordis plugin source (exports name/inject/apply) — preferred over the template.' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute,
});

export function activate() {
  log.debug('dsh-create activated', {});
}

/** The E2E drive's entry (scenario/create-card.js): the same execute. */
export const pluginCreateExecute = execute;

export const name = 'dsh-create';
export const inject = ['tools'];

export const apply = (ctx) => {
  spine = ctx;
  ctx.tools.register(pluginCreateTool());
  log.debug('plugin_create registered (spine captured)', {});
};
