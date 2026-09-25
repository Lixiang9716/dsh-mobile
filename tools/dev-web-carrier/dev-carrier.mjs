// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * dev-carrier.mjs — the LOCAL DEV WEB CARRIER: the official upstream Web
 * Client (presentation/official-web/dist, vendored verbatim) mounted in a
 * desktop browser, without an emulator.
 *
 * It is the Node port of the mobile carrier surface
 * (docs/webserver-contract.md §2, siblings CarrierWebDist/CarrierPlugins/
 * CarrierBootConfig on Android-iOS-Harmony): the fallback seat serves the
 * dist with the index render pipeline (injection rows + `<base href="/">`
 * + the `__DSH_BOOT_READY__` tail) behind auth-lite, `/plugins` serves the
 * client-module bundles at the COMPOSED GRAPH's revs, and `/api` +
 * `WS /api/remote.mux` answer the mobile runtime's honest claim surface —
 * `session.list` from a fixture, `session/journal` as a fixture replay,
 * everything else the structured gateway/unimplemented envelope (what the
 * on-device runtime answers before its Phase-C surface grows).
 *
 * The boot rows are not hand-built: compose-boot.mjs composes them with
 * the VENDORED @deepseek-ai/dsh-client-modules Node half over the
 * committed trees — the same wire the devices serve.
 *
 * This is a LOCAL iteration tool, not an E2E oracle: CI assertions stay
 * log-based (AGENTS.md "E2E by logs"); what this buys is the edit →
 * reload loop for carrier-side UI decisions at desktop speed.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBootWire, serializeRows } from './compose-boot.mjs';
import { startNextCarrier } from './next-mode.mjs';
import { PluginsRoute } from './plugins-route.mjs';
import { acceptUpgrade } from './ws-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DIST_ROOT = join(REPO_ROOT, 'presentation/official-web/dist');
const STAGE_DIR = join(REPO_ROOT, 'tmp/dev-web-carrier');
const COOKIE_NAME = 'dsh-dev-carrier';

/** Upstream recovery-config.ts defaults (web-boot.js recoveryDefaults). */
const RECOVERY_DEFAULTS = {
  backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10000,
  generationReadyWarnMs: 3000, generationReadyTimeoutMs: 15000,
};

/** The settings dialog's phone adaptation (CarrierIndexRows
 * SETTINGS_PHONE_CSS) — kept in step with the platform siblings. */
const SETTINGS_PHONE_CSS = '@media (max-width:1024px){div[role="dialog"][aria-modal="true"][aria-labelledby]{width:min(calc(100vw - 24px),800px);max-width:calc(100vw - 24px);height:min(calc(100vh - 24px),800px);border-radius:20px}}'
  + '@media (max-width:560px){div[role="dialog"][aria-modal="true"][aria-labelledby]{width:100vw;max-width:100vw;height:100vh;border-radius:0;flex-direction:column}'
  + 'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav{flex-direction:row;align-items:center;gap:12px;width:auto;max-width:100%;padding:10px 12px 0}'
  + 'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:first-child{flex:none;padding:0;white-space:nowrap}'
  + 'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:last-child{flex-direction:row;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;padding-bottom:8px}'
  + 'div[role="dialog"][aria-modal="true"][aria-labelledby] nav button{flex:none;height:36px;padding:6px 12px;white-space:nowrap}}';

/** Upstream's table, extended per webserver-contract §3.6. */
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json',
  map: 'application/json', webmanifest: 'application/manifest+json',
  gz: 'application/gzip', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  png: 'image/png',
};

const READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>';

/** Insert markup after the opening tag starting with pattern; prepend when
 * the document lacks the tag (CarrierWebDist.spliceAfter). */
const spliceAfter = (html, pattern, markup) => {
  const lower = html.toLowerCase();
  const withBracket = lower.indexOf(`${pattern}>`);
  const at = withBracket >= 0 ? withBracket + pattern.length + 1
    : lower.indexOf(pattern) >= 0 ? lower.indexOf(pattern) + pattern.length : -1;
  if (at < 0) return markup + html;
  return html.slice(0, at) + markup + html.slice(at);
};

