// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * mux.js — the page half of WS /api/remote.mux (docs/webserver-contract.md
 * §2.4). One multiplexed socket: the page opens streams ({type:'open',
 * streamId, endpoint, payload}, cancel with {type:'cancel', streamId}) and
 * the host answers {type:'item'|'error'|'end', streamId, ...} frames. The
 * session/follow items interleave durable journal records ({type:'event'})
 * and assistant-stream notification frames (start/chunk/end).
 *
 * Reconnect is generation-tracked: on a socket drop every live stream is
 * re-opened on the fresh socket (stream handlers survive across sockets;
 * the re-opened feeds replay their baseline, the timeline folds it again).
 */

const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 8000;

/** The diagnostic face the on-device probe reads in failure forensics
 * (frames seen / sockets opened / closes / reconnect generations). */
const diag = { frames: 0, routed: 0, dropped: 0, throws: 0,
  lastKinds: [], opens: 0, closes: 0, generation: 0 };
export const muxDiag = diag;
if (typeof window !== 'undefined') window.__dshMuxDiag = diag;

export class Mux {
  constructor() {
    this.ws = null;
    this.streams = new Map(); // streamId → {endpoint, payload, handlers}
    this.nextStreamId = 1;
    this.generation = 0;
    this.closedByUser = false;
    this.backoff = RECONNECT_BASE_MS;
    this.statusListeners = new Set();
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(status) {
    for (const listener of this.statusListeners) listener(status);
  }

  connect() {
    this.closedByUser = false;
    diag.generation += 1;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/api/remote.mux`);
    this.ws = ws;
    const generation = ++this.generation;
    this.emit('connecting');
    ws.onopen = () => {
      if (generation !== this.generation) return;
      diag.opens += 1;
      this.backoff = RECONNECT_BASE_MS;
      this.emit('open');
      for (const [streamId, stream] of this.streams) {
        this.sendOpen(streamId, stream.endpoint, stream.payload);
      }
    };
    ws.onmessage = (message) => {
      if (generation !== this.generation) return;
      this.dispatch(message.data);
    };
    ws.onclose = () => {
      diag.closes += 1;
      if (generation !== this.generation || this.closedByUser) return;
      this.emit('closed');
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      setTimeout(() => {
        if (!this.closedByUser && generation === this.generation) this.connect();
      }, delay);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  /** Open one stream; handlers: {onItem, onError, onEnd}. Returns the
   * streamId (the caller owns cancellation). Queued while connecting. */
  open(endpoint, payload, handlers) {
    const streamId = `s-${this.nextStreamId++}`;
    this.streams.set(streamId, { endpoint, payload, handlers });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendOpen(streamId, endpoint, payload);
    }
    return streamId;
  }

  cancel(streamId) {
    if (!this.streams.has(streamId)) return;
    this.streams.delete(streamId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send(JSON.stringify({ type: 'cancel', streamId }));
    }
  }

  sendOpen(streamId, endpoint, payload) {
    this.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
  }

  send(text) {
    try {
      this.ws?.send(text);
    } catch {
      // A racing close is the caller-visible 'closed' status; never throw.
    }
  }

  dispatch(text) {
    diag.frames += 1;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // A malformed frame is dropped; the feed's gap detection is the feed owner's.
    }
    const stream = this.streams.get(frame.streamId);
    if (stream === undefined) {
      diag.dropped += 1;
      diag.lastKinds.push('drop:' + (frame.type ?? '?'));
      if (diag.lastKinds.length > 4) diag.lastKinds.shift();
      return;
    }
    diag.routed += 1;
    diag.lastKinds.push(frame.type + ':' + (frame.value?.type ?? frame.error?.code ?? ''));
    if (diag.lastKinds.length > 4) diag.lastKinds.shift();
    try {
      if (frame.type === 'item') {
        stream.handlers.onItem?.(frame.value);
      } else if (frame.type === 'error') {
        stream.handlers.onError?.(frame.error);
      } else if (frame.type === 'end') {
        this.streams.delete(frame.streamId);
        stream.handlers.onEnd?.();
      }
    } catch (error) {
      diag.throws += 1;
      diag.lastKinds.push('throw: ' + String(error?.message ?? error).slice(0, 80));
      if (diag.lastKinds.length > 4) diag.lastKinds.shift();
    }
  }
}
