// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * render-chat.js — the transcript DOM. Structure bumps re-render the item
 * list (markdown parse cache makes this cheap; the list is trimmed to a
 * bounded window); tail bumps only touch the streaming tail's own nodes —
 * the clarklevis dedicated-streaming-row pattern, so token bursts never
 * reconcile the list. Scroll is pinned-to-bottom with a drag-aware pause
 * and a jump-to-latest button. Copy affordances live only on user
 * messages and final assistant answers, morphing to a checkmark for
 * COPY_FEEDBACK_MS.
 */

import { renderMarkdown } from './markdown.js';

const DOM_WINDOW = 400;
const OUTPUT_CAP_CHARS = 1500;
const COPY_FEEDBACK_MS = 1400;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const isProcess = (item) => item.kind === 'reasoning' || item.kind === 'tool';

/** One copy affordance: writes text, morphs to ✓ for a beat. */
const addCopyButton = (parent, text) => {
  const button = el('button', 'copy-btn');
  button.type = 'button';
  button.textContent = '复制';
  button.addEventListener('click', () => {
    navigator.clipboard?.writeText(text);
    button.textContent = '✓';
    setTimeout(() => { button.textContent = '复制'; }, COPY_FEEDBACK_MS);
  });
  parent.appendChild(button);
};

const renderReasonRow = (item) => {
  const row = el('div', 'reason-row');
  const head = el('div', 'reason-head');
  head.textContent = '思考';
  const body = el('div', 'reason-text');
  body.hidden = true;
  body.textContent = item.text;
  head.addEventListener('click', () => { body.hidden = !body.hidden; });
  row.appendChild(head);
  row.appendChild(body);
  return row;
};

const toolGlyph = (name) => {
  if (/^(write|edit|apply)/.test(name)) return '✎';
  if (/^(bash|shell|ish|wasm)/.test(name)) return '❯';
  if (/^(read|list|glob|grep)/.test(name)) return '☰';
  return '⚙';
};

const renderToolRow = (item) => {
  const row = el('div', 'tool-row');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', undefined, toolGlyph(item.name)));
  head.appendChild(el('span', 'tool-name', item.name));
  if (item.status === 'waiting') head.appendChild(el('span', 'tool-chip chip-wait', '等待结果'));
  if (item.status === 'fail') head.appendChild(el('span', 'tool-chip chip-fail', '失败'));
  if (item.status === 'ok') head.appendChild(el('span', 'tool-chip chip-done', '完成'));
  row.appendChild(head);
  if (item.args !== '') {
    let argsText = item.args;
    try { argsText = JSON.stringify(JSON.parse(item.args), null, 2); } catch { /* raw */ }
    row.appendChild(el('div', 'tool-args', argsText));
  }
  if (item.output !== '') {
    const output = el('div', 'tool-output' + (item.status === 'fail' ? ' is-error' : ''));
    output.appendChild(el('span', 'tool-output-label', 'OUT'));
    let text = item.output;
    if (text.length > OUTPUT_CAP_CHARS) text = `${text.slice(0, OUTPUT_CAP_CHARS)}\n…（已截断）`;
    output.appendChild(el('span', undefined, text));
    row.appendChild(output);
  }
  return row;
};

/** One collapsible process group over a consecutive run of reasoning/tool
 * rows. The header never changes height; bodies insert on expand. */
const renderGroup = (run) => {
  const group = el('div', 'group');
  const header = el('button', 'group-header');
  header.type = 'button';
  const tools = run.filter((item) => item.kind === 'tool');
  const preview = tools.length > 0
    ? `使用了 ${tools.map((tool) => tool.name).slice(0, 3).join('、')}${tools.length > 3 ? ' 等' : ''} 工具`
    : '思考过程';
  header.appendChild(el('span', undefined, '⚙'));
  header.appendChild(el('span', 'group-preview', `${preview} · ${run.length}`));
  header.appendChild(el('span', 'group-chevron', '▶'));
  const body = el('div', 'group-body');
  for (const item of run) {
    body.appendChild(item.kind === 'reasoning' ? renderReasonRow(item) : renderToolRow(item));
  }
  header.addEventListener('click', () => group.classList.toggle('open'));
  group.appendChild(header);
  group.appendChild(body);
  return group;
};

const renderUserItem = (item) => {
  const wrap = el('div', 'item item-user');
  const bubble = el('div', 'user-bubble', item.text);
  wrap.appendChild(bubble);
  if (item.text !== '') addCopyButton(wrap, item.text);
  return wrap;
};

const renderAssistantItem = (item) => {
  const wrap = el('div', 'item item-assistant');
  const header = el('div', 'assistant-header');
  header.appendChild(el('span', 'assistant-avatar', '◆'));
  header.appendChild(el('span', 'assistant-name', 'DSH'));
  if (item.interrupted) header.appendChild(el('span', 'item-interrupted', '已中断'));
  wrap.appendChild(header);
  wrap.appendChild(renderMarkdown(item.markdown));
  addCopyButton(wrap, item.markdown);
  return wrap;
};

