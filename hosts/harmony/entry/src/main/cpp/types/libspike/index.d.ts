/**
 * NAPI surface of libspike.so — the M5 spike host binding.
 *
 * startSpike runs ALL spike scenarios (boot.verification regression +
 * gateway.bridge-smoke + session.mock-llm over the gateway bridge) synchronously on the
 * caller thread — new + eval + pump + settle per scenario — and returns the
 * combined verdict summary (PASS/FAIL + per-scenario verdicts). The
 * canonical `dsh.spike.log:` lines stream to hilog (domain 0xD5E0, tag
 * "dsh.spike") and to the capture file at capturePath. fsRoot is the
 * scope-"app" directory the smoke backend's fs primitives operate on.
 */
export const startSpike: (bundleRoot: string, capturePath: string, fsRoot: string) => string;

/**
 * M5 binding phase — the EVENT-DRIVEN host runtime (ArkTS calls the
 * fine-grained mutators per event; every call still runs on the ArkTS main
 * thread, which stays the ONE serial JS runtime thread). All mutators
 * return the drive step's verdict: -1 runtime error, 0 running,
 * 1 complete+pass, 2 complete+fail.
 *
 * hostStart creates the phase runtime: the binding smoke backend (descriptor
 * served verbatim; the platform primitives forwarded to onDispatch), the
 * canonical-line sink (hilog + capture file at capturePath), and the bus
 * seam. The two callbacks are `(line: string) => void` (JS bus post) and
 * `(callId: number, name: string, args: string) => void` (platform
 * primitive dispatch — queue it, never settle from inside). The optional
 * scenario label names the `dsh.spike.verdict:` line (default
 * harmony.capability-binding).
 */
export const hostStart: (bundleRoot: string, capturePath: string, fsRoot: string,
  descriptor: string, onBus: (line: string) => void,
  onDispatch: (callId: number, name: string, args: string) => void,
  scenario?: string) => number;
export const hostEval: (phaseId: number, entry: string) => number;
export const hostEvent: (phaseId: number, eventJson: string) => number;
export const hostBusDeliver: (phaseId: number, line: string) => number;
export const hostSettle: (phaseId: number, callId: number, ok: boolean,
  payloadJson: string) => number;
/** Route one ArkTS-side canonical line (carrier evidence) through the phase
 * sink — hilog + capture, single writer. Returns 0. */
export const hostCarrierLine: (phaseId: number, line: string) => number;
export const hostStatus: (phaseId: number) => string;
export const hostFree: (phaseId: number) => number;
