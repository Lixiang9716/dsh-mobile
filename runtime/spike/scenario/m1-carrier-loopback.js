/**
 * M1 spike scenario `m1.carrier.loopback` — the local-carrier E2E contract,
 * same discipline as m1-spike-boot: every expected event emits exactly one
 * structured log entry through the unified logger, in the order declared by
 * tools/e2e/scenarios/m1-carrier-loopback.json, and the verdict is a
 * one-to-one expected<->logged match on these lines only.
 *
 * Proves the loopback carrier topology on a host that implements the bus
 * seam (dsh_spike_set_bus_sink / dsh_spike_bus_deliver) plus an HTTP+WS
 * carrier in front of the runtime: static file serving for the Presentation
 * page, a WS connection from that page, the carrier pumping page→JS and
 * JS→page in both directions, with the runtime on its single serial thread.
 * All canonical lines come from THIS module — the carrier transport itself
 * never logs (single-logger discipline); transport facts reach the log only
 * as fields of messages the host delivers here.
 */
import { createLogger } from '../logger.js';

const SCENARIO = 'm1.carrier.loopback';
const log = createLogger('m1.carrier');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const post = (obj) => globalThis.__dshBusPost(JSON.stringify(obj));
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};

const engine = globalThis.__dshEngineInfo();
emit('runtime.created', { engine: engine.name, engineVersion: engine.version });

let pingNonce = null;
let pushedBytes = 0;

globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  switch (msg.type) {
    case 'host.hello': {
      if (!Number.isInteger(msg.port) || msg.port <= 0) {
        fail('carrier delivered no usable port');
        return;
      }
      emit('carrier.listening', { transport: 'tcp', loopback: true });
      break;
    }
    case 'ws.hello': {
      const paths = [...(msg.served ?? [])].sort();
      if (paths[0] !== '/' || paths[1] !== '/carrier-page.js') {
        fail('static assets not served: ' + paths.join(','));
        return;
      }
      emit('carrier.http.served', { paths, count: paths.length });
      emit('carrier.ws.connected', { state: 'open' });
      pingNonce = Math.random().toString(36).slice(2, 10);
      post({ type: 'ws.send', payload: { type: 'ping', nonce: pingNonce } });
      break;
    }
    case 'ws.message': {
      const p = msg.payload ?? {};
      if (p.type === 'pong' && p.nonce === pingNonce) {
        emit('carrier.ws.echo', { matched: true, transport: 'ws' });
        pushedBytes = 64;
        post({
          type: 'ws.send',
          payload: { type: 'push', bytes: pushedBytes, body: 'x'.repeat(pushedBytes) },
        });
      } else if (p.type === 'ack' && p.of === 'push' && p.bytes === pushedBytes) {
        emit('carrier.push.delivered', { transport: 'ws' });
        emit('scenario.complete', { status: 'pass' });
        globalThis.__dshComplete(true, 'ok');
      } else {
        fail('unexpected ws message: ' + JSON.stringify(p));
      }
      break;
    }
    default:
      fail('unexpected bus message type: ' + msg.type);
  }
};

post({ type: 'bus.ready' });
