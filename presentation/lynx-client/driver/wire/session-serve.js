// dsh:logging-exempt (node-side driver)
/**
 * session-serve.js — the SessionServe wire client: the endpoints and their
 * exact envelope shapes, PORTED from web-client-next's main.js/composer.js
 * call sites (not rewritten, not invented):
 *
 *   session/list    → rpc('session/list')            (bare {} payload, as main.js)
 *   session/create  → {args:{request:{}}}            (main.js)
 *   session/prompt  → {args:{request:{requestId, sessionId, mode:'steer',
 *                      content:[{type:'text',text}], clientTimeZone}}}
 *                                                      (composer.js admitPrompt)
 *   session/cancel  → {args:{request:{sessionId}}}   (composer.js requestCancel)
 *   session/follow  → mux stream {args:{request:{address:{sessionId},
 *                      assistantStream:true}}}       (main.js openSession)
 *
 * The session family wraps its parameters at payload.args.request — the
 * three-layer envelope — while other namespaces (e.g. workspaceFiles) take
 * them at args level directly; this client speaks only the session family.
 */

import { makeRpc, isRemoteError } from './api.js';
import { Mux, muxDiag } from './mux.js';

const mintRequestId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`);

export const createSessionServe = ({ baseUrl }) => {
  const rpc = makeRpc(baseUrl);
  const mux = new Mux(baseUrl.replace(/^http/, 'ws') + '/api/remote.mux');

  const list = () => rpc('session/list');
  const create = () => rpc('session/create', { args: { request: {} } });
  const prompt = (sessionId, text) => rpc('session/prompt', {
    args: {
      request: {
        requestId: mintRequestId(),
        sessionId,
        mode: 'steer',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
  });
  const cancel = (sessionId) =>
    rpc('session/cancel', { args: { request: { sessionId } } });
  const follow = (sessionId, handlers) => mux.open('session/follow', {
    args: { request: { address: { sessionId }, assistantStream: true } },
  }, handlers);
  const cancelFollow = (streamId) => mux.cancel(streamId);

  return {
    connect: () => mux.connect(),
    close: () => mux.close(),
    onStatus: (cb) => mux.onStatus(cb),
    list, create, prompt, cancel, follow, cancelFollow,
    diag: muxDiag,
    isRemoteError,
  };
};