const jsonString = (v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const htmlAttribute = (v) => v.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** One serialized row → [placement, markup] (CarrierIndexInjection shapes). */
const rowMarkup = (row) => {
  switch (row.kind) {
    case 'global':
      return ['head', `<script>globalThis[${jsonString(row.name)}] = ${row.value}</script>`];
    case 'script':
      return ['head', `<script>${row.text}</script>`];
    case 'script-src':
      return ['head', `<script src="${htmlAttribute(row.src)}"></script>`];
    case 'script-preload':
      return ['head', `<link rel="preload" as="script" href="${htmlAttribute(row.src)}">`];
    case 'style':
      return ['head', `<style>${row.text}</style>`];
    default:
      throw new Error(`dev-web-carrier: unknown injection row kind '${row.kind}'`);
  }
};

/** Render index.html with the rows (CarrierWebDist.renderIndex): head rows
 * after `<head…>` (base href first), body rows + the ready tail after
 * `<body…>`. */
const renderIndex = (html, rows) => {
  let head = '';
  let body = '';
  for (const row of rows) {
    const [placement, markup] = rowMarkup(row);
    if (placement === 'head') head += markup; else body += markup;
  }
  body += READY_MARKUP;
  let out = spliceAfter(html, '<head', '<base href="/">' + head);
  out = spliceAfter(out, '<body', body);
  return out;
};

/** One journal record → the upstream Remote-journal envelope (web-boot.js
 * wireEvent). */
const wireEvent = (record) => ({
  type: 'event',
  event: {
    type: record.type, seq: record.seq, time: record.time ?? 0, data: record.data ?? {},
    ...(record.ignorable === true ? { ignorable: true } : {}),
    ...(record.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: record.sourceEventSeqs }),
    ...(record.surfaceOp === undefined ? {} : { surfaceOp: record.surfaceOp }),
  },
});

const readJsonIfExists = (file, fallback) => {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
};

const parseArgs = (argv) => {
  const args = { port: 0, client: 'official' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--client') {
      args.client = argv[++i];
      if (args.client !== 'official' && args.client !== 'next') {
        throw new Error(`dev-web-carrier: unknown --client '${args.client}'`);
      }
    } else throw new Error(`dev-web-carrier: unknown argument '${argv[i]}'`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error('dev-web-carrier: --port must be an integer 0..65535');
  }
  return args;
};


/** `--client next`: our client against the fixture carrier's live echo turn. */
const runNextClient = async (args, sessionsFixture) => {
  const carried = await startNextCarrier({
    repoRoot: REPO_ROOT, port: args.port, sessionsFixture,
    journalPath: join(HERE, 'fixtures/journal.jsonl'),
  });
  const { port } = carried.server.address();
  console.log(`[dev-web-carrier:next] listening on http://127.0.0.1:${port}/`);
  console.log(`[dev-web-carrier:next] open http://127.0.0.1:${port}/?token=${carried.token}`);
  console.log('[dev-web-carrier:next] our client, static-served; /api + mux carry the LIVE dev-echo turn (session/create, session/prompt, session/cancel)');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionsFixture = readJsonIfExists(join(HERE, 'fixtures/sessions.json'), { items: [] });
  const journalFixture = readFileSync(join(HERE, 'fixtures/journal.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

  if (args.client === 'next') return runNextClient(args, sessionsFixture);

  console.log('[dev-web-carrier] composing the boot wire (vendored ClientModuleRegistry, Node host)…');
  const boot = await composeBootWire({ repoRoot: REPO_ROOT, stageDir: STAGE_DIR });
  const plugins = new PluginsRoute(boot.bundles);
  plugins.applyRuntimeRevs(boot.plugins);
  console.log(`[dev-web-carrier] boot wire composed: ${boot.entryCount} entries, ${boot.batchCount} batches, cross-parse OK`);

  const rows = serializeRows(boot.rows).concat([
    { kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: JSON.stringify(RECOVERY_DEFAULTS).replaceAll('<', '\\u003c') },
    { kind: 'style', text: SETTINGS_PHONE_CSS },
  ]);
  const token = randomBytes(16).toString('hex');
  const isAuthed = (req) => (req.headers.cookie ?? '').split(';')
    .map((c) => c.trim()).some((c) => c === `${COOKIE_NAME}=${token}`);
  const render = () => renderIndex(readFileSync(join(DIST_ROOT, 'index.html'), 'utf8'), rows);
  const env = { plugins, token, isAuthed, render, sessionsFixture };

  const server = createServer((req, res) => serveHttp(req, res, env));
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/remote.mux' || !isAuthed(req)) {
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket);
    if (ws === null) return socket.destroy();
    ws.onText((text) => handleMuxText(ws, text, sessionsFixture, journalFixture));
  });

  server.listen(args.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`[dev-web-carrier] listening on http://127.0.0.1:${port}/`);
    console.log(`[dev-web-carrier] open http://127.0.0.1:${port}/?token=${token} (auth-lite: token mints the session cookie)`);
  });
};

/** The route table: /plugins prefix → /api prefix → auth-lite → fallback
 * seat (exact→prefix→fallback, docs/webserver-contract.md §1.2). */
