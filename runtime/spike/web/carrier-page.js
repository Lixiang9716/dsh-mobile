// dsh:logging-exempt (Presentation-side page: deliberately logs nothing —
// all E2E evidence flows through the runtime logger; there is no logger here)
/**
 * Spike Presentation page for the local-carrier topology. Served as a static
 * file by the host carrier; knows nothing about the host except the WS
 * protocol (the architecture's "it only knows the HTTP/WS protocol" rule).
 * Protocol: hello → (ping → pong)* → push → ack.
 */
const statusEl = document.getElementById('status');
const status = (line) => { statusEl.textContent += line + '\n'; };
const send = (obj) => ws.send(JSON.stringify(obj));
const nonce = Math.random().toString(36).slice(2, 10);
const ws = new WebSocket('ws://' + location.host + '/ws');

ws.onopen = () => {
  status('ws open — hello sent');
  send({ type: 'hello', href: location.href });
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'ping') {
    send({ type: 'pong', nonce: msg.nonce });
    status('ping→pong echoed');
  } else if (msg.type === 'push') {
    send({ type: 'ack', of: 'push', bytes: msg.bytes });
    status('push (' + msg.bytes + 'B) acknowledged');
  }
};
ws.onclose = () => status('ws closed');
