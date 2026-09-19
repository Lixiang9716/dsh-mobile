// dsh:logging-exempt (Presentation-side page: deliberately logs nothing —
// all E2E evidence flows through the runtime/carrier loggers; there is no
// logger here)
/**
 * DSH Web Client v0 — the "UI is a plugin" acceptance criterion.
 *
 * Knows ONLY the loopback HTTP + WS protocol (zero host awareness): it
 * derives the WS URL from its own location, says hello, and renders the
 * session projection events it receives. Protocol session-projection@0:
 *   → {"type":"hello","href":…,"protocol":"session-projection@0"}
 *   ← {"type":"ws.hello",…} | {"type":"replay","events":[…]}
 *   ← {"kind":"session"|"agent"|"token-delta"|"tool"|"complete", …}
 * Token deltas append into the live transcript; tool and system events
 * render as their own lines; "complete" closes the message.
 */
const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');

const scrollDown = () => { streamEl.scrollTop = streamEl.scrollHeight; };
const line = (cls, text) => {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  streamEl.appendChild(div);
  scrollDown();
  return div;
};

const session = { el: null, text: '' };

const beginAssistant = () => {
  if (session.el) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = 'assistant';
  const body = document.createElement('div');
  wrap.appendChild(role);
  wrap.appendChild(body);
  streamEl.appendChild(wrap);
  session.el = body;
  session.text = '';
};

const apply = (ev) => {
  if (ev.kind === 'session') {
    line('sys', `session ${ev.id} · scope ${ev.scope}`);
  } else if (ev.kind === 'agent') {
    line('sys', `agent · model ${ev.model} · tools ${ev.tools}`);
    beginAssistant();
  } else if (ev.kind === 'token-delta') {
    beginAssistant();
    session.text += ev.text;
    session.el.textContent = session.text;
    scrollDown();
  } else if (ev.kind === 'tool') {
    line('tool', `tool ${ev.name} — ${ev.phase}${ev.ok === false ? ' FAILED' : ''}`);
  } else if (ev.kind === 'complete') {
    line('sys', `session complete — status ${ev.status} · ${ev.deltas} deltas · `
      + `${ev.toolCalls} tool call(s)`);
  }
};

const ws = new WebSocket(
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

ws.onopen = () => {
  dotEl.classList.add('on');
  statusEl.textContent = 'connected';
  ws.send(JSON.stringify(
    { type: 'hello', href: location.href, protocol: 'session-projection@0' }));
};
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === 'ws.hello') {
    statusEl.textContent = 'session channel live';
  } else if (msg.type === 'replay') {
    (msg.events ?? []).forEach(apply); // buffered projection from before connect
  } else if (msg.kind) {
    apply(msg);
  }
};
ws.onclose = () => {
  dotEl.classList.remove('on');
  statusEl.textContent = 'disconnected';
};
