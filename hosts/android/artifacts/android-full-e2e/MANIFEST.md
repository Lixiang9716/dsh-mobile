# Android full end-to-end run — 2026-09-23 02:0x (local, WSL2)

One invocation of `hosts/android/ci/run-android-full.sh` on the local
emulator (AVD `dsh_test`, Android 15, KVM), tree at `a3791a8` (post #142).
**All eight scenarios green** — the complete regression plus the capability
binding plus the three live official-Web legs:

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| m1.spike.boot (boot verification) | PASS 7/7 | `../android-upstream/` (regression log) |
| m2.bridge.smoke (gateway bridge) | PASS 6/6 | same |
| m2.session (session, mock LLM) | PASS 23/23 | same |
| m4.host-binding (android capability binding) | PASS 35/35 | `dsh-m4-verdict-binding.json` + screenshots below |
| m2.gateway.audit | PASS 16/16 | `dsh-m4-audit.jsonl`, `dsh-m4-verdict-audit.json` |
| b-android.official-web.mount | PASS 14/14 | `../android-upstream/` |
| b-android.session.live | PASS 46/46 | `../android-session-live/` |
| b-android.write.live | PASS 45/45 | `../android-write-live/` |

The three canonical dirs above are refreshed by this same run (their logs,
`results.txt`, `scenario.jsonl` and screenshots are this run's output); the
checker verdicts ride each dir's `results.txt` tail. This directory
consolidates the capability-binding phase evidence that has no canonical
home yet, plus:

- `dsh-m4-0*.png` — screenshots at each UI stage of the capability binding
  (WebView mount → SAF picker → approval dialog → notification → final
  state): human evidence only, never a checker input (the log is).
- `device-deliverables/` — files pulled from the app's private storage after
  the run, proving the gateway's persisted effects are real on-device bytes:
  - `probe.txt` — the privileged layer's gateway probe marker
    (`dsh-gateway-probe`), written by the host on first boot.
  - `scope-registry.json` — the fs-scope persistence: the SAF tree grants
    (`content://…/tree/primary:dsh-e2e`) with their security-scoped
    bookmark ids, i.e. what `fsScope persist/resolve` actually wrote.

Environment note: an earlier invocation the same night failed
`b-android.session.live` at the journal probe (42/46, `timeout`) with a
HarmonyOS emulator and several analysis jobs running on the same machine;
the clean rerun above passed 46/46 with no code change — local-load timing,
not a regression (CI on the same commit is green).
