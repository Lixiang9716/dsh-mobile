// dsh:logging-exempt (this file MEASURES the unified sink — it drives every
// emitter and asserts on what arrives; logging through createLogger would
// write into the very channel under test and make the measurement false)
/**
 * The SINKS probe: every emitter that writes to `__DSH_LOG_SINK__` is driven
 * once per level, so the release strip is proven on the ROUTES, not only on
 * the canonical createLogger. The 2026-09-21 audit found the strip holding
 * only because the vendored closure happened to contain zero `console.*`
 * calls — a policy living in one file while its siblings write unconditionally
 * rests on upstream's silence, not on the flag. This probe removes that
 * dependence: it makes the siblings loud.
 *
 * Three routes, one record each per level:
 *   1. probe.sink          — createLogger (the canonical logger.js)
 *   2. upstream.console    — the forwarding console in upstream/web-shims.js
 *                            (console.log/info → info, debug → debug, warn and
 *                            error verbatim — the mapping that ships)
 *   3. cordis:probe.boot   — the cordis logger exporter in upstream/boot.js
 *                            (wireLogger, driven by a REAL cordis Context)
 *
 * Assertions (fail loud — rules.md rule 5), for EVERY route:
 *   debug build   : all four levels reach the sink (exactly 1 each)
 *   release build : warn + error only; ZERO debug/info, and the kept set is
 *                   exactly RELEASE_CRITICAL_LEVELS — the declared policy and
 *                   the observed behavior cannot drift apart.
 *
 * Runs on the desktop CLI from the bundle root (host/build.sh + --release):
 *   build/dsh-spike-cli [--release] . <this file>
 * The bundle root is runtime/spike, so the probe imports the CANONICAL
 * logger/shims/boot — no staged copy can drift. Records pass through
 * unchanged (tee), so the raw capture is the stream the host itself printed.
 */
import { Context } from '@deepseek-ai/cordis';
import { createLogger, RELEASE_CRITICAL_LEVELS, releaseKeeps } from 'logger.js';
import 'upstream/web-shims.js';
import { wireLogger } from 'upstream/boot.js';

const ROUTES = [
  // createLogger: one call per level.
  { id: 'logger', module: 'probe.sink', expect: { debug: 1, info: 1, warn: 1, error: 1 } },
  // The forwarding console's SHIPPING level mapping: log/info → level info,
  // debug → level debug, warn and error verbatim. That is 5 calls landing in
  // 4 levels — "info" twice — and the counts below pin the mapping: a change
  // to it (log → debug, say) must be a deliberate edit here.
  { id: 'console', module: 'upstream.console', expect: { debug: 1, info: 2, warn: 1, error: 1 } },
  // The cordis exporter: one call per level.
  { id: 'cordis', module: 'cordis:probe.boot', expect: { debug: 1, info: 1, warn: 1, error: 1 } },
];
const LEVELS = ['debug', 'info', 'warn', 'error'];
/** The contract this probe enforces: release keeps the critical pair only. */
const CRITICAL = ['warn', 'error'];

const records = [];
const hostSink = globalThis.__DSH_LOG_SINK__;
globalThis.__DSH_LOG_SINK__ = (line) => {
  records.push(JSON.parse(line));
  hostSink?.(line);
};
const emit = (level, module, message, data = []) =>
  globalThis.__DSH_LOG_SINK__?.(JSON.stringify({ level, module, message, data }));

/* Route 1: the canonical logger. */
const log = createLogger('probe.sink');
log.debug('logger-debug');
log.info('logger-info');
log.warn('logger-warn');
log.error('logger-error');

/* Route 2: the forwarding console — the shim whose silence the old evidence
 * depended on. warn/error must survive a release build. */
globalThis.console.log('console-log');
globalThis.console.info('console-info');
globalThis.console.debug('console-debug');
globalThis.console.warn('console-warn');
globalThis.console.error('console-error');

/* Route 3: the cordis exporter over a real Context (the route bootUpstream
 * installs). One record per level, under its own logger name. */
const ctx = new Context();
wireLogger(ctx);
const cordisLog = ctx.logger('probe.boot');
cordisLog.debug('cordis-debug');
cordisLog.info('cordis-info');
cordisLog.warn('cordis-warn');
cordisLog.error('cordis-error');

/* ---- the verdict --------------------------------------------------------- */
const released = globalThis.__DSH_RELEASE__ === true;
const seen = (route, level) =>
  records.filter((r) => r.module === route.module && r.level === level).length;
const declared = RELEASE_CRITICAL_LEVELS.slice().sort().join(',');
const wanted = CRITICAL.slice().sort().join(',');

const problems = [];
for (const route of ROUTES) {
  for (const level of LEVELS) {
    const expected = releaseKeeps(level) ? route.expect[level] : 0;
    const found = seen(route, level);
    if (found !== expected) {
      problems.push(`${route.id}: "${level}" expected ${expected}, saw ${found}`);
    }
  }
}
if (declared !== wanted) {
  problems.push(`the declared critical set is "${declared}", the contract is "${wanted}"`);
}
if (!released && LEVELS.some((level) => !releaseKeeps(level))) {
  problems.push('a debug build strips levels — the policy is inverted');
}

const perRoute = ROUTES.map((r) => `${r.id}=${records.filter((x) => x.module === r.module).length}`);
if (problems.length > 0) {
  emit('error', 'probe.sink.verdict',
       `sink probe FAILED: ${problems.join(' | ')}`, [{ release: released }]);
  globalThis.__dshComplete(false, problems.join(' | '));
} else {
  emit('warn', 'probe.sink.verdict',
       `every sink route agrees with the release policy (${released ? 'release' : 'debug'} build)`,
       [{ release: released, perRoute: perRoute.join(' '), total: records.length }]);
  globalThis.__dshComplete(true, 'probe');
}
