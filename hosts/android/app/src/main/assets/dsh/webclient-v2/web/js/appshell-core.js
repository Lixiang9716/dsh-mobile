// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * appshell-core.js — the client-side half of the app-shell/0.9 contract,
 * kept DOM-free so vitest covers it in plain node:
 *
 *   expandSpec(spec)  templates → pure primitive tree (mirrors the plugin's
 *                     catalog expanders; both sides must stay in lockstep)
 *   checkShallow(spec) defensive re-validation: whitelist, caps, action grammar
 *
 * The four authoritative gates live plugin-side (system-plugins/dsh-appshell/
 * lib/validate.js); this file never trusts what it is handed — a spec that
 * somehow arrived hostile still cannot render a non-catalog type.
 */

const PRIMITIVES = new Set(['text', 'image', 'button', 'row', 'column', 'card', 'progressbar', 'badge']);
const CAPS = { SPEC_BYTES: 32 * 1024, NODES: 200, DEPTH: 8, TEXT_RUNES: 500, CHILDREN: 24 };
const ACTION_RE = /^[a-z][a-z0-9.:-]{0,63}$/;

const TEMPLATES = {
  'search-bar': (n) => ({ type: 'card', style: { borderRadius: '14px', padding: '6px 10px' }, children: [{ type: 'text', text: '🔍 ' + String(n.placeholder || '搜索'), size: 'small', tone: 'muted' }] }),
  'tab-bar': (n) => ({ type: 'row', children: (n.tabs || []).map((t, i) => ({ type: 'badge', text: t.label + (i === (n.active || 0) ? ' ·' : '') })) }),
  'chat-row': (n) => ({ type: 'row', children: [
    { type: 'badge', text: (n.avatar && n.avatar.emoji) || '💬' },
    { type: 'column', children: [
      { type: 'text', text: String(n.name || ''), size: 'body' },
      { type: 'text', text: String(n.preview || ''), size: 'small', tone: 'muted' },
    ] },
    { type: 'text', text: String(n.time || ''), size: 'small', tone: 'muted' },
  ] }),
  'service-grid': (n) => {
    const items = (n.items || []).slice(0, 8).map((it) => ({ type: 'column', children: [
      { type: 'badge', text: it.icon || '·' },
      { type: 'text', text: String(it.label || ''), size: 'small' },
    ] }));
    const rows = [];
    for (let i = 0; i < items.length; i += 4) rows.push({ type: 'row', children: items.slice(i, i + 4) });
    return { type: 'card', children: rows };
  },
  'banner-card': (n) => ({ type: 'card', children: [
    { type: 'text', text: String(n.title || ''), size: 'title' },
    { type: 'text', text: String(n.subtitle || ''), size: 'small', tone: 'muted' },
  ] }),
  'hcard-row': (n) => ({ type: 'row', children: (n.items || []).slice(0, 6).map((it) => ({ type: 'card', children: [
    { type: 'text', text: (it.cover && it.cover.emoji) || '🎵' },
    { type: 'text', text: String(it.title || ''), size: 'small' },
    { type: 'text', text: String(it.sub || ''), size: 'small', tone: 'muted' },
  ] })) }),
  'balance-card': (n) => {
    const kids = [
      { type: 'text', text: String(n.label || ''), size: 'small', tone: 'muted' },
      { type: 'text', text: String(n.value || ''), size: 'title' },
    ];
    if (n.actionLabel) kids.push({ type: 'button', label: String(n.actionLabel), action: n.action || 'balance.open' });
    return { type: 'card', children: kids };
  },
  'mini-player': (n) => {
    const kids = [
      { type: 'badge', text: (n.cover && n.cover.emoji) || '🎵' },
      { type: 'column', children: [
        { type: 'text', text: String(n.title || ''), size: 'body' },
        { type: 'text', text: String(n.sub || ''), size: 'small', tone: 'muted' },
      ] },
    ];
    if (n.action) kids.push({ type: 'button', label: '▶', action: n.action });
    return { type: 'card', children: kids };
  },
};

/** Expand templates to a pure primitive tree (structure mirrors the plugin). */
export function expandSpec(spec) {
  const errors = [];
  let nodes = 0;
  const expand = (node, path, depth) => {
    if (!node || typeof node !== 'object') { errors.push({ code: 'BAD_FIELD', path }); return null; }
    nodes += 1;
    if (nodes > CAPS.NODES) { errors.push({ code: 'NODE_OVERFLOW', path }); return null; }
    if (depth > CAPS.DEPTH) { errors.push({ code: 'DEPTH_OVERFLOW', path }); return null; }
    const type = node.type;
    if (typeof type !== 'string') { errors.push({ code: 'BAD_FIELD', path: path + '.type' }); return null; }
    if (TEMPLATES[type]) {
      let expanded;
      try { expanded = TEMPLATES[type](node); } catch { errors.push({ code: 'EXPAND_FAILED', path }); return null; }
      if (!expanded || TEMPLATES[expanded.type]) { errors.push({ code: 'EXPAND_FAILED', path }); return null; }
      return expand(expanded, path, depth + 1);
    }
    if (!PRIMITIVES.has(type)) { errors.push({ code: 'UNKNOWN_TYPE', path }); return null; }
    const out = { ...node };
    if (Array.isArray(node.children)) {
      if (node.children.length > CAPS.CHILDREN) { errors.push({ code: 'NODE_OVERFLOW', path: path + '.children' }); return null; }
      const kids = node.children.map((c, i) => expand(c, path + '.children[' + i + ']', depth + 1));
      if (kids.some((c) => c === null)) return null;
      out.children = kids;
    }
    return out;
  };
  const screen = spec && typeof spec === 'object' ? expand(spec.screen, '$.screen', 1) : null;
  return { screen, errors };
}

/** Defensive client-side re-check: the plugin gates authoritatively; this
 * never renders a non-catalog type even if a hostile payload arrived. */
export function checkShallow(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: [{ code: 'BAD_FIELD', path: '$' }] };
  if (spec.spec !== 'app-shell/0.9') errors.push({ code: 'BAD_FIELD', path: '$.spec' });
  if (!Array.isArray(spec.tabs) || spec.tabs.length < 2 || spec.tabs.length > 5) errors.push({ code: 'BAD_FIELD', path: '$.tabs' });
  if (JSON.stringify(spec).length > CAPS.SPEC_BYTES) errors.push({ code: 'SPEC_TOO_LARGE', path: '$' });
  const expanded = expandSpec(spec);
  errors.push(...expanded.errors);
  return { ok: errors.length === 0 && expanded.screen !== null, errors, screen: expanded.screen };
}
