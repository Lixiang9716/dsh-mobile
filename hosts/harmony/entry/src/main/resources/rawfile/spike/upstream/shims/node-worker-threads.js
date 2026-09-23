// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:worker_threads — the errors-only linkage shim. This runtime is
 * single-process by constitution (D2): there is no thread to spawn. The
 * vendored spine's own browser path makes the same move ("the browser
 * worker stubs the native flock entry to immediate success: it is
 * single-process, so the in-process write claim already excludes every
 * writer" — session-persistence-jsonl/lease). Construction fails LOUD
 * naming the in-process alternative; module-level imports (Worker,
 * parentPort, workerData) resolve so the importing module loads.
 */
const failLoud = () => {
  throw new Error(
    'worker_threads: this runtime is single-process (D2) — Worker spawn is '
    + 'unavailable; upstream\'s browser path replaces the worker with an '
    + 'in-process equivalent (see session-persistence-jsonl/lease)',
  );
};
export class Worker {
  constructor() { failLoud(); }
  postMessage() { failLoud(); }
  terminate() { return Promise.reject(new Error('worker_threads: unavailable')); }
  once() { return this; }
  on() { return this; }
}
export const parentPort = null;
export const workerData = undefined;
export const isMainThread = true;
export default { Worker, parentPort, workerData, isMainThread };
