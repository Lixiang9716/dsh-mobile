/**
 * NAPI surface of libspike.so — the M5 spike host binding.
 *
 * startSpike runs ALL spike scenarios (m1.spike.boot regression +
 * m2.bridge.smoke + m2.session over the gateway bridge) synchronously on the
 * caller thread — new + eval + pump + settle per scenario — and returns the
 * combined verdict summary (PASS/FAIL + per-scenario verdicts). The
 * canonical `dsh.spike.log:` lines stream to hilog (domain 0xD5E0, tag
 * "dsh.spike") and to the capture file at capturePath. fsRoot is the
 * scope-"app" directory the smoke backend's fs primitives operate on.
 */
export const startSpike: (bundleRoot: string, capturePath: string, fsRoot: string) => string;