const renderCreation = (item) => {
  const wrap = el('div', 'item item-creation');
  for (const file of item.files) {
    const row = el('button', 'creation-card');
    row.type = 'button';
    row.appendChild(el('span', 'creation-glyph', '🎨'));
    const main = el('span', 'creation-main');
    main.appendChild(el('span', 'creation-title',
      file.description || file.path));
    main.appendChild(el('span', 'creation-path', file.path));
    row.appendChild(main);
    row.appendChild(el('span', 'creation-open', '查看'));
    row.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('dsh-open-creation',
        { detail: { path: file.path, title: file.description || file.path } }));
    });
    wrap.appendChild(row);
  }
  return wrap;
};

const renderSimple = (item) => {
  if (item.kind === 'notice') {
    const wrap = el('div', 'item item-notice');
    wrap.appendChild(el('span', 'item-notice-label', item.label));
    wrap.appendChild(el('span', undefined, item.text));
    return wrap;
  }
  if (item.kind === 'status') {
    return el('div', 'item item-status', `· ${item.text}`);
  }
  const wrap = el('div', 'item item-notice');
  wrap.appendChild(el('span', 'item-notice-label', item.label ?? 'system'));
  wrap.appendChild(el('span', undefined, item.types?.join(', ') ?? ''));
  return wrap;
};

const renderItem = (item) => {
  if (item.kind === 'user') return renderUserItem(item);
  if (item.kind === 'assistant') return renderAssistantItem(item);
  if (item.kind === 'creation') return renderCreation(item);
  return renderSimple(item);
};

const consecutiveProcessRun = (items, start) => {
  let end = start;
  while (end < items.length && isProcess(items[end])
    && items[end].turn === items[start].turn) end += 1;
  return end;
};

const buildTailNode = (tail) => {
  const wrap = el('div', 'item item-assistant');
  const header = el('div', 'tail-header');
  header.appendChild(el('span', 'assistant-avatar', '◆'));
  header.appendChild(el('span', 'tail-state', tail.streaming ? '生成中…' : '正在思考…'));
  wrap.appendChild(header);
  if (tail.reasoning !== '') wrap.appendChild(el('div', 'tail-reason', tail.reasoning));
  if (tail.text !== '') {
    wrap.appendChild(el('div', 'tail-text', tail.text));
    wrap.appendChild(el('span', 'cursor-blink', '▍'));
  }
  if (tail.tools.size > 0) wrap.appendChild(buildTailTools(tail));
  return wrap;
};

const buildTailTools = (tail) => {
  const tools = el('div', 'tail-tools');
  for (const tool of tail.tools.values()) {
    const head = el('div', 'tool-head');
    head.appendChild(el('span', undefined, toolGlyph(tool.name)));
    head.appendChild(el('span', 'tool-name', tool.name || 'tool'));
    head.appendChild(el('span', 'tool-chip chip-wait', '准备中'));
    tools.appendChild(head);
  }
  return tools;
};

const buildItems = (items) => {
  const fragment = document.createDocumentFragment();
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (isProcess(item)) {
      const end = consecutiveProcessRun(items, index);
      fragment.appendChild(renderGroup(items.slice(index, end)));
      index = end;
    } else {
      fragment.appendChild(renderItem(item));
      index += 1;
    }
  }
  return fragment;
};

export function createChatRenderer(transcript, jumpButton) {
  const itemsHost = el('div');
  const tailHost = el('div');
  transcript.appendChild(itemsHost);
  transcript.appendChild(tailHost);
  let pinned = true;
  let tailNodes = null;

  const nearBottom = () =>
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 28;

  transcript.addEventListener('scroll', () => {
    pinned = nearBottom();
    jumpButton.hidden = pinned;
  });
  jumpButton.addEventListener('click', () => {
    pinned = true;
    jumpButton.hidden = true;
    transcript.scrollTop = transcript.scrollHeight;
  });

  const keepPinned = (force) => {
    if (pinned || force === true) transcript.scrollTop = transcript.scrollHeight;
  };

  const renderTailInto = (host, tail) => {
    host.replaceChildren();
    tailNodes = null;
    if (tail !== null) {
      host.appendChild(buildTailNode(tail));
      tailNodes = tail;
    }
  };


  const renderStructure = (timeline) => {
    const first = Math.max(0, timeline.items.length - DOM_WINDOW);
    itemsHost.replaceChildren(buildItems(timeline.items.slice(first)));
    renderTailInto(tailHost, timeline.tail);
    keepPinned();
  };

  /** Tail-only update: rebuild the small tail subtree, never the list. */
  const renderTail = (timeline) => {
    renderTailInto(tailHost, timeline.tail);
    keepPinned();
  };

  return { renderStructure, renderTail };
}
