// dsh:logging-exempt (hilog here IS the staging handshake channel: the drive
// waits for these `dsh.app` markers; canonical evidence rides the scenario's
// own sink, never this module)
/**
 * LlmConfigStaging — the credential handoff for the `llm.live-stream` leg.
 *
 * The guest platform has no `run-as` twin of the Android host, and neither
 * the hdc shell user nor the app alone can produce a file the OTHER side can
 * write: the sandbox refuses shell-side creation, an ArkTS-side create lands
 * mode 0660 (unopenable by the shell), and an app-side chmod does not stick
 * — all three measured on the dsh_phone emulator (surprise ledger). So the
 * handoff is split three ways, as a polled-condition handshake (rule 8):
 *
 *   1. the RUNTIME creates the placeholder — `e2e-stage.js` asks the C-side
 *      app-scope fsWrite (fopen, mode 0666) for `<filesDir>/spike-fs/
 *      llm-live-stream/config.json` = `{}` and posts `stage.ready` on the bus seam,
 *      which HostPhase turns into the `stage-ready` drive marker;
 *   2. `hosts/harmony/ci/run-live-llm.sh` waits for that marker, then writes
 *      the real credentials over the placeholder with `hdc file send` (the
 *      shell user may open, never create) and keeps them in its own 0600
 *      temp file only — never echoed, never committed;
 *   3. this module polls the file until it parses as the scenario's config
 *      ({baseUrl https, apiKey ≥ 20 chars, model non-empty} — the same
 *      demands the scenario itself makes), logs `stage-loaded` with the
 *      model name and byte count, and hands control back to Index, which
 *      starts the carrier → page → scenario. A deadline exhaustion fails
 *      loud (rule 5).
 *
 * The key therefore never enters a log line, a command line, or a path that
 * outlives the run: the placeholder holds no secret, the runner's copy is
 * mode 0600 in a temp file, and the imported config is removed by the app
 * when the leg completes (cleanup — this platform's chmod is a silent no-op,
 * so removal, not permission bits, is the guarantee; both are measured in
 * the surprise ledger).
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
// The deprecated @ohos.fileio module is the ONLY permission API this SDK
// ships (fileIo has no chmod): used deliberately, for the 0600 seal only.
import fileIO from '@ohos.fileio';

const TAG: string = 'dsh.app';
const POLL_MS: number = 250;
const DEFAULT_DEADLINE_MS: number = 120000;

interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export class LlmConfigStaging {
  /** Start from a clean slate BEFORE the runtime writes the placeholder: a
   * stale file keeps its old mode across runs (fopen never re-modes an
   * existing file) and only a FRESHLY created one lands the 0666 the runner's
   * shell user can open. The app owns both the file and its directory, so it
   * can unlink; the hdc shell user cannot — this is the only side that can
   * reset the handshake. */
  static prepare(configPath: string): void {
    try {
      if (fs.accessSync(configPath)) {
        fs.unlinkSync(configPath);
        hilog.info(0x0000, TAG, 'stage-reset %{public}s', configPath);
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, 'stage-reset failed (stale mode?) %{public}s',
        (e as BusinessError).message ?? 'unknown');
    }
  }

  /** Wait for the runner's credentials to land in the placeholder and
   * validate. Resolves with the staged byte count; rejects loud on deadline
   * (the rejected promise's message is also the drive marker). */
  static awaitStaged(configPath: string,
    deadlineMs: number = DEFAULT_DEADLINE_MS): Promise<number> {
    return new Promise((resolve: (bytes: number) => void,
      reject: (err: Error) => void): void => {
      const deadline: number = Date.now() + deadlineMs;
      const tick = (): void => {
        const bytes = LlmConfigStaging.tryLoad(configPath);
        if (bytes > 0) {
          resolve(bytes);
          return;
        }
        if (Date.now() > deadline) {
          const reason = 'credentials were never staged (' + configPath + ')';
          hilog.error(0x0000, TAG, 'stage-error %{public}s', reason);
          reject(new Error(reason));
          return;
        }
        setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);
    });
  }

  /** One probe: the staged byte count, 0 while the file is still the empty
   * placeholder / half-written / unparsable. A truncated JSON never parses,
   * so a partially transferred file cannot be mistaken for a staged one.
   * Logs `stage-loaded` (model + bytes, never the key) and seals 0600. */
  private static tryLoad(configPath: string): number {
    let text: string = '';
    try {
      const stat = fs.statSync(configPath);
      if (stat.size <= 3) {
        return 0; // still the "{}" placeholder from e2e-stage.js
      }
      const file = fs.openSync(configPath, fs.OpenMode.READ_ONLY);
      const buffer = new ArrayBuffer(stat.size);
      const read = fs.readSync(file.fd, buffer);
      fs.closeSync(file);
      text = util.TextDecoder.create('utf-8')
        .decodeToString(new Uint8Array(buffer, 0, read));
    } catch (e) {
      return 0; // mid-transfer states (replace races) are retried
    }
    let config: LlmConfig;
    try {
      config = JSON.parse(text) as LlmConfig;
    } catch (e) {
      return 0; // partial write — keep polling, the runner finishes it
    }
    const ok = typeof config.baseUrl === 'string' &&
      config.baseUrl.indexOf('https://') === 0 &&
      typeof config.apiKey === 'string' && config.apiKey.length >= 20 &&
      typeof config.model === 'string' && config.model.length > 0;
    if (!ok) {
      return 0;
    }
    // Sealed before the scenario reads it, and REPORTED (this platform's
    // chmod is unreliable — observed as a silent no-op on a 0666 file — so
    // the mode is re-read and logged instead of assumed; rule 5's "never
    // silently skip" applies to a seal as much as to a failure).
    LlmConfigStaging.seal(configPath, 0o600);
    hilog.info(0x0000, TAG, 'stage-loaded bytes=%{public}d model=%{public}s',
      text.length, config.model ?? '');
    return text.length;
  }

  /** Remove the credentials once the leg is done with them (both the pass
   * and the fail path call this): the on-disk lifetime of the API key is one
   * run, since the world-writable window the handshake needs cannot be
   * closed by chmod on this platform. The next run's prepare() is the second
   * removal point, so a crashed run cannot leak the key into a later one. */
  static cleanup(configPath: string): void {
    try {
      if (fs.accessSync(configPath)) {
        fs.unlinkSync(configPath);
        hilog.info(0x0000, TAG, 'stage-cleanup removed %{public}s', configPath);
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, 'stage-cleanup failed %{public}s',
        (e as BusinessError).message ?? 'unknown');
    }
  }

  /** chmod through @ohos.fileio (the only permission API this SDK ships),
   * then RE-READ the mode and log what the file actually carries. */
  private static seal(configPath: string, mode: number): void {
    try {
      fileIO.chmodSync(configPath, mode);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'stage-seal chmod %{public}s failed: %{public}s',
        mode.toString(8), (e as BusinessError).message ?? 'unknown');
    }
    try {
      const actual: number = fs.statSync(configPath).mode & 0o777;
      if (actual === mode) {
        hilog.info(0x0000, TAG, 'stage-sealed mode=%{public}s', actual.toString(8));
      } else {
        hilog.warn(0x0000, TAG,
          'stage-seal ineffective (platform chmod no-op) mode=%{public}s wanted=%{public}s',
          actual.toString(8), mode.toString(8));
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, 'stage-seal stat failed: %{public}s',
        (e as BusinessError).message ?? 'unknown');
    }
  }
}
