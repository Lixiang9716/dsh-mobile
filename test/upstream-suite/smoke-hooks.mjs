// dsh:logging-exempt (loader plumbing)
/** smoke-hooks.mjs — redirect the bundle-root-relative harness specifier
 * (the shape the quickjs host loader serves) to the real file under Node. */
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const ROOT = pathResolve(new URL('../..', import.meta.url).pathname);
const HARNESS_URL = pathToFileURL(pathResolve(ROOT, 'runtime/spike/scenario/upstream-test-harness.js')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'scenario/upstream-test-harness.js') {
    return { url: HARNESS_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
