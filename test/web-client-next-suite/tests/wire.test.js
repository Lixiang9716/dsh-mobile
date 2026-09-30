// dsh:logging-exempt (test file: real local servers, no logging surface)
/**
 * wire.test.js — web/js/api.js, the POST /api envelope bridge, driven over
 * a REAL local HTTP server. The one browser-only byte is the relative
 * request URL (`/api/<method>`); a fetch shim prefixes a loopback base and
 * delegates to Node's native fetch, so the envelope encode/decode — the
 * {type:'client-request', rpcId, method, payload} request, the
 * {type:'server-response', rpcId, result:{ok,value}|{ok,error}} reply and
 * every error triple — runs for real, byte for byte.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { rpc, isRemoteError, RemoteError } from '../../presentation/web-client-next/web/js/api.js';

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = createServer();
  server.on('request', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  server.listen(0, '127.0.0.1', () => {
    servers.push(server);
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});
const respond = (res, status, value) => {
  const buf = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
};
const answerWith = (result, status = 200) => listen((req, res, raw) => {
  const body = JSON.parse(raw);
  respond(res, status, { type: 'server-response', rpcId: body.rpcId, result });
});

const realFetch = globalThis.fetch;
let fetchBase = null;
// the shim: same contract as the browser's same-origin fetch, plus a base
const shimmedFetch = (url, init) => realFetch(`${fetchBase}${url}`, init);
const onShim = () => { globalThis.fetch = shimmedFetch; };
afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const server of servers) await new Promise((r) => server.close(r));
});

describe('api.js: the request envelope over real HTTP', () => {
  it('sends the frozen envelope shape and hits /api/<method>', async () => {
    const seen = [];
    fetchBase = await listen((req, res, raw) => {
      seen.push({ url: req.url, body: JSON.parse(raw) });
      respond(res, 200, { type: 'server-response', rpcId: seen[0].body.rpcId, result: { ok: true, value: { items: [] } } });
    });
    onShim();
    const value = await rpc('session/list');
    expect(value).toEqual({ items: [] });
    expect(seen[0].url).toBe('/api/session/list');
    expect(seen[0].body.method).toBe('session/list');
    expect(typeof seen[0].body.rpcId).toBe('string');
    expect(seen[0].body.type).toBe('client-request');
  });

  it('rpcId is minted fresh per call', async () => {
    const seen = [];
    fetchBase = await listen((req, res, raw) => {
      const body = JSON.parse(raw);
      seen.push(body.rpcId);
      respond(res, 200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
    });
    onShim();
    await rpc('session/list');
    await rpc('session/list');
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('api.js: the payload rides verbatim', () => {
  it('the payload KEY ships even when the caller passes nothing', async () => {
    let seen;
    fetchBase = await listen((req, res, raw) => {
      seen = JSON.parse(raw);
      respond(res, 200, { type: 'server-response', rpcId: seen.rpcId, result: { ok: true, value: {} } });
    });
    onShim();
    await rpc('session/list'); // no payload argument at all
    expect(seen.payload).toEqual({}); // present, not undefined-dropped by JSON.stringify
    expect(Object.keys(seen)).toEqual(['type', 'rpcId', 'method', 'payload']);
  });

  it('an explicit payload passes through verbatim ({args:{request}} three layers)', async () => {
    const seen = [];
    fetchBase = await listen((req, res, raw) => {
      const body = JSON.parse(raw);
      seen.push(body);
      respond(res, 200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } });
    });
    onShim();
    const payload = {
      args: { request: {
        requestId: 'req-1', sessionId: 's-9', mode: 'steer',
        content: [{ type: 'text', text: '画出极光' }], clientTimeZone: 'Asia/Shanghai',
      } },
    };
    await rpc('session/prompt', payload);
    expect(seen[0].payload).toEqual(payload);
  });
});

describe('api.js: error decoding — the ok/error arms', () => {
  it('ok:false resolves to the thrown RemoteError triple, details included', async () => {
    fetchBase = await answerWith({ ok: false, error: { code: 'session/busy', message: 'busy', details: { retryAfter: 3 } } });
    onShim();
    const error = await rpc('session/prompt', { args: { request: { sessionId: 's-9' } } }).catch((e) => e);
    expect(isRemoteError(error)).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error).toMatchObject({ code: 'session/busy', message: 'busy', details: { retryAfter: 3 } });
  });

  it('a result with no ok arm lands on gateway/unknown', async () => {
    fetchBase = await answerWith({});
    onShim();
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/unknown', message: 'unknown error' });
  });

  it('ok:false with no error object still fails structured', async () => {
    fetchBase = await answerWith({ ok: false });
    onShim();
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/unknown', details: {} });
  });
});

describe('api.js: error decoding — shape and transport failures', () => {
  it('a reply missing rpcId is gateway/bad-response (unexpected envelope shape)', async () => {
    fetchBase = await listen((req, res) => {
      respond(res, 200, { type: 'server-response', result: { ok: true, value: {} } }); // rpcId dropped
    });
    onShim();
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/bad-response', message: 'unexpected envelope shape' });
  });

  it('a non-JSON 200 body is gateway/bad-response (malformed body)', async () => {
    fetchBase = await listen((req, res) => respond(res, 200, '<html>not json</html>'));
    onShim();
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/bad-response' });
  });

  it('HTTP 500 is gateway/unavailable naming the status', async () => {
    fetchBase = await listen((req, res) => respond(res, 500, {}));
    onShim();
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/unavailable', message: 'HTTP 500' });
  });

  it('a refused connection is gateway/unavailable (transport failed)', async () => {
    globalThis.fetch = realFetch; // no shim: relative /api against node fetch fails outright
    await expect(rpc('session/list')).rejects
      .toMatchObject({ code: 'gateway/unavailable' });
  });

  it('RemoteError is a plain Error subclass with the triple fields', () => {
    const error = new RemoteError('c', 'm', { d: 1 });
    expect(error instanceof Error).toBe(true);
    expect(error).toMatchObject({ code: 'c', message: 'm', details: { d: 1 } });
  });
});
