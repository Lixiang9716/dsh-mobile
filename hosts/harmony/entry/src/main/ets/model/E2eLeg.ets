// dsh:logging-exempt (launch plumbing: no canonical log lines here; the leg
// marker rides hilog in EntryAbility, the drive reads it there)
/**
 * E2eLeg — which E2E leg THIS launch runs (the HarmonyOS host's twin of the
 * Android host's `--ez dsh.llm true` launch extra; HarmonyOS has no
 * scenario list to append to, so the leg is a launch-time selector).
 *
 * EntryAbility.onCreate reads the want parameter `dsh.e2e.leg` (staged by
 * `hdc shell aa start ... --ps dsh.e2e.leg <leg>`) and parks it here BEFORE
 * the window stage loads pages/Index, so the page's aboutToAppear sees it.
 * An ABSENT parameter means the default chain: the regression trio, the m5
 * binding phase, and the D9 official-web legs — exactly what
 * ci/run-host-e2e.sh drives. `llm.live-stream` selects the real-LLM leg alone
 * (ci/run-live-llm.sh), so the default chain never spends serve quota.
 *
 * Unknown values fail loud at the consumer (Index) instead of silently
 * running the default chain — a mistyped leg must never look like a pass.
 */
export class E2eLeg {
  private static leg: string = '';
  private static spec: string = '';
  private static webClient: string = '';

  /** EntryAbility.onCreate: the raw want parameter ('' when absent). */
  static set(leg: string): void {
    E2eLeg.leg = leg;
  }

  static get(): string {
    return E2eLeg.leg;
  }

  /** The suite leg's spec selection (`--ps dsh.e2e.spec <file>`; '' when
   * absent — the upstream.suite leg fails loud without one). */
  static setSpec(spec: string): void {
    E2eLeg.spec = spec;
  }

  static getSpec(): string {
    return E2eLeg.spec;
  }

  /** The Web Client the release boot serves (`--ps dsh.web.client <id>`;
   * '' when absent = the official dist). A client SELECTION, not a drive —
   * the release build accepts it (the iOS -dsh-web-client launch argument's
   * twin); an unknown id fails loud at the consumer. */
  static setWebClient(webClient: string): void {
    E2eLeg.webClient = webClient;
  }

  static getWebClient(): string {
    return E2eLeg.webClient;
  }
}
