// dsh:logging-exempt (node-side driver)
/**
 * mux.js — the driver half of WS /api/remote.mux (docs/webserver-contract.md
 * §2.4). PORTED from presentation/web-client-next/web/js/mux.js — the mux
 * state machine (generation-tracked reconnect, per-stream handlers,
 * item/error/end routing) is UNMOVED. Deltas, transport-level only:
 *   - the ws URL is a constructor parameter; Node 24 global WebSocket
 *     (undici) instead of the browser builtin
 *   - no `window` diag hook; muxDiag stays as the plain export the runner
 *     prints in failure forensics
 * The page original re-opens every live stream on a fresh socket and the
 * feeds replay their baseline — the same holds here, so a reconnect mid-
 * turn re-seeds instead of silently stalling.
 */

const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 8000;

const diag = { frames: 0, routed: 0, dropped: 0, throws: 0,
  lastKinds: [], opens: 0, closes: 0, generation: 0 };
export const muxDiag = diag;

export class Mux {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
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
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    // Per-connect instance generation — the port MUST keep the page
    // original's `++` (web-client-next/web/js/mux.js). Without it the
    // generation guard is dead: a superseded socket's late close passes
    // the check, emits a spurious 'closed' and dials a duplicate socket
    // (both then re-open every live stream).
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
      this.dispatch(String(message.data));
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
    ws.onerror = () => {
      // Node's undici WebSocket re-enters onerror SYNCHRONOUSLY when
      // close() is called during CONNECTING (the browser builtin does
      // not) — an unconditional close here recursed to stack overflow on
      // the runner (observed live: RangeError from mux.js:79). Only an
      // OPEN socket needs an explicit close; a failed CONNECTING one
      // drives its own onclose.
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }

  close() {
    this.closedByUser = true;
    try { this.ws?.close(); } catch { /* racing close is fine */ }
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
