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
 * ci/run-host-e2e.sh drives. `m2.llm` selects the real-LLM leg alone
 * (ci/run-m2-llm.sh), so the default chain never spends serve quota.
 *
 * Unknown values fail loud at the consumer (Index) instead of silently
 * running the default chain — a mistyped leg must never look like a pass.
 */
export class E2eLeg {
  private static leg: string = '';

  /** EntryAbility.onCreate: the raw want parameter ('' when absent). */
  static set(leg: string): void {
    E2eLeg.leg = leg;
  }

  static get(): string {
    return E2eLeg.leg;
  }
}
