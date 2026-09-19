/**
 * NAPI surface of libspike.so — the M1 spike host binding.
 *
 * startSpike runs the whole scenario (new + eval + pump) synchronously on
 * the caller thread and returns the verdict summary (PASS/FAIL + engine).
 * The canonical `dsh.spike.log:` lines stream to hilog (domain 0xD5E0,
 * tag "dsh.spike") and to the capture file at capturePath.
 */
export const startSpike: (bundleRoot: string, capturePath: string) => string;
