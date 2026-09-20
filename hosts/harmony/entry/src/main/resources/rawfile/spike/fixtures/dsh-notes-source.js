// dsh:logging-exempt (this file is DATA, not executing code — it carries the
// dsh-notes plugin source as a template literal so the install pipeline can
// package it into a fixture tarball at scenario time; the spike JS cannot
// shell out to tar/npm, so the package is built in JS from these bytes)
/**
 * The dsh-notes fixture plugin SOURCE (the bytes that go inside the package
 * tarball). It is a real system-plugin-shaped ESM module: static manifest +
 * an activate factory that registers a trivial `notes` service over the fs
 * service it resolves from the registry context. Import specifiers stay
 * bundle-root-relative (`logger.js`) — the one-canonical-specifier rule from
 * runtime/spike/README.md.
 */
export const NOTES_PLUGIN_SOURCE = `import { createLogger } from 'logger.js';

const log = createLogger('dsh.notes');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-notes',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite'], optional: [] },
  hooks: { activate: 'activate' },
};

/** dsh-notes — installed-plugin fixture: a trivial notes service over the
 * fs service, resolved from the registry context at activation time. */
export function activate({ register, service }) {
  log.debug('activating dsh-notes');
  const fs = service('fs');
  register('notes', {
    async write(scope, rel, text) {
      log.debug('notes.write', { scope, rel });
      return await fs.writeText(scope, 'm3-install/' + rel, text);
    },
    async read(scope, rel) {
      log.debug('notes.read', { scope, rel });
      return await fs.readText(scope, 'm3-install/' + rel);
    },
  });
}
`;
