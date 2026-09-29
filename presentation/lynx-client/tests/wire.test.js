import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { makeRpc, RemoteError, isRemoteError } from '../driver/wire/api.js';
import { createSessionServe } from '../driver/wire/session-serve.js';
import { acceptUpgrade } from '../driver/mock/ws-lite.mjs';

let server;
let seen; // captured requests: {method, url, body}
let reply; // (req, res, body) per request
const listen = (handler) => new Promise((resolve) => {
  server = createServer(handler);
  server.on('error', (e) => { throw e; });
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const respond = (res, value) => {
  const buf = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
};

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('api.js: the POST envelope bridge', () => {
  it('sends the frozen envelope and resolves the ok value', async () => {
    seen = [];
    const baseUrl = await listen((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push({ url: req.url, body });
        respond(res, { type: 'server-response', rpcId: body.rpcId,
          result: { ok: true, value: { sessionId: 's-1' } } });
      });
    });
    const rpc = makeRpc(baseUrl);
    const value = await rpc('session/create', { args: { request: {} } });
    expect(value).toEqual({ sessionId: 's-1' });
    expect(seen[0].url).toBe('/api/session/create');
    expect(seen[0].body).toMatchObject({
      type: 'client-request', method: 'session/create',
      payload: { args: { request: {} } },
    });
    expect(typeof seen[0].body.rpcId).toBe('string');
  });

  it('throws the wire error triple on ok:false', async () => {
    const baseUrl = await listen((req, res) => {
      req.on('data', () => {});
      req.on('end', () => respond(res, { type: 'server-response', rpcId: 'r',
        result: { ok: false, error: { code: 'session/busy', message: 'busy', details: {} } } }));
    });
    const error = await makeRpc(baseUrl)('session/prompt', {}).catch((e) => e);
    expect(isRemoteError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'session/busy', message: 'busy' });
  });

  it('names a malformed body and an HTTP failure as transport-class errors', async () => {
    const bad = await listen((req, res) => {
      req.on('data', () => {});
      req.on('end', () => respond(res, { nothing: true }));
    });
    await expect(makeRpc(bad)('x', {})).rejects.toMatchObject({ code: 'gateway/bad-response' });
    let httpFail = null;
    const failing = createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(500); res.end(); }); });
    await new Promise((r) => failing.listen(0, '127.0.0.1', r));
    await makeRpc(`http://127.0.0.1:${failing.address().port}`)('x', {})
      .catch((e) => { httpFail = e; });
    expect(httpFail.code).toBe('gateway/unavailable');
    await new Promise((r) => failing.close(r));
    expect(new RemoteError('c', 'm') instanceof Error).toBe(true);
  });
});

describe('session-serve.js: the session family shapes', () => {
  it('wraps session payloads in the three-layer {args:{request}} envelope', async () => {
    seen = [];
    const baseUrl = await listen((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push({ url: req.url, body });
        respond(res, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
      });
    });
    const serve = createSessionServe({ baseUrl });
    await serve.list();
    await serve.create();
    await serve.prompt('s-9', '画出极光');
    await serve.cancel('s-9');
    expect(seen[0].body.payload).toEqual({});
    expect(seen[1].body.payload).toEqual({ args: { request: {} } });
    const request = seen[2].body.payload.args.request;
    expect(request).toMatchObject({
      sessionId: 's-9', mode: 'steer',
      content: [{ type: 'text', text: '画出极光' }],
    });
    expect(typeof request.requestId).toBe('string');
    expect(typeof request.clientTimeZone).toBe('string');
    expect(seen[3].body.payload).toEqual({ args: { request: { sessionId: 's-9' } } });
  });

  it('follow opens session/follow with the address payload over the mux', async () => {
    seen = [];
    const http = await listen((req, res) => {
      req.on('data', () => {});
      req.on('end', () => respond(res, { type: 'server-response', rpcId: 'r', result: { ok: true, value: {} } }));
    });
    const wsServer = createServer();
    wsServer.on('upgrade', (req, socket) => {
      const ws = acceptUpgrade(req, socket);
      ws.onText((text) => {
        seen.push(JSON.parse(text));
        ws.sendText(JSON.stringify({
          type: 'item', streamId: seen[0].streamId,
          value: { type: 'snapshot', records: [], assistantStream: { revision: 0 } },
        }));
      });
    });
    await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
    const httpBase = `http://127.0.0.1:${wsServer.address().port}`;
    const serve = createSessionServe({ baseUrl: httpBase });
    serve.connect();
    const items = [];
    serve.follow('s-7', { onItem: (v) => items.push(v), onError: () => {}, onEnd: () => {} });
    // Poll the handshake conditions with a deadline — never a fixed sleep.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(seen.length > 0 && items.length > 0)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen[0]).toMatchObject({ type: 'open', endpoint: 'session/follow' });
    expect(seen[0].payload).toEqual({
      args: { request: { address: { sessionId: 's-7' }, assistantStream: true } },
    });
    expect(items).toHaveLength(1);
    serve.close();
    await new Promise((r) => wsServer.close(r));
  });
});
