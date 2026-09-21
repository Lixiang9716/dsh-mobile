/**
 * The critical-set probe for the release log strip: one record per level.
 * A release build must keep warn/error and fold debug/info away, so the
 * debug run shows four records and the release run exactly two.
 * Runs on the desktop CLI (host/build.sh + build.sh --release).
 */
import { createLogger } from './logger.js';

const log = createLogger('probe.levels');
log.debug('debug-level', { kept: false });
log.info('info-level', { kept: false });
log.warn('warn-level', { kept: true });
log.error('error-level', { kept: true });
globalThis.__dshComplete(true, 'probe');
