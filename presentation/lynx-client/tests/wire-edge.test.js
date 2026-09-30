// dsh:logging-exempt (test file: real local servers, no logging surface)
/**
 * wire-edge.test.js — the envelope edge legs the happy-path suite doesn't
 * reach: the {args:{request}} three-layer envelope under MALFORMED server
 * answers (a missing rpcId, a result with no ok arm, an error arm with no
 * error object, non-2xx statuses), the payload-KEY-must-be-present guard
 * (JSON.stringify drops an undefined value — the envelope contract needs
 * the key, api.js:29-31), and the mock serve's real endpoint guards
 * (session/busy on a running turn). Every leg rides a real local HTTP
 * server — the #248手法, no fetch mocks.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { makeRpc, isRemoteError } from '../driver/wire/api.js';
import { createSessionServe } from '../driver/wire/session-serve.js';
import { startMockServe } from '../driver/mock/mock-serve.mjs';

const listen = (handler) => new Promise((resolve) => {
  const server = createServer();
  server.on('request', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }));
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

const servers = [];
const boot = async (handler) => {
  const handle = await listen(handler);
  servers.push(handle);
  return handle;
};
afterAll(async () => {
  for (const handle of servers) await handle.close();
});

describe('api.js envelope: malformed server answers', () => {
  it('a 200 envelope missing rpcId is gateway/bad-response', async () => {
    const { baseUrl } = await boot((req, res, raw) => {
      const body = JSON.parse(raw);
      respond(res, 200, { type: 'server-response', result: { ok: true, value: {} }, dropped: body.rpcId });
    });
    await expect(makeRpc(baseUrl)('session/list')).rejects
      .toMatchObject({ code: 'gateway/bad-response', message: 'unexpected envelope shape' });
  });

  it('a result with no ok arm lands on gateway/unknown', async () => {
    const { baseUrl } = await boot((req, res) => respond(res, 200, {
      type: 'server-response', rpcId: 'rpc-x', result: {},
    }));
    const error = await makeRpc(baseUrl)('session/list').catch((e) => e);
    expect(isRemoteError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'gateway/unknown', message: 'unknown error' });
  });

  it('an ok:false answer with no error object still fails structured', async () => {
    const { baseUrl } = await boot((req, res) => respond(res, 200, {
      type: 'server-response', rpcId: 'rpc-x', result: { ok: false },
    }));
    await expect(makeRpc(baseUrl)('session/list')).rejects
      .toMatchObject({ code: 'gateway/unknown', message: 'unknown error', details: {} });
  });

  it('a non-JSON 200 body is gateway/bad-response (malformed body)', async () => {
    const { baseUrl } = await boot((req, res) => respond(res, 200, '<html>not json</html>'));
    await expect(makeRpc(baseUrl)('session/list')).rejects
      .toMatchObject({ code: 'gateway/bad-response' });
  });

  it('HTTP 404 (a route the serve does not have) is gateway/unavailable naming the status', async () => {
    const { baseUrl } = await boot((req, res) => respond(res, 404, {}));
    await expect(makeRpc(baseUrl)('workspace/nope')).rejects
      .toMatchObject({ code: 'gateway/unavailable', message: 'HTTP 404' });
  });
});

describe('envelope payload: the KEY must be present even when empty', () => {
  it('rpc() with no payload still ships payload:{} on the wire', async () => {
    let seenBody;
    const { baseUrl } = await boot((req, res, raw) => {
      seenBody = JSON.parse(raw);
      respond(res, 200, { type: 'server-response', rpcId: seenBody.rpcId, result: { ok: true, value: { items: [] } } });
    });
    const value = await makeRpc(baseUrl)('session/list');
    expect(value).toEqual({ items: [] });
    expect(seenBody.payload).toEqual({}); // the key is there, not undefined-dropped
    expect(Object.keys(seenBody)).toEqual(['type', 'rpcId', 'method', 'payload']);
  });

  it('the session family wraps at payload.args.request — three layers, verbatim', async () => {
    let seenBody;
    const { baseUrl } = await boot((req, res, raw) => {
      seenBody = JSON.parse(raw);
      respond(res, 200, { type: 'server-response', rpcId: seenBody.rpcId, result: { ok: true, value: { sessionId: 's-1' } } });
    });
    const serve = createSessionServe({ baseUrl });
    await serve.create();
    expect(seenBody.method).toBe('session/create');
    expect(seenBody.payload).toEqual({ args: { request: {} } });
  });
});

describe('mock serve endpoint guards through the real client', () => {
  it('a second prompt while a turn runs rejects session/busy', async () => {
    const mock = await startMockServe();
    const serve = createSessionServe({ baseUrl: mock.baseUrl });
    try {
      await serve.create().then((value) => serve.prompt(value.sessionId, '占住'));
      await expect(serve.prompt((await serve.list()).items[0].sessionId, '再来'))
        .rejects.toMatchObject({ code: 'session/busy' });
    } finally {
      serve.close();
      await mock.close();
    }
  });
});
