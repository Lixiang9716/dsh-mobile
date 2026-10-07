// dsh:logging-exempt (transport route: the served HTML IS the product face)
/**
 * CardPlayer — the generic card surface for WORKSPACE plugins created by the
 * CREATE-mode loop: one exact route serves the player page (a declarative
 * renderer for `card.json` + a CommonJS runner for `plugin.js`), one prefix
 * route serves the workspace files themselves from the app's dsh-fs root
 * (path-escape reject). The player fetches the card description, executes
 * the plugin module in-page, binds the declared state live (countdown,
 * phase) and wires the declared buttons to the plugin's actions — the
 * created clock renders and RUNS in the browser, no native code involved.
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { socket } from '@kit.NetworkKit';
import { CarrierRequest, CarrierServer, contentTypeOf } from './CarrierServer';

const TAG: string = 'dsh.cardplayer';

const PLAYER_HTML: string = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 卡片</title><style>
body{font-family:sans-serif;background:#f5f6f8;margin:0;padding:24px}
#card{background:#fff;border-radius:16px;padding:24px;max-width:420px;margin:0 auto;
box-shadow:0 2px 12px rgba(0,0,0,.08)}
.hidden{display:none}
</style></head><body><div id="card">加载中…</div>
<script>
const qs = new URLSearchParams(location.search);
const pluginRel = qs.get('plugin') || 'pomodoro-clock';
const base = '/workspace/real-create/';
async function fetchJson(rel) {
  const r = await fetch(base + rel);
  if (!r.ok) throw new Error(rel + ': ' + r.status);
  return r.json();
}
async function fetchText(rel) {
  const r = await fetch(base + rel);
  if (!r.ok) throw new Error(rel + ': ' + r.status);
  return r.text();
}
function styleApply(el, style) {
  for (const k of Object.keys(style || {})) {
    const css = k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    el.style.setProperty(css, String(style[k]));
  }
}
function mmss(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function render(node, card, bindings) {
  if (Array.isArray(node.children)) {
    for (const child of node.children) render(child, card, bindings);
    if (node.direction === 'row') node.el.style.display = 'flex';
    return;
  }
  const el = document.createElement(node.type === 'row' ? 'div' : node.type || 'div');
  if (node.type === 'text') el.textContent = node.placeholder ?? node.text ?? '';
  if (node.label) el.textContent = node.label;
  if (node.id) el.dataset.id = node.id;
  styleApply(el, node.style);
  if (node.binding && bindings[node.binding]) {
    const b = bindings[node.binding];
    if (b.format === 'mm:ss') el.dataset.mmss = b.source;
    else el.dataset.bind = b.source;
    if (b.source === 'running') el.dataset.bindRunning = '1';
  }
  if (node.labelMap) el.dataset.labelMap = JSON.stringify(node.labelMap);
  if (node.action?.call) el.addEventListener('click', () => {
    const call = node.action.call;
    if (call === 'plugin.start') window.__plugin.start();
    if (call === 'plugin.reset') window.__plugin.reset();
  });
  if (node.type === 'button') {
    el.style.border = 'none'; el.style.cursor = 'pointer';
    el.style.fontSize = '16px';
    el.addEventListener('click', () => renderBindings());
  }
  node.el = el;
  (node.parent ?? document.getElementById('card')).appendChild(el);
}
function renderBindings() {
  const p = window.__plugin;
  document.querySelectorAll('[data-mmss]').forEach((el) => {
    el.textContent = mmss(p[el.dataset.mmss]);
  });
  document.querySelectorAll('[data-bind]').forEach((el) => {
    el.textContent = String(p[el.dataset.bind]);
  });
  document.querySelectorAll('[data-bind-running]').forEach((el) => {
    const map = el.dataset.labelMap ? JSON.parse(el.dataset.labelMap) : {};
    el.textContent = p.running ? (map.running ?? '暂停') : (el.dataset.label ?? '');
  });
  document.querySelectorAll('[data-id="phase-label"]').forEach((el) => {
    const map = el.dataset.labelMap ? JSON.parse(el.dataset.labelMap) : {};
    el.textContent = map[p.phase] ?? p.phase;
  });
}
(async () => {
  const card = await fetchJson(pluginRel + '/card.json');
  const src = await fetchText(pluginRel + '/plugin.js');
  const module = { exports: {} };
  new Function('module', 'exports', src)(module, module.exports);
  window.__plugin = module.exports;
  const bindings = card.state || {};
  document.getElementById('card').textContent = '';
  render({ type: 'div', children: card.layout.children, parent: null }
    , card, bindings);
  renderBindings();
  setInterval(renderBindings, 250);
})().catch((e) => {
  document.getElementById('card').textContent = '加载失败: ' + (e.message ?? e);
});
</script></body></html>`;

/** Serves the player page and the workspace files it renders from. The
 * workspace root is the app's dsh-fs dir (the fs primitive's own root —
 * the same bytes the runtime's fs primitive served the creation turn). */
export class CardPlayerRoute {
  private server: CarrierServer;
  private workspaceRoot: string;

  constructor(server: CarrierServer, workspaceRoot: string) {
    this.server = server;
    this.workspaceRoot = workspaceRoot;
  }

  register(): void {
    this.server.register('exact', '/card-player',
      (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
        this.server.respond(conn, 200, 'text/html; charset=utf-8',
          toBuffer(PLAYER_HTML), {}, false);
      });
    this.server.register('prefix', '/workspace/',
      (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
        this.serveWorkspace(conn, req.rawPath);
      });
  }

  /** GET /workspace/<plugin-relative path> — from the app's dsh-fs root,
   * path-escape reject, content type by extension. */
  private serveWorkspace(conn: socket.TCPSocketConnection, rawPath: string): void {
    const rel = rawPath.substring('/workspace/'.length);
    if (rel.indexOf('..') >= 0 || rel.length === 0) {
      this.server.respondText(conn, 404, 'text/plain', 'invalid path');
      return;
    }
    const full = this.workspaceRoot + '/' + rel;
    let body: ArrayBuffer;
    try {
      const stat = fs.statSync(full);
      const file = fs.openSync(full, fs.OpenMode.READ_ONLY);
      body = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, body);
      fs.closeSync(file.fd);
    } catch (e) {
      this.server.respondText(conn, 404, 'text/plain', 'not found');
      return;
    }
    this.server.respond(conn, 200, contentTypeOf(rel), body, {}, false);
  }
}

function toBuffer(text: string): ArrayBuffer {
  const buf = new ArrayBuffer(text.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < text.length; i++) {
    view[i] = text.charCodeAt(i) & 0xff;
  }
  return buf;
}
