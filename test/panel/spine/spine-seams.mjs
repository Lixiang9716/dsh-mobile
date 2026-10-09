// spine-seams.mjs — the MAIN-THREAD half of the spine suite's host seams.
// register()'s loader-hook bootstrap runs in the loader worker, whose
// globals the runtime code never sees (smoke.mjs's measured note), so every
// `globalThis.__dsh*` seam the runtime touches is installed HERE, in the
// test process, before boot.js loads.
//
// Staged here:
//   - __dshModuleDefine — the runtime-module seam the npm-bridges register
//     through; definitions land in .runtime-modules/ as ESM files the
//     loader hooks resolve (same replay semantics as the host C seam: a
//     second define for a name replaces the source).
//   - __dshBundleRequire — the bundle-read seam (cjs-loader.js +
//     node-module.js): base is '<dsh-dir>/__dsh_cjs_anchor__', request is
//     './<path under dir>'; serves UTF-8 text from the runtime/vendor tree.
//   - __dshGatewayCall — every primitive fails loud; httpFetch is staged
//     per-test (stagedHttp) against the GLM-shaped SSE fixture server.
import { join, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers';
import { createRequire } from 'node:module';

const HERE = pathResolve(fileURLToPath(new URL('.', import.meta.url)));
export const RUNTIME_DSH = pathResolve(HERE, '..', '..', '..', 'runtime', 'dsh');

// ---- the engine's async-context slot (node:async_hooks shim) --------------
// The shims' AsyncLocalStorage reads the ENGINE's slot through
// __asyncContextGet/Set (quickjs-ng dsh-async-context). Node's own
// AsyncLocalStorage propagates across its timers/promises the same way, so
// the slot stores the frames array and Node carries it.
const asyncSlot = new NodeAsyncLocalStorage();
globalThis.__asyncContextGet = () => asyncSlot.getStore();
globalThis.__asyncContextSet = (frames) => asyncSlot.enterWith(frames);

// The gateway timer seam's arm table (timerSchedule/timerCancel above).
const armedTimers = new Map();
let timerSeq = 0;

/** Clear every armed seam timer and the staged http handlers — the spine's
 * watchdog re-arms a standing timer, which would keep the node --test event
 * loop alive for its full budget after the tests pass. */
export const disposeSeams = () => {
  for (const t of armedTimers.values()) nodeClearTimeout(t);
  armedTimers.clear();
  stagedHttp.clear();
};

// ---- __dshModuleDefine (npm-bridges registration seam) --------------------
// The drop dir lives under runtime/dsh/node_modules (gitignored) so the
// bridge sources' bare 'upstream/…' imports resolve through the farm —
// from the suite dir they would not.
const DEFINE_DIR = join(RUNTIME_DSH, 'node_modules', '.spine-defines');
rmSync(DEFINE_DIR, { recursive: true, force: true });
mkdirSync(DEFINE_DIR, { recursive: true });

globalThis.__dshModuleDefine = (name, source) => {
  writeFileSync(join(DEFINE_DIR, `${encodeURIComponent(name)}.mjs`), source);
};

// ---- __dshBundleRequire (bundle disk reads) -------------------------------
globalThis.__dshBundleRequire = (base, request) => {
  const dir = base.slice(0, base.lastIndexOf('/'));
  const abs = `${dir}/${request.replace(/^\.\//, '')}`;
  const diskPath = join(RUNTIME_DSH, abs.replace(/^\//, ''));
  try {
    return readFileSync(diskPath, 'utf8');
  } catch (error) {
    throw new Error(`bundle-read miss: ${abs} (${error?.message ?? error})`);
  }
};

// ---- __dshGatewayCall (loud-fail + per-test httpFetch staging) ------------
export const stagedHttp = new Map(); // url prefix → (args) => { status, headers, bodyId }

/** A REAL httpFetch over Node's own http/https — the byok live-leg staging:
// the gateway contract's streaming shape (http.body/http.end events keyed by
// bodyId) served from an actual socket, so a repro can run the REAL backend
// wire. Never logs credentials; bodies ride base64 as on the device. */
let realBodySeq = 0;
export const stageRealHttpFetch = () => {
  const { request: httpsRequest } = createRequire(import.meta.url)('node:https');
  stagedHttp.set('https://', (args) => new Promise((resolveStage, rejectStage) => {
    const body = args.bodyB64 !== undefined
      ? Buffer.from(args.bodyB64, 'base64') : undefined;
    const req = httpsRequest(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers ?? {},
    }, (res) => {
      const bodyId = `body:real-${++realBodySeq}`;
      resolveStage({ status: res.statusCode, headers: res.headers, bodyId });
      res.on('data', (chunk) => {
        globalThis.__dshGatewayOnEvent(JSON.stringify({
          callId: bodyId, event: 'http.body',
          chunkB64: chunk.toString('base64'),
        }));
      });
      res.on('end', () => {
        globalThis.__dshGatewayOnEvent(JSON.stringify({
          callId: bodyId, event: 'http.end',
        }));
      });
      res.on('error', (error) => {
        globalThis.__dshGatewayOnEvent(JSON.stringify({
          callId: bodyId, event: 'http.error',
          code: 'io', message: error?.message ?? 'response failed',
        }));
      });
    });
    req.on('error', (error) => rejectStage(
      Object.assign(new Error(`real httpFetch failed: ${error?.message ?? error}`),
        { code: 'io' })));
    if (body !== undefined) req.write(body);
    req.end();
  }));
};

globalThis.__dshGatewayCall = async (name, argsJson) => {
  if (name === 'httpFetch') {
    const args = JSON.parse(argsJson);
    for (const [prefix, handler] of stagedHttp) {
      if (args.url.startsWith(prefix)) return handler(args);
    }
    throw Object.assign(
      new Error(`httpFetch not staged: ${args.url}`), { code: 'unavailable' });
  }
  // The timers shim's gateway seam (contract v1.4.0): real Node timers play
  // the host's timerSchedule/timerCancel; fires ride the §5 channel.
  if (name === 'timerSchedule') {
    const { delayMs } = JSON.parse(argsJson);
    const timerId = ++timerSeq;
    const t = nodeSetTimeout(() => {
      armedTimers.delete(timerId);
      globalThis.__dshGatewayOnEvent(JSON.stringify({ event: 'timer.fire', timerId }));
    }, Math.max(0, Number(delayMs) || 0));
    armedTimers.set(timerId, t);
    return { timerId };
  }
  if (name === 'timerCancel') {
    const { timerId } = JSON.parse(argsJson);
    const t = armedTimers.get(timerId);
    if (t !== undefined) {
      nodeClearTimeout(t);
      armedTimers.delete(timerId);
    }
    return {};
  }
  throw Object.assign(
    new Error(`gateway ${name} not staged in the spine suite`), { code: 'unimplemented' });
};
