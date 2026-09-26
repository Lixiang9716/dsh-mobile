// dsh:logging-exempt (Presentation-side page: deliberately logs nothing —
// all E2E evidence flows through the runtime/carrier loggers; there is no
// logger here)
/**
 * DSH whale client v0 — the CREATION-MODE plugin: a web client whose page
 * IS the product (a blue whale cruising a deep-ocean scene) while still
 * speaking the same session-projection@0 contract as the other clients.
 * Knows ONLY the loopback HTTP + WS protocol:
 *   → {"type":"hello","href":…,"protocol":"session-projection@0"}
 *   ← {"type":"ws.hello",…} | {"type":"replay","events":[…]}
 *   ← {"kind":"session"|"agent"|"token-delta"|"tool"|"complete"
 *      |"slot.register", …}
 * The whale reacts to the session: token deltas spout bubbles, a complete
 * burst-releases a pod of them, and the transcript rides in a glass panel.
 */
const streamEl = document.getElementById('stream');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const toolbarEl = document.getElementById('toolbar');
const bubblesEl = document.getElementById('bubbles');
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

const scrollDown = () => { streamEl.scrollTop = streamEl.scrollHeight; };
const line = (cls, text) => {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  streamEl.appendChild(div);
  scrollDown();
  return div;
};

/** One rising bubble at a random x, sized 6–14 px. */
const bubble = () => {
  const b = document.createElement('div');
  b.className = 'bubble';
  b.style.left = `${8 + Math.random() * 84}%`;
  const size = 6 + Math.random() * 8;
  b.style.width = `${size}px`;
  b.style.height = `${size}px`;
  b.style.animationDuration = `${4 + Math.random() * 5}s`;
  bubblesEl.appendChild(b);
  setTimeout(() => b.remove(), 9000);
};

/** Token deltas spout a small bubble burst; completion releases a pod. */
let bubblePump = 0;
const spoutBubbles = (count) => {
  for (let i = 0; i < count; i++) {
    setTimeout(bubble, i * 90);
  }
};

const session = { el: null, text: '' };
const beginAssistant = () => {
  if (session.el) return;
  session.el = line('assistant', '');
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
    if (bubblePump++ % 6 === 0) spoutBubbles(2);
  } else if (ev.kind === 'tool') {
    line('sys', `tool ${ev.name} ${ev.phase}`);
  } else if (ev.kind === 'complete') {
    line('sys', `complete ${ev.status} · ${ev.deltas} deltas`);
    spoutBubbles(14);
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
  spoutBubbles(6);
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

// an ambient bubble now and then, even with no session running
setInterval(() => { if (bubblesEl.childElementCount < 7) bubble(); }, 1800);
