/**
 * e2e-stage — the HarmonyOS host's credential-placeholder writer (E2E glue
 * that lives ONLY in this host's bundle: it is not part of the portable
 * scenario set and is not vendored from runtime/spike).
 *
 * Why it exists: `hosts/harmony/ci/run-live-llm.sh` must hand the llm.live-stream
 * credentials to the app, but the app sandbox is not shell-writable on this
 * platform — the hdc shell user can OPEN an existing app-owned file, never
 * create one, and an ArkTS-side create lands 0660 (unopenable by the shell)
 * while the app-side chmod does not stick, both measured on the dsh_phone
 * emulator (surprise ledger). The C-side app-scope fsWrite — the backend
 * the scenarios already use — creates files at 0666 via fopen, which IS
 * shell-openable. So the runtime creates the placeholder the runner fills
 * in, and the host's `stage-ready` drive marker follows from this module's
 * bus post.
 *
 * Evaluated by HostPhase.beginLlm through hostEval (one more module on the
 * ONE serial JS runtime thread, like every other script here); it writes
 * `{}\n` into the app scope — never a secret, the runner overwrites it with
 * the real config and the app seals it at 0600 before the scenario reads
 * it. Deliberately NOT named `scenario/…`: this is host plumbing, and the
 * one-to-one manifests must never see a record for it.
 */
import { createLogger } from 'logger.js';
import { fsWrite } from 'gateway.js';

const log = createLogger('dsh.stage');
const PATH = 'llm-live-stream/config.json';
/** '{}' + '\n' — the empty placeholder, replaced by the runner. */
const PLACEHOLDER = new Uint8Array([123, 125, 10]);

const post = (message) => {
  log.debug('bus post', { type: message.type });
  globalThis.__dshBusPost?.(JSON.stringify(message));
};

log.debug('placeholder write begin', { path: PATH });
try {
  const written = await fsWrite('app', PATH, PLACEHOLDER);
  log.debug('placeholder written', { path: PATH, written: written.written });
  post({ type: 'stage.ready', path: PATH });
} catch (err) {
  log.debug('placeholder write failed');
  post({ type: 'stage.error', path: PATH, message: String(err?.message ?? err) });
}
