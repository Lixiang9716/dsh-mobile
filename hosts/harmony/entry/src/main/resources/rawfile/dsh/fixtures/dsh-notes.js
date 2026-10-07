/**
 * dsh-notes fixture — builds the install-pipeline's test package at scenario
 * time. The spike JS cannot shell out (single-threaded runtime, no
 * subprocesses), so the package tarball is written in JS: a deterministic
 * ustar archive (tar-mini.js, mtime 0 everywhere) with two members —
 * manifest.json + bundle/index.js — carrying the plugin source from
 * fixtures/dsh-notes-source.js. `buildNotesTgz({ tampered })` flips one byte
 * of the entry source so the integrity-rejection case exercises a REAL
 * tampered package (different digest), not a faked checksum.
 */
import { createLogger } from 'logger.js';
import { tarWrite } from 'tar-mini.js';
import { NOTES_PLUGIN_SOURCE } from 'fixtures/dsh-notes-source.js';

const log = createLogger('dsh.notes-fixture');

/** The package manifest, verbatim (also validated by the pipeline). */
export const NOTES_MANIFEST = {
  schemaVersion: 1,
  id: 'dsh-notes',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite'], optional: [] },
  hooks: { activate: 'activate' },
};

const toBytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** The manifest member bytes, verbatim — the trust record anchors
 * manifestSha256 on exactly these bytes. */
export const NOTES_MANIFEST_BYTES = toBytes(`${JSON.stringify(NOTES_MANIFEST, null, 2)}\n`);

/** Package bytes: {tampered:false} → the honest plugin; {tampered:true} →
 * same manifest, entry source with appended (attacker) code. */
export const buildNotesTgz = ({ tampered = false } = {}) => {
  const source = tampered
    ? `${NOTES_PLUGIN_SOURCE}\n// tampered: extra code an attacker shipped\n`
    : NOTES_PLUGIN_SOURCE;
  const members = [
    { path: 'manifest.json', bytes: NOTES_MANIFEST_BYTES },
    { path: 'bundle/index.js', bytes: toBytes(source) },
  ];
  const bytes = tarWrite(members);
  log.debug('fixture package built', { tampered, bytes: bytes.length });
  return bytes;
};
