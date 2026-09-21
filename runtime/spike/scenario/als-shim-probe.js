// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * als-shim-probe.js — a SELF-TEST for the node:async_hooks shim's context
 * propagation, and nothing else.
 *
 * Why it exists: the shim approximates AsyncLocalStorage over a frame stack
 * plus a `Promise.prototype.then/catch/finally` patch, so whether a store
 * survives an `await` depends on the ENGINE routing its await continuations
 * through that patched method. `dsh-agent` scopes the initiating Agent that
 * way and the agent loop reads it when it executes a tool call, so a lost
 * context is invisible until a tool runs — which is exactly how it presented
 * (a plain turn worked; the first tool call failed with "no initiating agent
 * is active").
 *
 * This probe answers the engine question directly, with no model, no tools
 * and no carrier in the way. Each record names the boundary it crossed:
 *   run-inside      — synchronous, inside run()
 *   await-bare      — after `await Promise.resolve()`
 *   await-executor  — after `await new Promise(resolve => resolve())`
 *   await-nested    — returned out of a nested async IIFE
 *   after-run       — outside run(): MUST be carried=false
 */
import { createLogger } from 'logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const log = createLogger('als.probe');
const als = new AsyncLocalStorage();

const check = (label, store) => {
  log.info('probe', {
    label,
    carried: store !== undefined && store !== null,
    mark: store?.mark ?? null,
  });
};

const main = async () => {
  await als.run({ mark: 'X' }, async () => {
    check('run-inside', als.getStore());
    await Promise.resolve();
    check('await-bare', als.getStore());
    await new Promise((resolve) => resolve());
    check('await-executor', als.getStore());
    const nested = await (async () => {
      await Promise.resolve();
      return als.getStore();
    })();
    check('await-nested', nested);
  });
  check('after-run', als.getStore());
};

main().catch((error) => {
  log.error('probe failed', { reason: `${error?.message ?? error}` });
});
