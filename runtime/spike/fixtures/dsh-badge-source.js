// dsh:logging-exempt (this file is DATA, not executing code — it carries the
// dsh-badge plugin source as a template literal so the negotiation fixture
// can package it into a tarball at scenario time; the spike JS cannot shell
// out to tar/npm)
/**
 * The dsh-badge fixture plugin SOURCE (the bytes inside the negotiation test
 * package). Same shape as the dsh-notes source: a real system-plugin-shaped
 * ESM module whose manifest REQUIRES fsRead + fsWrite + notify — the last of
 * which hosts may honestly declare unavailable (the desktop CLI smoke
 * backend does). The badge service is never activated in the rejection E2E:
 * negotiation rejects the package BEFORE unpack.
 */
export const BADGE_PLUGIN_SOURCE = `import { createLogger } from 'logger.js';

const log = createLogger('dsh.badge');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-badge',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', 'notify'], optional: [] },
  hooks: { activate: 'activate' },
};

/** dsh-badge — negotiation fixture: registers a trivial badge service that
 * posts a notification through the ui service when invoked. */
export function activate({ register, service }) {
  log.debug('activating dsh-badge');
  const ui = service('ui');
  register('badge', {
    async show(text) {
      log.debug('badge.show', { text });
      return await ui.notify({ title: 'dsh-badge', body: text });
    },
  });
}
`;
