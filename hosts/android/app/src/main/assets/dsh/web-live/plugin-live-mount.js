// dsh:logging-exempt? no — this module logs through the seat's emit face.
/**
 * web-live/plugin-live-mount.js — the creation-mode mount hook for the
 * composer seats, split from composer-web-live.js at the code-size gate:
 * when a turn settles and the session authored a plugin tree
 * (plugins/pomodoro-clock/ — the pomodoro scripted round writes it; a REAL
 * endpoint's turn may author any tree the manifest grammar accepts), the
 * seat drives approve → live mount → the plugin's own native surface. The
 * approval is the checkpoint boundary (plugin-mount.js asks
 * presentApproval; the official seat dispatches it to the native dialog).
 *
 * The latch is step-aware: a mounted plugin never remounts this boot; a
 * REAL refusal (declined / invalid / failed link) never re-prompts; an
 * ABSENT tree is not an attempt — the next turn may author it.
 */
import { mountWorkspacePlugin } from 'plugin-mount.js';
import { createLogger } from 'logger.js';

const log = createLogger('dsh.pluginLiveMount');

/** The workspace prefix from the boot config (the pinned-globals
 * derivation is absent on seats that never chdir — the official seat
 * passes its boot config's containerRoot/scopeRoot derivation instead). */
const prefixOf = (cfg) => {
  log.debug('prefix derive', {});
  if (typeof cfg?.containerRoot !== 'string' || typeof cfg?.fsScopeRoot !== 'string') {
    return undefined;
  }
  if (!cfg.containerRoot.startsWith(cfg.fsScopeRoot)) return undefined;
  return cfg.containerRoot.slice(cfg.fsScopeRoot.length)
    .replace(/^\/+/g, '').replace(/\/+$/g, '');
};

const SPECS = ['pomodoro-clock'];

/** The per-spec outcome handler: the step-aware latch (mounted → latch;
 * a real refusal → latch; an absent tree → silent retry next turn). */
const onOutcome = (attempted, emit, session, spec) => (outcome) => {
  if (outcome.mounted) {
    attempted.add(spec); // mounted: never remount this boot
    emit('write.plugin.mounted', {
      sessionId: session?.id ?? null, spec, version: outcome.version });
    return;
  }
  if (outcome.step === 'read') {
    return; // an absent tree is not an attempt — the next turn may author it
  }
  attempted.add(spec); // a real refusal (declined, invalid, failed link)
  emit('write.plugin.refused', {
    sessionId: session?.id ?? null, spec, step: outcome.step,
    reason: outcome.reason });
};

/** Install on the spine context: probes the authored trees at turn/end. */
export const installCreationMount = (ctx, cfg, emit) => {
  log.debug('install creation mount', {});
  const attempted = new Set();
  const prefix = prefixOf(cfg);
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    for (const spec of SPECS) {
      if (attempted.has(spec)) continue;
      const onCaught = (error) => {
        attempted.add(spec);
        emit('write.plugin.mount-failed', {
          spec, reason: error?.message ?? String(error) });
      };
      mountWorkspacePlugin(ctx, spec, { prefix })
        .then(onOutcome(attempted, emit, session, spec))
        .catch(onCaught);
    }
  });
};
