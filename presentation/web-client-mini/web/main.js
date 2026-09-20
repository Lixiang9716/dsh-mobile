// dsh:logging-exempt (Presentation-side page: deliberately logs nothing —
// all E2E evidence flows through the runtime/carrier loggers; there is no
// logger here)
/**
 * DSH mini client v0 — the SECOND Web Client variant (UI pluggability, M3):
 * a transcript-only, monospaced amber page proving the host mounts exactly
 * the config-SELECTED client. Knows ONLY the loopback HTTP + WS protocol —
 * the same session-projection@0 vocabulary as dsh-web-client, plus one tiny
 * typed extension point: the toolbar slot. A plugin projects
 * {"kind":"slot.register","id":…,"label":…}; the page renders a toolbar
 * button and ACKS it ({"type":"slot.ack","id":…,"label":…}) so the carrier
 * can evidence the rendered state.
 *   → {"type":"hello","href":…,"protocol":"session-projection@0"}
 *   ← {"type":"ws.hello",…} | {"type":"replay","events":[…]}
 *   ← {"kind":"session"|"agent"|"token-delta"|"tool"|"complete"
 *      |"slot.register", …}
 */
const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const toolbarEl = document.getElementById('toolbar');
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

const scrollDown = () => { streamEl.scrollTop = streamEl.scrollHeight; };
const line = (cls, text) => {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  streamEl.appendChild(div);
  scrollDown();
};

const session = { el: null, text: '' };

const beginAssistant = () => {
  if (session.el) return;
  session.el = line('sys', '');
  session.text = '';
};

const apply = (ev) => {
  if (ev.kind === 'session') {
    line('sys', `session ${ev.id}`);
  } else if (ev.kind === 'agent') {
    line('sys', `agent ${ev.model}`);
    beginAssistant();
  } else if (ev.kind === 'token-delta') {
    beginAssistant();
    session.text += ev.text;
    session.el.textContent = session.text;
    scrollDown();
  } else if (ev.kind === 'tool') {
    line('sys', `tool ${ev.name} ${ev.phase}`);
  } else if (ev.kind === 'complete') {
    line('sys', `complete ${ev.status} · ${ev.deltas} deltas`);
  } else if (ev.kind === 'slot.register') {
    const btn = document.createElement('button');
    btn.id = `slot-${ev.id}`;
    btn.textContent = ev.label;
    toolbarEl.appendChild(btn);
    ws.send(JSON.stringify({ type: 'slot.ack', id: ev.id, label: ev.label, by: ev.by }));
  }
};

const ws = new WebSocket(wsUrl);
ws.onopen = () => {
  dotEl.classList.add('on');
  statusEl.textContent = 'live';
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