const serveHttp = (req, res, env) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const respond = (status, mime, body, headers = {}) => {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, { 'Content-Type': mime, 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  try {
    if (url.pathname === '/plugins' || url.pathname.startsWith('/plugins/')) {
      const request = { method: req.method, path: url.pathname, rawPath: url.pathname, query: url.search };
      return pluginsHandler(env, request, respond);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(req, url, respond, env.sessionsFixture);
    }
    if (!env.isAuthed(req)) return authGate(req, url, respond, env.token);
    return serveDist(req, url, respond, env.render);
  } catch (error) {
    console.error('[dev-web-carrier] request failed:', error?.stack ?? error);
    respond(400, 'text/plain', '');
  }
};

const pluginsHandler = (env, request, respond) => env.plugins.handler(request, respond);

/** Auth-lite (§3.4): a valid `?token=` GET of `/` mints the session
 * cookie and bounces to the clean URL; everything else 401s. */
const authGate = (req, url, respond, token) => {
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    return respond(303, 'text/plain', '', {
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly`, Location: '/',
    });
  }
  return respond(401, 'text/plain', '');
};

/** POST /api/<endpoint> — the mobile runtime's honest claim surface:
 * `session.list` from the fixture; everything else the structured
 * gateway/unimplemented envelope (web-boot.js deliverApiRequest shape). */
const handleApi = (req, url, respond, sessionsFixture) => {
  if (req.method !== 'POST') return respond(405, 'text/plain', '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const outcome = apiOutcome(url, Buffer.concat(chunks).toString('utf8'), sessionsFixture);
    if (outcome.error !== undefined) return respond(400, 'text/plain', '');
    respond(200, 'application/json', outcome.body);
  });
};

/** Pure leg of handleApi: parse the envelope, answer the claim surface. */
const apiOutcome = (url, bodyText, sessionsFixture) => {
  let envelope;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return { error: 'malformed json' };
  }
  if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string') {
    return { error: 'malformed envelope' };
  }
  const endpoint = url.pathname.slice('/api/'.length);
  const result = envelope.method === 'session.list'
    ? { ok: true, value: sessionsFixture }
    : {
      ok: false,
      error: {
        code: 'gateway/unimplemented',
        message: `endpoint ${endpoint} is not implemented by the dev carrier`,
        details: { endpoint },
      },
    };
  return { body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }) };
};

/** The mux: `session/journal` replays the fixture baseline then ends;
 * `workspace/follow` and `$events` are accepted and held open silently
 * (a live-but-quiet feed — the connection generation goes healthy without
 * the dev carrier fabricating event shapes); every other endpoint answers
 * the structured error frame (exactKeys-safe). */
const handleMuxText = (ws, text, sessionsFixture, journalFixture) => {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === 'open' && typeof msg.streamId === 'string') {
    if (msg.endpoint === 'session/journal') {
      const wanted = msg.payload?.args?.address?.sessionId ?? msg.payload?.args?.sessionId;
      const known = sessionsFixture.items.some((s) => s.sessionId === wanted);
      if (!known) {
        return ws.sendText(JSON.stringify({
          type: 'error', streamId: msg.streamId,
          error: { code: 'gateway/unavailable', message: `session ${JSON.stringify(wanted ?? null)} is not attached`, details: {} },
        }));
      }
      for (const record of journalFixture) {
        ws.sendText(JSON.stringify({ type: 'item', streamId: msg.streamId, value: wireEvent(record) }));
      }
      return ws.sendText(JSON.stringify({ type: 'end', streamId: msg.streamId }));
    }
    if (msg.endpoint === 'workspace/follow' || msg.endpoint === '$events') {
      return; // accepted, held open, quiet
    }
    return ws.sendText(JSON.stringify({
      type: 'error', streamId: msg.streamId,
      error: {
        code: 'gateway/unimplemented',
        message: `stream endpoint ${msg.endpoint} is not implemented by the dev carrier`,
        details: { endpoint: msg.endpoint },
      },
    }));
  }
  if (msg.type === 'cancel' && typeof msg.streamId === 'string') {
    return ws.sendText(JSON.stringify({ type: 'end', streamId: msg.streamId }));
  }
};

/** The fallback seat (CarrierWebDist.serve): GET/HEAD only, traversal →
 * 403, index render at `/`, fixed MIME table, empty 404s (absent or
 * non-file targets — §2.1 maps ENOENT/EISDIR/ENOTDIR alike). */
const serveDist = (req, url, respond, render) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(405, 'text/plain', '');
  const path = decodeURIComponent(url.pathname);
  if (path.includes('..')) return respond(403, 'text/plain', '');
  if (path === '/' || path === '/index.html') {
    return respond(200, MIME.html, render());
  }
  const file = join(DIST_ROOT, path.replace(/^\//, ''));
  if (!existsSync(file) || !statSync(file).isFile()) return respond(404, 'text/plain', '');
  const ext = path.split('.').pop().toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  return respond(200, mime, readFileSync(file));
};

main().catch((error) => {
  console.error('[dev-web-carrier] fatal:', error?.stack ?? error);
  process.exit(1);
});
