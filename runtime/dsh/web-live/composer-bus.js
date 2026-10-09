/**
 * web-live/composer-bus.js — the composer seat's bus queue/post/take
 * trio, split from composer-web-live.js at the code-size gate. The
 * module-scope seam (__dshBusOnMessage buffering before dispatch
 * installs) is exactly the shape the seat owned; the factory keeps
 * `posted` with it (the settings probes assert on those frames).
 */
import { createLogger } from 'logger.js';

const log = createLogger('b4.bus');

export const makeComposerBus = () => {
/** Bus deliveries may arrive before the awaiting half exists (the drive
 * injects right after eval), so the subscription is module-scope, buffers,
 * and wakes pending `take()` waiters — never a poll. Once `dispatch` is
 * installed, deliveries go straight to it. */
  const queue = [];
  let wake = null;
  let dispatch = null;
  globalThis.__dshBusOnMessage = (line) => {
    log.debug('bus on message', {});
  const msg = JSON.parse(line);
  if (dispatch !== null) return dispatch(msg);
  queue.push(msg);
  wake?.();
};
/** All posted bus frames, in order — the settings-surface probes assert on
 * the api.respond frames (the exact wire the carrier hands the page). */
  const posted = [];
  const post = (msg) => {
    log.debug('post', { type: msg?.type ?? null });
  posted.push(msg);
  globalThis.__dshBusPost?.(JSON.stringify(msg));
};

/** Wait for (and remove) the next delivery of one type. */
  const take = async (type) => {
    log.debug('take', { type });
  for (;;) {
    const at = queue.findIndex((msg) => msg.type === type);
    if (at >= 0) return queue.splice(at, 1)[0];
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
};

  const deliver = (msg) => {
    log.debug('bus deliver', { type: msg?.type ?? null }); if (dispatch !== null) dispatch(msg); else queue.push(msg); };
  return { queue, post, take, deliver,
    install: (fn) => { dispatch = fn; } };
};
