// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * appshell.js — the DOM half of the app-shell seam: fullscreen presented
 * surface (the creation-viewer posture, minus the sandbox — the catalog
 * renders declarative primitives with textContent, never markup), plus the
 * timeline preview card renderer. Actions flow back as tagged user turns;
 * tab-like local state never leaves the page.
 */

import { checkShallow } from './appshell-core.js';

let activeActionHandler = null;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Primitive renderers: (node, ctx) → DOM element. Text only ever rides
 * textContent — markup in model-authored strings is structurally inert. */
const PRIMITIVE_RENDER = {
  text: (n) => el('div', 'ash-text ash-' + (n.size || 'body') + (n.tone ? ' ash-' + n.tone : ''), String(n.text ?? '')),
  image: (n) => el('div', 'ash-image', String(n.emoji || '🖼')),
  button: (n, ctx) => {
    const btn = el('button', 'ash-btn', String(n.label ?? ''));
    btn.type = 'button';
    btn.style.background = ctx.accent;
    btn.addEventListener('click', () => { if (ctx.onAction) ctx.onAction(n.action, n.label); });
    return btn;
  },
  row: (n, ctx) => { const d = el('div', 'ash-row'); for (const c of n.children || []) d.appendChild(renderPrimitive(c, ctx)); return d; },
  column: (n, ctx) => { const d = el('div', 'ash-col'); for (const c of n.children || []) d.appendChild(renderPrimitive(c, ctx)); return d; },
  card: (n, ctx) => { const d = el('div', 'ash-card'); for (const c of n.children || []) d.appendChild(renderPrimitive(c, ctx)); return d; },
  progressbar: (n) => {
    const track = el('div', 'ash-progress-track');
    const bar = el('div', 'ash-progress-bar', String(n.label ?? ''));
    bar.style.width = Math.max(0, Math.min(100, Number(n.value) || 0)) + '%';
    track.appendChild(bar);
    return track;
  },
  badge: (n) => el('span', 'ash-badge', String(n.text ?? '')),
};

function renderPrimitive(node, ctx) {
  const fn = PRIMITIVE_RENDER[node.type];
  if (!fn) return el('div', 'ash-text', '（目录外组件已拦截）');
  return fn(node, ctx);
}

/** Small inline preview for the timeline tool card. */
export function renderPreview(spec) {
  const host = el('div', 'appshell-preview');
  const check = checkShallow(spec);
  if (!check.ok) {
    host.appendChild(el('div', 'ash-text', 'spec 未通过客户端校验（' + (check.errors[0]?.code || 'unknown') + '）'));
    return host;
  }
  const ctx = { accent: (spec.theme && spec.theme.accent) || '#1677ff', onAction: null };
  for (const c of check.screen.children || []) host.appendChild(renderPrimitive(c, ctx));
  return host;
}

/** Open (or replace) the fullscreen presented surface. The theme accent is
 * injected as a CSS variable on the surface — every primitive reads it. */
export function openSurface({ title, spec, onAction }) {
  const view = document.getElementById('appshell-view');
  if (!view) return false;
  activeActionHandler = onAction || null;
  view.style.setProperty('--p-accent', (spec.theme && spec.theme.accent) || '#1677ff');
  const root = document.getElementById('appshell-root');
  root.replaceChildren();
  document.getElementById('appshell-title-text').textContent = title || 'App';
  const check = checkShallow(spec);
  if (!check.ok) {
    root.appendChild(el('div', 'ash-text', 'spec 未通过客户端校验：' + check.errors.map((e) => e.code).join('、')));
  } else {
    const ctx = { accent: (spec.theme && spec.theme.accent) || '#1677ff', onAction: activeActionHandler };
    const tabs = el('div', 'ash-tabbar');
    for (const [i, t] of (spec.tabs || []).entries()) {
      const tab = el('span', 'ash-tab' + (i === 0 ? ' active' : ''), t);
      // Local-only interaction: tab state never leaves the page (no turn).
      tab.addEventListener('click', () => {
        for (const other of tabs.children) other.classList.remove('active');
        tab.classList.add('active');
      });
      tabs.appendChild(tab);
    }
    root.appendChild(tabs);
    for (const c of check.screen.children || []) root.appendChild(renderPrimitive(c, ctx));
  }
  view.hidden = false;
  return true;
}

export function closeSurface() {
  const view = document.getElementById('appshell-view');
  if (view) view.hidden = true;
  activeActionHandler = null;
}

/** Wire the static chrome (close button). Call once from main.js. */
export function setupAppshell() {
  const close = document.getElementById('appshell-close');
  close?.addEventListener('click', closeSurface);
}
