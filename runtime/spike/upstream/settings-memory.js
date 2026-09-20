// dsh:logging-exempt (shim layer)
/**
 * settings-memory — the in-memory SettingsProvider backend for the mobile
 * profile (PR-A).
 *
 * The dsh-base bundle mounts `@deepseek-ai/dsh-settings-file` (the
 * `$DSH_HOME/settings.yaml` document, hot-reloaded). A phone profile has no
 * settings file and no file watcher seam in PR-A; the same base service with
 * an EMPTY in-memory document is the honest platform substitute — the
 * upstream agent-loop settings section (agent-loop/max-parallel-tool-calls)
 * installs and reads through the identical base contract.
 *
 * Staged: when the profile container gains durable KV (the gateway fs scope
 * is already the transport), this backend persists its document instead of
 * returning {}.
 */
import { SettingsProvider } from '@deepseek-ai/dsh-settings';

/** SettingsProvider over an empty in-memory document. */
export class SettingsMemory extends SettingsProvider {
  /** The provider document source: empty for the mobile profile. */
  async load() {
    return {};
  }
}
