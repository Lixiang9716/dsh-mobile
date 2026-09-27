import { createLogger } from 'logger.js';
import 'upstream/shims/npm-bridges.js';
const log = createLogger('pptp');
const { registerPptCreate } = await import('system-plugins/dsh-office/ppt-create.js');
log.info('pptp', { step: 'imported' });
const tool = registerPptCreate();
log.info('pptp', { step: 'registered', name: tool?.name });
