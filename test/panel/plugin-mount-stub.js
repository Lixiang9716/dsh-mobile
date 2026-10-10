// The panel suite's plugin-manager tests exercise REGISTRY semantics; the
// LIVE mount chain needs the C host's loader seam (__dshModuleDefine) and
// the gateway primitives — on-device territory, proven end-to-end by the
// plugin.forms CLI leg (runtime/dsh/ci/run-plugin-forms-e2e.sh). This stub
// keeps web-write-plugin-manager's import graph resolvable under vitest:
// isMounted() always false means the remove face's live-dispose branch is
// skipped, exactly like removing a plugin that was never live-mounted.
export const isMounted = () => false;
export const unmountWorkspacePlugin = async (spec) => (
  { unmounted: false, step: 'live', spec, reason: 'not mounted (stub)' });
export const mountWorkspacePlugin = async (spec) => (
  { mounted: false, step: 'context', spec, reason: 'no cordis context (stub)' });
export const mountAfterTurn = async () => [];
export const mountEnabledRegistry = async () => ({ ok: true, mounted: [], refused: [] });
export const mountBootRows = async () => {};
