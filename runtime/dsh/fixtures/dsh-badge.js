/**
 * dsh-badge fixture — the CAPABILITY-NEGOTIATION test package for the M3
 * install-time negotiation proof. Built at scenario time exactly like
 * dsh-notes (deterministic ustar, tar-mini.js), but its manifest REQUIRES a
 * capability the host's RuntimeDescriptor may honestly not offer — `notify`.
 * On the desktop CLI smoke backend (which declares notify unavailable) the
 * pipeline must reject the install BEFORE anything is unpacked; on a host
 * whose descriptor offers notify the same package installs cleanly.
 */
import { createLogger } from 'logger.js';
import { tarWrite } from 'tar-mini.js';
import { BADGE_PLUGIN_SOURCE } from 'fixtures/dsh-badge-source.js';

const log = createLogger('dsh.badge-fixture');

/** The package manifest, verbatim (also validated by the pipeline). */
export const BADGE_MANIFEST = {
  schemaVersion: 1,
  id: 'dsh-badge',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', 'notify'], optional: [] },
  hooks: { activate: 'activate' },
};

const toBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** The manifest member bytes, verbatim — a trust record would anchor
 * manifestSha256 on exactly these bytes. */
export const BADGE_MANIFEST_BYTES = toBytes(`${JSON.stringify(BADGE_MANIFEST, null, 2)}\n`);

/** Package bytes: deterministic ustar with two members. */
export const buildBadgeTgz = () => {
  const members = [
    { path: 'manifest.json', bytes: BADGE_MANIFEST_BYTES },
    { path: 'bundle/index.js', bytes: toBytes(BADGE_PLUGIN_SOURCE) },
  ];
  const bytes = tarWrite(members);
  log.debug('fixture package built', { bytes: bytes.length });
  return bytes;
};
