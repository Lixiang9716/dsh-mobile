// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * skin-stub.js — the minimal RenderSurfaceClient: a plain-text
 * transcription of the fold state. Same interface as the lynx skin, zero
 * engine needed — it exists so the driver's full loop (seed → stream →
 * tool cards → cancel → intents) is exercisable and assertable anywhere
 * Node runs, and so the fold's rendering contract has a second consumer.
 *
 * Transcription markers (stable, the mock loop asserts on them):
 *   『DSH』wordmark, [你]/[DSH] bubbles, ⚙ tool rows with 等待结果/准备中/
 *   完成/失败 chips + OUT blocks, ◆ 思考 rows, 🎨 creation cards, · status
 *   rows, ▍streaming cursor, 已停止.
 */

import { createFold, snapshotState } from '../shared/fold.js';
import { assertViewEvent, assertIntent } from '../shared/view-events.js';
import { defineRenderSurfaceClient } from './render-surface-client.js';

const shortId = (sessionId) => String(sessionId).slice(0, 8);

const relativeTime = (updatedAt) => {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const seconds = Date.now() / 1000 - updatedAt;
  if (seconds > 5 * 365 * 86400) return ''; // fixture/dev epochs are not wall-clock
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
};

const CONNECTION_LABEL = {
  open: ['●', '已连接'],
  connecting: ['◐', '连接中'],
  closed: ['○', '已断开'],
};

const PHASE_LABEL = {
  streaming: '准备中',
  waiting: '等待结果',
  ok: '完成',
  fail: '失败',
};

const toolGlyph = (name) => {
  if (/^(write|edit|apply)/.test(name)) return '✎';
  if (/^(bash|shell|ish|wasm)/.test(name)) return '❯';
  if (/^(read|list|glob|grep)/.test(name)) return '☰';
  return '⚙';
};

/** One tool card in one of its three states: running (等待结果/准备中),
 * in-card streaming args, collapsed result (chip + OUT). */
const renderTool = (item, lines) => {
  const chip = PHASE_LABEL[item.status] ?? item.status;
  lines.push(`  ${toolGlyph(item.name)} ${item.name} · ${chip}`);
  if (item.args !== '') lines.push(`     args: ${item.args}`);
  if (item.output !== '') {
    const text = item.output.length > 300
      ? `${item.output.slice(0, 300)}…（已截断）` : item.output;
    lines.push(`     OUT: ${text.replaceAll('\n', ' ⏎ ')}`);
  }
};

const renderItems = (state, lines) => {
  for (const item of state.items) {
    if (item.kind === 'user') lines.push(`  [你] ${item.text}`);
    else if (item.kind === 'assistant') {
      lines.push(`  [DSH] ◆ ${item.interrupted ? '(已中断) ' : ''}${item.markdown}`);
    } else if (item.kind === 'reasoning') {
      lines.push(`  ◆ 思考: ${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}`);
    } else if (item.kind === 'tool') renderTool(item, lines);
    else if (item.kind === 'status') lines.push(`  · ${item.text}`);
    else if (item.kind === 'creation') {
      for (const file of item.files) {
        lines.push(`  🎨 ${file.description || file.path} (${file.path}) [查看]`);
      }
    } else if (item.kind === 'notice') lines.push(`  [${item.label}] ${item.text}`);
    else if (item.kind === 'system') lines.push(`  [${item.label}] ${item.types.join(', ')}`);
  }
};

const renderTail = (tail, lines) => {
  if (tail === null) return;
  lines.push(`  [DSH] ◆ ${tail.streaming ? '生成中…' : '正在思考…'}▍`);
  if (tail.reasoning !== '') {
    lines.push(`  ◆ 思考: ${tail.reasoning.slice(0, 80)}${tail.reasoning.length > 80 ? '…' : ''}`);
  }
  if (tail.text !== '') lines.push(`  ${tail.text.slice(-160)}▍`);
  for (const tool of tail.tools) {
    lines.push(`  ${toolGlyph(tool.name || 'tool')} ${tool.name || 'tool'} · 准备中`);
  }
};

const renderDrawer = (state, lines) => {
  lines.push('── 会话抽屉 ──────────────────────────');
  if (state.sessions.length === 0) {
    lines.push('  （还没有会话 — 从下面开始）');
  }
  for (const session of state.sessions) {
    const title = session.blank ? '新会话' : `会话 ${shortId(session.sessionId)}`;
    const dot = session.running ? '●' : '·';
    const time = relativeTime(session.updatedAt);
    lines.push(`  ${dot} ${title} · ${shortId(session.sessionId)}${time === '' ? '' : ` · ${time}`}`);
  }
  lines.push('  [＋ 新建会话]');
};

/** The whole surface, transcribed. */
export const renderTranscript = (state) => {
  const lines = [];
  const [dot, label] = CONNECTION_LABEL[state.connection] ?? CONNECTION_LABEL.connecting;
  lines.push(`┌─ 『DSH』 ${dot} ${label} ─────────────`);
  renderDrawer(state, lines);
  lines.push('── 会话线 ────────────────────────────');
  renderItems(state, lines);
  renderTail(state.tail, lines);
  if (!state.seedComplete && state.items.length > 0) {
    lines.push('  …seed 回放中');
  }
  lines.push('── 输入条 ────────────────────────────');
  lines.push(`  [ ${state.running ? '■ 停止' : '↑ 发送'} ]  描述你想要构建的内容`);
  return lines.join('\n');
};

/** The stub skin factory. `stream` defaults to stdout; pass null to keep
 * the transcription in-memory only (the mock loop asserts on .transcript). */
export const createStubSkin = ({ stream = process.stdout } = {}) => {
  const fold = createFold();
  let intentHandler = null;

  const render = () => {
    const text = renderTranscript(snapshotState(fold.state));
    if (stream !== null) stream.write(`${text}\n`);
    return text;
  };

  return defineRenderSurfaceClient({
    async mount() {
      render();
    },
    pushViewEvent(event) {
      assertViewEvent(event);
      fold.apply(event);
      render();
    },
    onIntent(handler) {
      intentHandler = handler;
    },
    async teardown() {
      if (stream !== null) stream.write('└─ stub 皮肤已卸载\n');
    },
    /** Test affordance: a "tap" — validates and crosses the seam exactly
     * like a real skin's user gesture would. */
    tap(intent) {
      if (intentHandler === null) {
        throw new Error('fail loud: no intent handler installed (driver not mounted)');
      }
      intentHandler(assertIntent(intent));
    },
    /** The current transcription (in-memory, regardless of `stream`). */
    get transcript() {
      return renderTranscript(snapshotState(fold.state));
    },
    get face() {
      return 'stub';
    },
  });
};
