// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * composer.js — the input deck: auto-growing textarea, send button that
 * morphs into a stop square while the session is generating. Send admits
 * the prompt (session/prompt, mode steer) and returns; the turn streams
 * back over the journal. The stop affordance is OPTIMISTIC — the button
 * morphs the moment a prompt is admitted, because journal frames can
 * arrive as one burst and the button must not wait for them; the
 * optimistic state retires on the fold's live signal or a 12s watchdog.
 * Stop asks for session/cancel (claimed 2026-09-25, upstream commands.
 * cancel semantics); failures surface as an honest toast, never faked.
 */

import { rpc, isRemoteError } from './api.js';

const mintRequestId = () =>
  (crypto.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`);

const admitPrompt = (sessionId, text) => rpc('session/prompt', {
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

const requestCancel = (sessionId) =>
  rpc('session/cancel', { args: { request: { sessionId } } });

/** The state + DOM of one composer. `generating` = the fold reports a live
 * turn OR a prompt of ours was admitted and has not settled yet. */
const makeUi = (root) => {
  const input = root.querySelector('#composer-input');
  const send = root.querySelector('#composer-send');
  const ui = {
    input, send, sessionId: null, running: false, optimistic: false,
    onSent: () => {},
    get generating() { return ui.running || ui.optimistic; },
    refresh() {
      send.disabled = ui.generating ? false : input.value.trim() === '';
      send.classList.toggle('stop', ui.generating);
      send.setAttribute('aria-label', ui.generating ? '停止' : '发送');
      send.textContent = ui.generating ? '' : '↑';
    },
    autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    },
  };
  return ui;
};

const submit = async (ui, toast) => {
  if (ui.generating) return cancelTurn(ui, toast);
  const text = ui.input.value.trim();
  if (text === '' || ui.sessionId === null) return;
  ui.input.value = '';
  ui.autosize();
  ui.optimistic = true;
  ui.refresh();
  try {
    await admitPrompt(ui.sessionId, text);
    // The optimistic state retires on the fold's live running signal; the
    // watchdog covers burst-delivered turns that skip it entirely.
    setTimeout(() => { ui.optimistic = false; ui.refresh(); }, 12000);
    window.__dshSentCount = (window.__dshSentCount ?? 0) + 1;
    ui.onSent(text);
  } catch (error) {
    ui.optimistic = false;
    window.__dshSendError = (isRemoteError(error)
      ? `${error.code}` : 'transport');
    toast(isRemoteError(error) ? `发送失败（${error.code}）` : '发送失败');
  }
};

const cancelTurn = async (ui, toast) => {
  try {
    await requestCancel(ui.sessionId);
    // A confirmed cancel retires the optimistic state: the affordance's job
    // is done, and a cancelled/never-started turn may never deliver the
    // fold's live running signal that would otherwise retire it.
    ui.optimistic = false;
    ui.refresh();
    toast('已请求停止');
  } catch (error) {
    toast(isRemoteError(error)
      ? `此主机暂不支持取消（${error.code}）` : '取消失败');
  }
};

const wireComposer = (ui, toast) => {
  ui.send.addEventListener('click', () => submit(ui, toast));
  ui.input.addEventListener('input', () => { ui.autosize(); ui.refresh(); });
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(ui, toast);
    }
  });
};

export function createComposer(root, toast) {
  const ui = makeUi(root);
  wireComposer(ui, toast);
  // The diagnostic face the on-device probe reads in failure forensics.
  if (typeof window !== 'undefined') {
    window.__dshComposerDebug = () => ({
      running: ui.running, optimistic: ui.optimistic,
      sessionId: ui.sessionId, disabled: ui.send.disabled,
      text: ui.input.value});
  }
  return {
    bind(id) {
      ui.sessionId = id;
      ui.input.value = '';
      ui.autosize();
      ui.refresh();
    },
    setRunning(value) {
      ui.running = value;
      if (value) ui.optimistic = false; // the live signal retires optimism
      ui.refresh();
    },
    onSent(callback) { ui.onSent = callback; },
    focus() { ui.input.focus(); },
  };
}
