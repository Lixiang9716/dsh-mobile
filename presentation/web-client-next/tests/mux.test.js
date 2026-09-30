// dsh:logging-exempt (test file: real local servers, no logging surface)
/**
 * mux.test.js — web/js/mux.js, the page half of WS /api/remote.mux, driven
 * over REAL sockets: the server half is the dev carrier's own ws-lite
 * (tools/dev-web-carrier/ws-lite.mjs — the mux's actual production
 * counterpart, RFC 6455 handshake + frames). The only browser-provided
 * value the module reads is `location` (host+protocol), provided here per
 * test; the WebSocket itself is Node 24's native undici client — the same
 * WHATWG surface the browser ships.
 *
 * Covered: open/route/cancel/end framing, queued open while connecting,
 * malformed + unknown-stream frames dropped, handler throws contained,
 * generation-tracked reconnect (drop → fresh socket → live streams re-
 * opened and replayed), user close stays closed, and a superseded socket's
 * late close triggering NO duplicate reconnect.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { acceptUpgrade } from '../../../tools/dev-web-carrier/ws-lite.mjs';
import { Mux, muxDiag } from '../web/js/mux.js';

/** One ws-capable test server: counts upgrades, records client frames,
 * and answers `session/follow` opens with a snapshot + an item. */
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

/** The browser global mux.js reads (location only — WebSocket is native
 * undici in Node 24). Set per test, restored by dropLocation. */
const setLocation = (wsUrl) => {
  globalThis.location = { protocol: 'http:', host: new URL(wsUrl).host };
};
const dropLocation = () => { delete globalThis.location; };

const liveMuxes = []; // closed after every test so no socket outlives it
const track = (mux) => (liveMuxes.push(mux), mux);
afterEach(() => {
  while (liveMuxes.length > 0) liveMuxes.pop().close();
  dropLocation();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50)); // let closing sockets drain
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

describe('framing: open, route, cancel, end', () => {
  it('opens a stream, routes item frames to onItem, cancel removes it', async () => {
    const srv = await bootWs();
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    const items = [];
    const streamId = openFollow(mux, { items });
    await waitFor('open frame at server', () => srv.state.clientFrames.length > 0);
    expect(srv.state.clientFrames[0]).toMatchObject({
      type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { sessionId: 's-1' }, assistantStream: true } } },
    });
    await waitFor('both items routed', () => items.length >= 2);
    expect(items[0].type).toBe('snapshot');
    mux.cancel(streamId);
    await waitFor('cancel frame at server',
      () => srv.state.clientFrames.some((f) => f.type === 'cancel'));
    const droppedBefore = muxDiag.dropped;
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId, value: { type: 'event', seq: 2 } }));
    await waitFor('late item dropped', () => muxDiag.dropped > droppedBefore);
    expect(items.filter((v) => v.seq === 2)).toHaveLength(0);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('an end frame retires the stream: onEnd fires, later items for it are dropped', async () => {
    const srv = await bootWs();
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    mux.connect();
    const items = [];
    const ends = [];
    const streamId = openFollow(mux, { items, ends });
    await waitFor('items flowing', () => items.length >= 1);
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'end', streamId }));
    await waitFor('end handled', () => ends.length === 1);
    const droppedBefore = muxDiag.dropped;
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId, value: { type: 'event', seq: 9 } }));
    await waitFor('post-end item dropped', () => muxDiag.dropped > droppedBefore);
  });
});

describe('hostile frames: dropped, not thrown', () => {
  it('malformed JSON and unknown streamIds are counted, never routed', async () => {
    const srv = await bootWs();
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    mux.connect();
    const items = [];
    openFollow(mux, { items });
    await waitFor('open', () => srv.state.clientFrames.length > 0);
    const droppedBefore = muxDiag.dropped;
    const throwsBefore = muxDiag.throws;
    const framesBefore = muxDiag.frames;
    srv.state.sockets[0].sendText('not json at all'); // malformed: counted, never routed
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-zzz', value: {} }));
    // a routed handler that throws must not take the mux down
    mux.streams.get('s-1').handlers.onItem = () => { throw new Error('handler bug'); };
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-1', value: { type: 'event', seq: 3 } }));
    await waitFor('throw contained', () => muxDiag.throws > throwsBefore);
    expect(muxDiag.frames).toBe(framesBefore + 3); // all three frames were seen
    expect(muxDiag.dropped).toBe(droppedBefore + 1); // only the unknown-stream one "dropped"
    // the mux is still alive: fix the handler, next frame routes
    mux.streams.get('s-1').handlers.onItem = (v) => items.push(v);
    srv.state.sockets[0].sendText(JSON.stringify({ type: 'item', streamId: 's-1', value: { type: 'event', seq: 4 } }));
    await waitFor('recovered', () => items.some((v) => v.seq === 4));
  });

  it('an open issued while CONNECTING is queued and sent once the socket is up', async () => {
    const srv = await bootWs();
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    mux.connect(); // handshake in flight
    const items = [];
    const streamId = openFollow(mux, { items }); // ws not OPEN yet: queued
    await waitFor('queued open flushed on open', () => srv.state.clientFrames.length > 0);
    expect(srv.state.clientFrames[0].streamId).toBe(streamId);
    await waitFor('server answer routed back', () => items.length > 0);
  });
});

describe('reconnect: generation-tracked', () => {
  it('a socket drop re-opens every live stream on the fresh socket and replays', async () => {
    let opens = 0;
    const srv = await bootWs({ onOpen: () => { opens += 1; } });
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    const statuses = [];
    mux.onStatus((s) => statuses.push(s));
    mux.connect();
    const items = [];
    openFollow(mux, { items });
    await waitFor('first open seen', () => opens === 1 && items.length >= 1);
    srv.state.sockets[0].close(); // server-side drop → mux must reconnect
    await waitFor('reconnected + stream re-opened + replayed',
      () => srv.state.upgrades === 2 && opens === 2 && items.length >= 3, 6000);
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  it('a user close stays closed: no reconnect rides in', async () => {
    const srv = await bootWs();
    setLocation(srv.url);
    const mux = track(new Mux(srv.url));
    mux.connect();
    openFollow(mux, {});
    await waitFor('open', () => srv.state.upgrades === 1);
    mux.close();
    // negative-time assertion: wait past the reconnect deadline (base
    // backoff 600ms) and assert the condition never arrived
    await new Promise((r) => setTimeout(r, 1200));
    expect(srv.state.upgrades).toBe(1);
  });

  it("a superseded socket's late close triggers NO duplicate reconnect", async () => {
    const srv = await bootWs();
    setLocation(srv.url);
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
