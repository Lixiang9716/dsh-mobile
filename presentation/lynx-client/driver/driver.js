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

export const createDriver = ({ skin, serve }) => {
  if (skin === undefined || serve === undefined) {
    throw new TypeError('fail loud: createDriver needs { skin, serve }');
  }

  let activeSessionId = null;
  let followStream = null;
  let teardownDone = false;

  const push = (event) => {
    if (teardownDone) return;
    skin.pushViewEvent(event);
  };

  const pushConnection = (status) => push(makeSettled('connection', { status }));

  const refreshSessions = async () => {
    try {
      const value = await serve.list();
      push(makeSettled('sessions', {
        items: Array.isArray(value?.items) ? value.items : [],
      }));
    } catch (error) {
      const code = serve.isRemoteError(error) ? error.code : 'transport';
      push(makeSettled('status', { text: `会话列表不可用（${code}）`, tone: 'warn' }));
    }
  };

  const leaveSession = () => {
    if (followStream !== null) {
      serve.cancelFollow(followStream);
      followStream = null;
    }
    activeSessionId = null;
  };

  const onFeedItem = (value) => {
    for (const event of translateRecord(value)) push(event);
  };

  const openSession = (sessionId) => {
    leaveSession();
    activeSessionId = sessionId;
    // A fresh follow replays its snapshot: the seed burst (seed-start …
    // seed-end) rebuilds the thread mid-history without a blank gap.
    followStream = serve.follow(sessionId, {
      onItem: onFeedItem,
      onError: (error) => {
        push(makeSettled('status', {
          text: `会话流不可用（${error?.code ?? 'unknown'}）`, tone: 'warn',
        }));
        leaveSession();
      },
      onEnd: () => { followStream = null; },
    });
  };

  const handleIntent = (intent) => {
    switch (intent.type) {
      case 'submit': {
        if (activeSessionId === null) {
          push(makeSettled('status', { text: '尚未进入会话', tone: 'warn' }));
          return;
        }
        serve.prompt(activeSessionId, intent.text)
          .then(() => push(makeSettled('prompt-admitted', {})))
          .catch((error) => push(makeSettled('status', {
            text: `发送失败（${serve.isRemoteError(error) ? error.code : 'transport'}）`,
            tone: 'warn',
          })));
        return;
      }
      case 'cancel': {
        if (activeSessionId === null) return;
        serve.cancel(activeSessionId)
          .catch((error) => push(makeSettled('status', {
            text: `此主机暂不支持取消（${serve.isRemoteError(error) ? error.code : 'transport'}）`,
            tone: 'warn',
          })));
        return;
      }
      case 'select-session':
        openSession(intent.sessionId);
        return;
      case 'new-session':
        serve.create()
          .then((value) => {
            const sessionId = value?.sessionId;
            if (typeof sessionId !== 'string') {
              throw new TypeError(`fail loud: session/create returned no sessionId: ${
                JSON.stringify(value)}`);
            }
            openSession(sessionId);
            return refreshSessions();
          })
          .catch((error) => push(makeSettled('status', {
            text: `创建失败（${serve.isRemoteError(error) ? error.code : 'transport'}）`,
            tone: 'warn',
          })));
        return;
      default:
        // dispatchIntent already failed loud on unknown types; this arm is
        // unreachable and stays as the exhaustive-switch guard.
        throw new TypeError(`fail loud: unhandled intent: ${JSON.stringify(intent)}`);
    }
  };

  return {
    async mount() {
      skin.onIntent((intent) => dispatchIntent(handleIntent, intent));
      await skin.mount();
      pushConnection('connecting');
      serve.onStatus((status) => {
        pushConnection(status);
        if (status === 'open') void refreshSessions();
      });
      serve.connect();
      await refreshSessions();
    },

    /** Test/ops entry: open a session by id (the drawer flow without the
     * intent hop). Production flow uses intents only. */
    openSession,

    activeSession: () => activeSessionId,

    async teardown() {
      leaveSession();
      serve.close();
      teardownDone = true;
      await skin.teardown();
    },
  };
};
