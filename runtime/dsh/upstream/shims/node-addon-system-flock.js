// dsh:logging-exempt (host shim: no side effects to log)
/**
 * @deepseek-ai/node-addon-system/flock — the errors-only linkage shim,
 * upstream's own single-process semantics (their webworker runtime ships
 * the same replacement: "The JSONL backend's in-process write claim already
 * excludes every writer, so its kernel-lock request succeeds without
 * acquiring another resource"). The spike runtime is single-process by
 * construction — the same argument holds verbatim.
 */
export const __esModule = true;
export async function tryLockExclusive() {
  return undefined;
}
export default { tryLockExclusive };
