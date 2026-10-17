// appshell-core tests: two-layer expansion, defensive re-check, and the
// security posture (markup inert by construction) — plain node, no DOM.
import { describe, it, expect } from 'vitest';
import { expandSpec, checkShallow } from '../../../presentation/web-client-v2/web/js/appshell-core.js';

const V = 'app-shell/0.9';
const base = (screen, tabs) => ({
  spec: V, theme: { accent: '#1677FF', mode: 'light' },
  tabs: tabs || ['一', '二'], actions: ['demo.tap'], screen,
});

describe('expandSpec — the eight templates expand to pure primitives', () => {
  const TEMPLATES = [
    ['search-bar', { placeholder: '搜索' }],
    ['tab-bar', { tabs: [{ label: '一' }, { label: '二' }], active: 0 }],
    ['chat-row', { avatar: { emoji: '张', color: '#123' }, name: '张伟', preview: '在吗', time: '9:41' }],
    ['service-grid', { items: [{ icon: '📷', label: '扫' }, { icon: '💳', label: '付' }, { icon: '🚌', label: '行' }, { icon: '⚡', label: '充' }] }],
    ['banner-card', { title: '横幅', subtitle: '副标' }],
    ['hcard-row', { items: [{ cover: { emoji: '🌙', color: '#123' }, title: '卡', sub: 's' }] }],
    ['balance-card', { label: '余额', value: '8,482.10', actionLabel: '转入', action: 'demo.tap' }],
    ['mini-player', { cover: { emoji: '🎧', color: '#333' }, title: '歌', sub: '播放中', action: 'demo.tap' }],
  ];
  for (const [name, fields] of TEMPLATES) {
    it('expands ' + name + ' with zero template types remaining', () => {
      const r = expandSpec(base({ type: name, ...fields }));
      expect(r.errors).toEqual([]);
      const types = [];
      (function walk(n) { types.push(n.type); for (const c of n.children || []) walk(c); })(r.screen);
      for (const t of types) expect(TEMPLATES.some(([tn]) => tn === t)).toBe(false);
      expect(types.length).toBeGreaterThan(0);
    });
  }
});

describe('checkShallow — the defensive client gate', () => {
  it('accepts a well-formed spec', () => {
    const r = checkShallow(base({ type: 'text', text: 'hi' }));
    expect(r.ok).toBe(true);
    expect(r.screen.type).toBe('text');
  });
  it('rejects a non-catalog type', () => {
    const r = checkShallow(base({ type: 'iframe', src: '//evil' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'UNKNOWN_TYPE')).toBe(true);
  });
  it('rejects a wrong spec version', () => {
    const r = checkShallow({ ...base({ type: 'text', text: 'x' }), spec: 'app-shell/1.0' });
    expect(r.ok).toBe(false);
  });
  it('rejects a spec over the byte cap', () => {
    const r = checkShallow(base({ type: 'text', text: 'x'.repeat(40000) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'SPEC_TOO_LARGE')).toBe(true);
  });
  it('rejects unknown tabs shape', () => {
    const r = checkShallow({ ...base({ type: 'text', text: 'x' }), tabs: '首页' });
    expect(r.ok).toBe(false);
  });
  it('rejects garbage input without throwing', () => {
    expect(checkShallow(null).ok).toBe(false);
    expect(checkShallow('string').ok).toBe(false);
  });
});

describe('M4 red-team — hostile text survives verbatim in the expanded tree', () => {
  const HOSTILE = [
    ['script tag', '<script>alert(1)</script>'],
    ['event handler', '<img src=x onerror=alert(1)>'],
    ['quote break', '点我" onclick="alert(1)'],
    ['template literal', '${process.exit()}'],
  ];
  for (const [name, payload] of HOSTILE) {
    it('preserves ' + name + ' as inert text', () => {
      const r = expandSpec(base({ type: 'text', text: payload }));
      expect(r.errors).toEqual([]);
      const texts = [];
      (function walk(n) { if (n.text !== undefined) texts.push(n.text); for (const c of n.children || []) walk(c); })(r.screen);
      expect(texts).toContain(payload);
    });
  }

  it('the DOM layer never assigns innerHTML (structural injection guard)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../presentation/web-client-v2/web/js/appshell.js', import.meta.url),
      'utf8');
    expect(source.includes('innerHTML')).toBe(false);
    expect(source.includes('document.write')).toBe(false);
  });
});
