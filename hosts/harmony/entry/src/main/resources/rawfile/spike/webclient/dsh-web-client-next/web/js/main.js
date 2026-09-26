// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * main.js — wiring: the mux connection, the two views (home ↔ chat), the
 * timeline subscription (structure renders rebuild the list; tail renders
 * coalesce to one per animation frame, with a timer fallback for throttled
 * webviews), and the composer. The page knows only the loopback HTTP + WS
 * protocol — zero host awareness.
 */

import { rpc, isRemoteError } from './api.js';
import { Mux, muxDiag } from './mux.js';
import { createTimeline } from './timeline.js';
import { createChatRenderer } from './render-chat.js';
import { renderConnection, renderSessionList } from './render-home.js';
import { createComposer } from './composer.js';

const $ = (id) => document.getElementById(id);

const views = { home: $('view-home'), chat: $('view-chat') };
const toastNode = $('toast');
let toastTimer = 0;

const toast = (text) => {
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2600);
};

const shortId = (sessionId) => String(sessionId).slice(0, 8);

const composer = createComposer($('composer'), toast);
const mux = new Mux();

let connState = 'connecting';
let activeSessionId = null;
let timeline = null;
let renderer = null;
let followStream = null;

// ---- chrome --------------------------------------------------------------

const refreshChrome = () => {
  if (timeline === null) return;
  const title = typeof timeline.meta.title === 'string'
    && timeline.meta.title !== '' ? timeline.meta.title : shortId(activeSessionId);
  $('chat-title').textContent = title;
  const running = timeline.running;
  composer.setRunning(running);
  if (running) $('chat-status').textContent = '生成中';
  else if (connState === 'closed') $('chat-status').textContent = '连接断开';
  else if (connState !== 'open') $('chat-status').textContent = '重连中…';
  else $('chat-status').textContent = '';
};

// ---- home ----------------------------------------------------------------

const refreshSessions = async () => {
  try {
    const value = await rpc('session/list');
    renderSessionList(
      $('session-list'), $('session-list-empty'),
      Array.isArray(value?.items) ? value.items : [],
      openSession);
  } catch (error) {
    toast(isRemoteError(error) ? `会话列表不可用（${error.code}）` : '会话列表不可用');
  }
};

const showView = (name) => {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
};

const onConnStatus = (status) => {
  connState = status;
  renderConnection($('conn-capsule'), status);
  refreshChrome();
  if (status === 'open') refreshSessions();
};
mux.onStatus(onConnStatus);

$('new-session').addEventListener('click', async () => {
  try {
    const value = await rpc('session/create', { args: { request: {} } });
    const sessionId = value?.sessionId;
    if (typeof sessionId !== 'string') throw new Error('no sessionId');
    openSession(sessionId);
  } catch (error) {
    toast(isRemoteError(error) ? `创建失败（${error.code}）` : '创建失败');
  }
});

$('back-home').addEventListener('click', () => {
  leaveSession();
  showView('home');
  refreshSessions();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !views.home.hidden) refreshSessions();
});

// ---- chat ----------------------------------------------------------------

const leaveSession = () => {
  if (followStream !== null) {
    mux.cancel(followStream);
    followStream = null;
  }
  timeline = null;
  renderer = null;
  activeSessionId = null;
};

const openSession = (sessionId) => {
  leaveSession();
  activeSessionId = sessionId;
  timeline = createTimeline();
  timeline.subscribe((kind) => {
    if (renderer === null) return;
    // Both kinds render SYNCHRONOUSLY from the network event — the
    // official page's model. A rAF/timer-coalesced tail never fires in a
    // throttled or occluded WKWebView (the drive's WebView is exactly
    // that), and the frame cadence here is human-paced anyway.
    if (kind === 'structure') renderer.renderStructure(timeline);
    else renderer.renderTail(timeline);
    refreshChrome();
  });
  renderer = createChatRenderer($('transcript'), $('jump-latest'));
  renderer.renderStructure(timeline);
  composer.bind(sessionId);
  showView('chat');
  composer.focus();
  followStream = mux.open('session/follow', {
    args: { request: { address: { sessionId }, assistantStream: true } },
  }, {
    onItem: (value) => timeline.applyRecord(value),
    onError: (error) => {
      toast(`会话流不可用（${error?.code ?? 'unknown'}）`);
      leaveSession();
      showView('home');
    },
    onEnd: () => { followStream = null; },
  });
};

// The creation viewer: a presented workspace file, fetched over the
// claimed workspaceFiles/read leg and shown fullscreen in a sandboxed
// frame — the on-screen half of the creation-mode loop.
const creationView = $('creation-view');
const openCreation = async (path, title) => {
  $('creation-title-text').textContent = title || path;
  creationView.hidden = false;
  try {
    // readAll: one complete-file read (the paginated read's streamText
    // waits on a data event an in-memory just-created file never sends).
    // The files family takes its parameters at args level directly (only
    // the session family wraps them in args.request); its result carries
    // base64 bytes, decoded here as UTF-8 (the deliverables are text).
    const value = await rpc('workspaceFiles/readAll', {
      args: { path },
    });
    let text = '';
    if (typeof value === 'string') text = value;
    else if (typeof value?.text === 'string') text = value.text;
    else if (typeof value?.data === 'string') {
      const bytes = Uint8Array.from(atob(value.data), (ch) => ch.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    }
    document.getElementById('creation-frame').srcdoc = text;
  } catch (error) {
    creationView.hidden = true;
    toast(isRemoteError(error) ? `创作不可读（${error.code}）` : '创作不可读');
  }
};
document.addEventListener('dsh-open-creation', (event) => {
  openCreation(event.detail.path, event.detail.title);
});
$('creation-close').addEventListener('click', () => {
  creationView.hidden = true;
  document.getElementById('creation-frame').srcdoc = '';
});

composer.onSent(() => {
  // The durable user/message echoes over the journal; nothing optimistic
  // to add — the send clears the input and the turn streams live.
});

// ---- boot ----------------------------------------------------------------

// The diagnostic face the on-device probe reads in failure forensics.
window.__dshTimelineDebug = () => ({
  sessionId: activeSessionId,
  rendererAlive: renderer !== null,
  items: timeline?.items.length ?? -1,
  tail: !!timeline?.tail,
  kind: timeline?.items.at(-1)?.kind ?? 'none',
  kinds: timeline?.items.map((item) => item.kind).join(',') ?? '',
  mux: { frames: muxDiag.frames, routed: muxDiag.routed,
    dropped: muxDiag.dropped, throws: muxDiag.throws, closes: muxDiag.closes },
  notify: timeline?.notifyDebug ?? null,
});
window.__dshForceRender = () => renderer?.renderStructure(timeline);

showView('home');
mux.connect();
refreshSessions();
