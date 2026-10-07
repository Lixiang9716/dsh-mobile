import { mkdirSync, mkdtempSync } from 'node:fs';

// POSIX-spelled real fixtures for the fs-shim suites: mountWorkspace (the
// device-fs contract) demands a '/'-prefixed root, and every real-disk seam
// call must spell each fixture exactly as the shim hands it back — a single
// leading-slash spelling, resolved by node against the process cwd's drive,
// is coherent on POSIX and Windows seats alike (the vitest parent and the
// spawnSync'd toolface runners share cwd, hence the same drive). On Linux
// this is the spelling tmpdir() already produced; the recursive mkdir is a
// no-op there.
export const mkdtempPosix = (prefix) => {
  mkdirSync('/tmp', { recursive: true });
  return mkdtempSync(`/tmp/${prefix}`);
};
