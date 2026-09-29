// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * Scenario `socket.seam` (contract v1.8.0, decision D-d) — the desktop-CLI
 * evidence leg for the loopback socket seam. Every expected event emits
 * exactly one structured log entry through the unified logger, in the order
 * declared by test/e2e/scenarios/socket-seam-local.json.
 *
 * Three legs, in a fixed order:
 *   1. `server.echo` — net.createServer → listen(0) (the host picks the
 *      port; the resolved port is the source of truth) → net.connect → a
 *      byte roundtrip → half-close (`end`) → the peer's EOF — the
 *      in-one-scenario server+client shape the adopted proposal's
 *      verification plan names.
 *   2. `subprocess.dial` — the shape that MOTIVATED the seam: a spawned OS
 *      child (/bin/bash + /dev/tcp — no extra tooling) dials the in-test
 *      server; the bytes cross a real kernel socket between two OS
 *      processes, which the in-process dispatch cannot carry.
 *   3. `grant.denied` — out-of-scope requests refuse loud: a `lan` scope
 *      listen and a non-literal-loopback connect both reject `denied`
 *      (the five-rule model's narrowest-scope default, exercised with zero
 *      prompts and zero interaction).
 *
 * The gateway audit records (one per listen/connect/accept, denied attempts
 * included) live on the host's stderr as structured JSON lines;
 * test/e2e/run-socket-seam.sh greps them beside this log the same way
 * run-ios.sh drives gateway-audit.
 */
import 'upstream/shims/globals.js'; // MUST be first: the node:net / node:child_process faces register through the shim chain (globals → runtime-modules, THEN the npm-bridges microtask defines replace the stub rows) — the dynamic imports below resolve AFTER that chain has evaluated (a static import would instantiate before the registration runs, exactly the timing the suite leg's late awaits respect)
import 'upstream/shims/npm-bridges.js';
import 'upstream/shims/timers.js'; // the pump's 4ms re-arming tick rides the timers seam (an absent global setTimeout would kill every schedule silently)
import { createLogger } from '../logger.js';
import { socketListen, socketConnect } from '../gateway.js';

const SCENARIO = 'socket.seam';
const log = createLogger('dsh.socket.seam');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
let done = false;
const finish = (ok, reason) => {
  if (done) return;
  done = true;
  if (!ok) emit('scenario.failed', { reason: String(reason).slice(0, 300) });
  globalThis.__dshComplete(ok, String(reason).slice(0, 300));
};
const fail = (reason) => {
  log.debug('scenario failed', { reason: String(reason).slice(0, 200) });
  finish(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return true;
  fail(reason);
  throw new Error(reason);
};

const once = (emitter, event) => new Promise((resolve, reject) => {
  const ok = (v) => { cleanup(); resolve(v); };
  const bad = (e) => { cleanup(); reject(e); };
  const cleanup = () => {
    emitter.off(event, ok);
    emitter.off('error', bad);
  };
  emitter.once(event, ok);
  emitter.once('error', bad);
});

const drain = (socket) => new Promise((resolve) => {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  socket.on('end', () => resolve(chunks.join('')));
  socket.on('close', () => resolve(chunks.join('')));
});

/** Leg 1: an echo server and its client, both in this scenario, over REAL
 * loopback TCP — the host picks the port, the resolved port is the truth. */
const legEcho = async (net) => {
  const server = net.createServer((socket) => {
    emit('socket.server.connection', { from: `${socket.remoteAddress}:${socket.remotePort}` });
    socket.on('data', (chunk) => {
      emit('socket.server.data', { bytes: chunk.byteLength });
      socket.write(chunk); // echo
      socket.end(); // echo server: one roundtrip per connection, then FIN
    });
  });
  const listenP = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listenP;
  const port = server.address().port;
  demand(Number.isInteger(port) && port > 0, `server.listen did not resolve a real port (${port})`);
  emit('socket.server.listening', { port, pickedBy: 'host' });

  const client = net.connect(port, '127.0.0.1');
  const connectP = once(client, 'connect');
  const clientSeen = drain(client);
  await connectP;
  emit('socket.client.connected', { to: `127.0.0.1:${port}` });

  await new Promise((resolve) => client.write('ping-over-loopback', () => resolve()));
  emit('socket.client.wrote', { bytes: 18 });
  const echoed = await clientSeen;
  demand(echoed === 'ping-over-loopback', `echo mismatch: got "${echoed.slice(0, 40)}"`);
  emit('socket.client.data', { text: echoed });

  const endP = once(client, 'close');
  client.end();
  await endP;
  emit('socket.client.closed', { halfClose: true });
  server.close();
  emit('socket.server.closed', {});
};

/** Leg 2: the motivating shape — a spawned OS child (/bin/bash's /dev/tcp)
 * dials the in-test server; the ack the child reads back proves bytes
 * crossed a kernel socket between two OS processes. */
const legSubprocess = async (net, spawn) => {
  const server = net.createServer((socket) => {
    emit('socket.subprocess.connection', { from: `${socket.remoteAddress}:${socket.remotePort}` });
    socket.on('data', (chunk) => {
      emit('socket.subprocess.data', { text: chunk.toString('utf8') });
      socket.write('ack-from-server');
      socket.end();
    });
  });
  const listenP = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listenP;
  const port = server.address().port;
  emit('socket.subprocess.listening', { port });

  const child = spawn('/bin/bash', [
    '-c',
    `exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'hello-from-child' >&3 && head -c 15 <&3`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  let childErr = '';
  child.stdout.on('data', (c) => { childOut += c.toString('utf8'); });
  child.stderr.on('data', (c) => { childErr += c.toString('utf8'); });
  const exitCode = await once(child, 'exit');
  demand(exitCode === 0, `subprocess dial exited ${exitCode} (${childErr.slice(0, 120)})`);
  demand(childOut === 'ack-from-server', `subprocess read "${childOut.slice(0, 40)}"`);
  emit('socket.subprocess.roundtrip', { sent: 'hello-from-child', received: childOut, exitCode });
  server.close();
  emit('socket.subprocess.closed', {});
};

/** Leg 3: the five-rule model's narrowest-scope default, exercised — a
 * `lan` listen and a non-loopback dial both reject `denied`, with zero
 * prompts and zero interaction. */
const legDenials = async () => {
  let denied = null;
  try {
    denied = await socketListen({ scope: 'lan' }).then(() => null, (e) => e);
  } catch (error) {
    denied = error;
  }
  demand(denied && denied.code === 'denied',
    `a lan-scope listen was not denied (${denied ? denied.code : 'resolved'})`);
  emit('socket.grant.denied', { request: 'listen scope=lan', code: 'denied' });

  let denied2 = null;
  try {
    denied2 = await socketConnect({ scope: 'loopback', host: '10.0.0.1', port: 80 }).then(() => null, (e) => e);
  } catch (error) {
    denied2 = error;
  }
  demand(denied2 && denied2.code === 'denied',
    `a non-loopback connect was not denied (${denied2 ? denied2.code : 'resolved'})`);
  emit('socket.connect.denied', { request: 'connect host=10.0.0.1', code: 'denied' });
};

const run = async () => {
  // The node faces ride the shim registration chain (see the first import);
  // these dynamic imports are what keep that order honest at run time.
  const { default: net } = await import('node:net');
  const { spawn } = await import('node:child_process');
  emit('socket.started', { scenario: SCENARIO });
  await legEcho(net);
  await legSubprocess(net, spawn);
  await legDenials();
  emit('socket.passed', { legs: 3 });
  finish(true, 'socket seam legs green');
};

run().catch((error) => fail(error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error));
