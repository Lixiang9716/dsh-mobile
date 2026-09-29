// dsh:logging-exempt (node-side driver)
/**
 * driver.js — the orchestration: the ONE wire subscription point, the seed
 * protocol, and the intent executor. The driver owns the wire and the
 * session state of record; the skin owns nothing but the fold of the view
 * events pushed at it. Zero rendering lives here.
 *
 * Event path (iron law #1): session/follow feed → adapter.translateRecord →
 * skin.pushViewEvent. Nothing else subscribes to anything.
 *
 * Seed protocol (iron law #3): a fresh follow replays its whole snapshot as
 * a bracketed burst — seed-start … events … seed-end — so a session opened
 * mid-history rebuilds fully; the fold resets at seed-start. Before the
 * wire answers, mount() has already pushed connection + the drawer list, so
 * even a cold boot is a shell, not a blank.
 *
 * Intent path (iron law #2): skin intents arrive through the seam's
 * dispatchIntent (validated, unknown → throws); each maps to exactly one
 * wire call; a failed prompt/cancel surfaces as an honest status event,
 * never a fake success.
 */

import { translateRecord, translateSnapshot } from './adapter.js';
import { makeSettled } from '../shared/view-events.js';
import { dispatchIntent } from './render-surface-client.js';

/** One honest failure status (never a fake success). */
const failureStatus = (serve, push, prefix) => (error) => push(makeSettled('status', {
  text: `${prefix}（${serve.isRemoteError(error) ? error.code : 'transport'}）`,
  tone: 'warn',
}));

const execSubmit = (ctx, intent) => {
  const { serve, push, ref } = ctx;
  if (ref.sessionId === null) {
    push(makeSettled('status', { text: '尚未进入会话', tone: 'warn' }));
    return;
  }
  serve.prompt(ref.sessionId, intent.text)
    .then(() => push(makeSettled('prompt-admitted', {})))
    .catch(failureStatus(serve, push, '发送失败'));
};

const execCancel = (ctx) => {
  const { serve, ref } = ctx;
  if (ref.sessionId === null) return;
  serve.cancel(ref.sessionId)
    .catch(failureStatus(serve, ctx.push, '此主机暂不支持取消'));
};

const execSelect = (ctx, intent) => ctx.openSession(intent.sessionId);

const execNewSession = (ctx) => {
  const { serve, push, refreshSessions } = ctx;
  serve.create()
    .then((value) => {
      const sessionId = value?.sessionId;
      if (typeof sessionId !== 'string') {
        throw new TypeError(`fail loud: session/create returned no sessionId: ${
          JSON.stringify(value)}`);
      }
      ctx.openSession(sessionId);
      return refreshSessions();
    })
    .catch(failureStatus(serve, push, '创建失败'));
};

/** The closed intent switch; dispatchIntent already failed loud on unknown
 * types, so the default arm is the exhaustive-switch guard. */
const onIntent = (ctx) => (intent) => {
  switch (intent.type) {
    case 'submit': return execSubmit(ctx, intent);
    case 'cancel': return execCancel(ctx);
    case 'select-session': return execSelect(ctx, intent);
    case 'new-session': return execNewSession(ctx);
    default:
      throw new TypeError(`fail loud: unhandled intent: ${JSON.stringify(intent)}`);
  }
};

const makeRefreshSessions = (ctx) => async () => {
  try {
    const value = await ctx.serve.list();
    ctx.push(makeSettled('sessions', {
      items: Array.isArray(value?.items) ? value.items : [],
    }));
  } catch (error) {
    failureStatus(ctx.serve, ctx.push, '会话列表不可用')(error);
  }
};

const makeLeaveSession = (ctx) => () => {
  if (ctx.ref.followStream !== undefined) {
    ctx.serve.cancelFollow(ctx.ref.followStream);
    ctx.ref.followStream = undefined;
  }
  ctx.ref.sessionId = null;
};

// A fresh follow replays its snapshot: the seed burst (seed-start …
// seed-end) rebuilds the thread mid-history without a blank gap.
const makeOpenSession = (ctx) => (sessionId) => {
  ctx.leaveSession();
  ctx.ref.sessionId = sessionId;
  ctx.ref.followStream = ctx.serve.follow(sessionId, {
    onItem: (value) => {
      for (const event of translateRecord(value)) ctx.push(event);
    },
    onError: (error) => {
      ctx.push(makeSettled('status', {
        text: `会话流不可用（${error?.code ?? 'unknown'}）`, tone: 'warn',
      }));
      ctx.leaveSession();
    },
    onEnd: () => { ctx.ref.followStream = undefined; },
  });
};

export const createDriver = ({ skin, serve }) => {
  if (skin === undefined || serve === undefined) {
    throw new TypeError('fail loud: createDriver needs { skin, serve }');
  }
  let teardownDone = false;
  const ref = { sessionId: null, followStream: undefined };
  const push = (event) => {
    if (teardownDone) return;
    skin.pushViewEvent(event);
  };
  const pushConnection = (status) => push(makeSettled('connection', { status }));
  const ctx = { serve, push, ref };
  ctx.refreshSessions = makeRefreshSessions(ctx);
  ctx.leaveSession = makeLeaveSession(ctx);
  ctx.openSession = makeOpenSession(ctx);

  return {
    async mount() {
      skin.onIntent((intent) => dispatchIntent(onIntent(ctx), intent));
      await skin.mount();
      pushConnection('connecting');
      serve.onStatus((status) => {
        pushConnection(status);
        if (status === 'open') void ctx.refreshSessions();
      });
      serve.connect();
      await ctx.refreshSessions();
    },

    /** Test/ops entry: open a session by id (the drawer flow without the
     * intent hop). Production flow uses intents only. */
    openSession: ctx.openSession,

    activeSession: () => ref.sessionId,

    async teardown() {
      ctx.leaveSession();
      serve.close();
      teardownDone = true;
      await skin.teardown();
    },
  };
};
