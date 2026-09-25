// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * composer.js — the input deck: auto-growing textarea, send button that
 * morphs into a stop square while the session is generating. Send admits
 * the prompt (session/prompt, mode steer) and returns; the turn streams
 * back over the journal. Stop asks for session/cancel — the mobile
 * runtime does not claim that endpoint yet, so a refusal surfaces as an
 * honest toast, never a faked success.
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

/** The state + DOM of one composer; `submit`/`cancelTurn`/`onSent` ride in
 * from createComposer's closures over this object. */
const makeUi = (root) => {
  const input = root.querySelector('#composer-input');
  const send = root.querySelector('#composer-send');
  const ui = {
    input, send, sessionId: null, running: false, onSent: () => {},
    refresh() {
      send.disabled = ui.running ? false : input.value.trim() === '';
      send.classList.toggle('stop', ui.running);
      send.setAttribute('aria-label', ui.running ? '停止' : '发送');
      send.textContent = ui.running ? '' : '↑';
    },
    autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    },
  };
  return ui;
};

const submit = async (ui, toast) => {
  if (ui.running) return cancelTurn(ui, toast);
  const text = ui.input.value.trim();
  if (text === '' || ui.sessionId === null) return;
  ui.input.value = '';
  ui.autosize();
  ui.refresh();
  try {
    await admitPrompt(ui.sessionId, text);
    ui.onSent(text);
  } catch (error) {
    toast(isRemoteError(error) ? `发送失败（${error.code}）` : '发送失败');
  }
};

const cancelTurn = async (ui, toast) => {
  try {
    await requestCancel(ui.sessionId);
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
  return {
    bind(id) {
      ui.sessionId = id;
      ui.input.value = '';
      ui.autosize();
      ui.refresh();
    },
    setRunning(value) {
      ui.running = value;
      ui.refresh();
    },
    onSent(callback) { ui.onSent = callback; },
    focus() { ui.input.focus(); },
  };
}
