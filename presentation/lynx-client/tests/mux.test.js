// dsh:logging-exempt (test file: real local servers, no logging surface)
/**
 * mux.test.js — driver/wire/mux.js, the driver half of WS /api/remote.mux
 * (the port of web-client-v2's page mux: URL-parameter constructor,
 * Node's native WebSocket). Same contract legs as the page original's
 * suite: framing, hostile frames, generation-tracked reconnect. The
 * superseded-socket leg is the port-fidelity check — the page original
 * tracks generations per connect() so a replaced socket's late events
 * cannot trigger a duplicate reconnect.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { acceptUpgrade } from '../driver/mock/ws-lite.mjs';
import { Mux, muxDiag } from '../driver/wire/mux.js';

const bootWs = ({ onOpen } = {}) => new Promise((resolve) => {
  const state = { upgrades: 0, clientFrames: [], sockets: [] };
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    const ws = acceptUpgrade(req, socket);
    if (ws === null) return;
    state.upgrades += 1;
    state.sockets.push(ws);
    ws.onText((text) => {
      const frame = JSON.parse(text);
      state.clientFrames.push(frame);
      if (frame.type === 'open') {
        onOpen?.(frame, ws);
        ws.sendText(JSON.stringify({
          type: 'item', streamId: frame.streamId,
          value: { type: 'snapshot', records: [], assistantStream: { revision: 0 } },
        }));
        ws.sendText(JSON.stringify({
          type: 'item', streamId: frame.streamId, value: { type: 'event', seq: 1 },
        }));
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    resolve({
      state,
      url: `ws://127.0.0.1:${server.address().port}/api/remote.mux`,
      close: () => new Promise((r) => server.close(r)),
    });
  });
});

const liveMuxes = [];
const track = (mux) => (liveMuxes.push(mux), mux);
afterEach(() => {
  while (liveMuxes.length > 0) liveMuxes.pop().close();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
});

const openFollow = (mux, handlers = {}) =>
  mux.open('session/follow', { args: { request: { address: { sessionId: 's-1' }, assistantStream: true } } }, {
    onItem: (v) => handlers.items?.push(v),
    onError: (e) => handlers.errors?.push(e),
    onEnd: () => handlers.ends?.push(1),
  });

const waitFor = async (what, fn, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`deadline exceeded waiting for: ${what}`);
};

describe('framing + hostile frames', () => {
  it('opens a stream, routes items, cancel retires the stream', async () => {
    const srv = await bootWs();
    const mux = track(new Mux(srv.url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    const items = [];
    const streamId = openFollow(mux, { items });
    await waitFor('items routed', () => items.length >= 2);
    expect(srv.state.clientFrames[0]).toMatchObject({
      type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { sessionId: 's-1' }, assistantStream: true } } },
    });
    mux.cancel(streamId);
    await waitFor('cancel at server',
      () => srv.state.clientFrames.some((f) => f.type === 'cancel'));
    const droppedBefore = muxDiag.dropped;
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId, value: { type: 'event', seq: 2 } }));
    await waitFor('late item dropped', () => muxDiag.dropped > droppedBefore);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('malformed JSON, unknown streams and throwing handlers are contained', async () => {
    const srv = await bootWs();
    const mux = track(new Mux(srv.url));
    mux.connect();
    const items = [];
    openFollow(mux, { items });
    await waitFor('open', () => srv.state.clientFrames.length > 0);
    // The server answers the open with two item frames whose client-side
    // dispatch is async, and muxDiag.frames accumulates across tests —
    // snapshot at the quiesce point or framesBefore + 3 races them (CI: 6 vs 8).
    await waitFor('open response routed', () => items.length >= 2);
    const framesBefore = muxDiag.frames;
    const droppedBefore = muxDiag.dropped;
    const throwsBefore = muxDiag.throws;
    srv.state.sockets[0].sendText('not json');
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-zzz', value: {} }));
    mux.streams.get('s-1').handlers.onItem = () => { throw new Error('handler bug'); };
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-1', value: { type: 'event', seq: 3 } }));
    await waitFor('throw contained', () => muxDiag.throws > throwsBefore);
    expect(muxDiag.frames).toBe(framesBefore + 3);
    expect(muxDiag.dropped).toBe(droppedBefore + 1);
    mux.streams.get('s-1').handlers.onItem = (v) => items.push(v);
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-1', value: { type: 'event', seq: 4 } }));
    await waitFor('mux alive after the throw', () => items.some((v) => v.seq === 4));
  });
});

describe('reconnect: generation-tracked', () => {
  it('a socket drop re-opens every live stream on the fresh socket', async () => {
    let opens = 0;
    const srv = await bootWs({ onOpen: () => { opens += 1; } });
    const mux = track(new Mux(srv.url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    const items = [];
    openFollow(mux, { items });
    await waitFor('first serving', () => opens === 1 && items.length >= 1);
    srv.state.sockets[0].close();
    await waitFor('reconnected + re-opened + replayed',
      () => srv.state.upgrades === 2 && opens === 2 && items.length >= 3, 6000);
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  it('a user close stays closed', async () => {
    const srv = await bootWs();
    const mux = track(new Mux(srv.url));
    mux.connect();
    openFollow(mux, {});
    await waitFor('open', () => srv.state.upgrades === 1);
    mux.close();
    await new Promise((r) => setTimeout(r, 1200)); // past the reconnect deadline
    expect(srv.state.upgrades).toBe(1);
  });

  it("a superseded socket's late close triggers NO duplicate reconnect", async () => {
    const srv = await bootWs();
    const mux = track(new Mux(srv.url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    const items = [];
    const streamId = openFollow(mux, { items });
    await waitFor('socket 1 serving', () => items.length >= 1);
    mux.connect(); // reconnect on demand: socket 1 is now superseded
    await waitFor('socket 2 serving', () => srv.state.upgrades === 2 && items.length >= 3);
    const statusesAtReplacement = statuses.length;
    srv.state.sockets[0].close(); // the SUPERSEDED socket dies late
    await new Promise((r) => setTimeout(r, 1200)); // past the reconnect deadline
    expect(srv.state.upgrades).toBe(2); // no third socket
    expect(statuses.length).toBe(statusesAtReplacement); // no spurious closed/connecting/open
    expect(mux.streams.has(streamId)).toBe(true); // the stream survives on socket 2
  });
});

describe('the onerror recursion guard', () => {
  it('close() during CONNECTING does not re-enter and does not close', async () => {
    // undici re-enters onerror SYNCHRONOUSLY when close() runs during
    // CONNECTING — the exact stack overflow the runner caught (RangeError
    // from mux.js onerror, 71/71 tests passing with the process dying
    // after). The guard must close only an OPEN socket. Driven directly:
    // fire the handler by hand while the socket is still CONNECTING, so
    // the leg is deterministic on every undici version.
    const srv = await bootWs();
    const mux = track(new Mux(srv.url));
    mux.connect();
    await waitFor('ws exists', () => mux.ws !== null);
    expect(mux.ws.readyState).toBe(WebSocket.CONNECTING);
    expect(() => {
      mux.ws.onerror(new Error('probe 1'));
      mux.ws.onerror(new Error('probe 2'));
    }).not.toThrow();
    expect(mux.ws.readyState).toBe(WebSocket.CONNECTING); // the guard did NOT close it
    mux.close(); // user close from CONNECTING: throws nothing
  });

  it('a server refusing the upgrade loops bounded, process alive', async () => {
    // The real handshake failure, end to end: no upgrade listener, so
    // Node answers the upgrade request from the plain handler with 500
    // and undici fails the WebSocket. Whether the close event is
    // delivered immediately is undici-version dependent (measured both
    // ways across runners) — what THIS leg pins is that the mux cycles
    // bounded and the process survives, which is the recursion guard's
    // user-visible contract.
    const raw = createServer((req, res) => {
      res.writeHead(500, { 'Content-Length': 0 });
      res.end();
    });
    await new Promise((r) => raw.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${raw.address().port}/api/remote.mux`;
    const mux = track(new Mux(url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    await new Promise((r) => setTimeout(r, 2500)); // several backoff cycles
    expect(statuses[0]).toBe('connecting'); // the cycle ran from connecting
    expect(mux.ws).not.toBe(null); // still cycling, not crashed
    mux.close(); // user close: throws nothing, ends the cycle
    await new Promise((r) => raw.close(r));
  }, 10_000);
});
