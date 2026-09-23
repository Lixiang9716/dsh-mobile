// dsh:logging-exempt (loader plumbing)
/** smoke-hooks.mjs — redirect the bundle-root-relative harness specifier
 * (the shape the quickjs host loader serves) to the real file under Node. */
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const ROOT = pathResolve(new URL('../..', import.meta.url).pathname);
const BUNDLE_SCENARIO = {
  'scenario/upstream-test-harness.js': 'runtime/spike/scenario/upstream-test-harness.js',
  'scenario/upstream-fake-timers.js': 'runtime/spike/scenario/upstream-fake-timers.js',
};

export async function resolve(specifier, context, nextResolve) {
  if (BUNDLE_SCENARIO[specifier] !== undefined) {
    return { url: pathToFileURL(pathResolve(ROOT, BUNDLE_SCENARIO[specifier])).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
