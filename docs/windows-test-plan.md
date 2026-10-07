# Windows-side test plan (harmony runtime E2E + a proxy-free control)

English | [简体中文](windows-test-plan.zh.md)

Date: 2026-10-05. Purpose: close the verification boundary WSL2 cannot cover —
the harmony HAP has never been **executed** anywhere (compile + HAP structure
assertions are green; runtime proof is zero). The Windows-side DevEco emulator
is the repository's only harmony execution target. An optional proxy-free
Android control run decouples the Clash proxy variable.

Evidence convention: all artifacts go to `~/dsh-mobile-artifacts/windows-e2e/`
(outside the repository); every deviation is appended as one row to
`.zcode/loop/queue.jsonl` (fields `id,title,severity,status:"open"`, note with
the evidence path; existing rows untouched). Log-system mapping: harmony uses
**hilog** where Android uses logcat.

---

## P0 Environment provisioning (the user-interactive part; currently missing)

Probed on 2026-10-05: the Windows side has **no** DevEco Studio, no hdc.exe,
and an empty `/mnt/d/MyApplication/Sdk` (only the project skeleton
AppScope/entry/hvigor). Required:

1. Install DevEco Studio (Windows) + the HarmonyOS SDK (license acceptance,
   several GB).
2. Create/start a **HarmonyOS emulator** (API 12+ suffices) in Device Manager.
3. Acceptance line for P0:
   - `hdc list targets` lists the emulator (`127.0.0.1:5555` or similar);
   - `hdc shell "cat /proc/version"` prints (standard-system is a Linux kernel);
   - WSL interop works: from WSL,
     `/mnt/c/.../sdk/default/openharmony/toolchains/hdc.exe list targets` matches —
     WSL drives every test below through this path.
4. HAP source: download from CI
   (`gh run download <dev-harmonyos run-id> -n dsh-dsh-hap -D
   ~/dsh-mobile-artifacts/windows-e2e/`), or build locally via the repo's
   harmony leg (hvigor may reuse the /mnt/d wrapper). The emulator accepts
   debug signing; if install reports a signing error, configure auto-signing
   in DevEco and retry.

---

## T1 Emulator cold boot + application structure (the Android cold-boot protocol; highest value)

Steps (WSL drives hdc.exe; `hdc` below means that interop path):

```
hdc install <hap>                          # install
hdc shell aa start -a EntryAbility -b com.dshmobile.host   # launch
# readiness poll (60s deadline, every 5s):
hdc shell "cat /proc/net/tcp6"             # find the app's LISTEN row
hdc fport tcp:<P> tcp:<P>                  # port forward
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<P>/   # with the page-fetched cookie
hilog | grep -E "FAIL|FATAL"               # delta
```

**Expected results**:
- LISTEN appears **≤5s** after launch (Android baseline ~2s; first harmony
  boot relaxed to 10s);
- page GET **200** (on 401, pass the Internal-Testing notice via UI and
  re-fetch the cookie);
- the composer (`[contenteditable="true"]`) renders — **not a dead shell**
  (the 2026-09-24 Android dead-shell defect class; harmony executes for the
  first time, this is assertion #1);
- hilog delta: **0 FAIL / 0 FATAL**;
- one screenshot (emulator window, or
  `hdc shell snapshot_display -f /data/local/tmp/w1.jpeg` + `hdc file recv`).

---

## T2 Timer-primitive absence is honest (#382's harmony-side boundary)

Background: the harmony host has not implemented timerSchedule (GatewayCore
answers denied) — the LLM read-idle watchdog **cannot arm** there; that is a
known owner boundary. This test verifies the absence is **honest**:

```
hilog | grep -E "timer|arm"                # one-time sample after cold boot
```

**Expected results**:
- exactly **one** per-runtime arm/failed warning (#382's once-per-runtime
  semantics, `upstream/shims/timers.js`);
- **not a storm** (the historical lesson: one warning per arm at 21 lines/s
  flipped a cross-thread race);
- a log trace of GatewayCore denying timerSchedule;
- turns still complete (timer absence must not block the main chain — a more
  basic honesty assertion than availability).

---

## T3 Real-model turn (the creation loop's first harmony run)

Steps: stage the credential (harmony app data lives under
`/data/app/el2/100/base/com.dshmobile.host/...`):

```
hdc file send config.json <el2>/files/profiles/default/llm/config.json
hdc shell "chmod 600 <el2>/files/profiles/default/llm/config.json"
# if ownership is wrong (hdc shell runs as the shell user), fix via the
# in-app BYOK settings surface or a debug handle, then relaunch
```

config.json matches the Android seat: baseUrl
`https://open.bigmodel.cn/api/coding/paas/v4`, model `glm-5.3-flash`,
apiKey `ea7f...5Lc`.

Send: "帮我做一个插件,名字 win-hello,功能是向用户问好". Completion criterion:
the session journal (wire snapshot) shows `turn/end completed`; or the page
renders the closing text.

**Expected results** (mirroring the Android r20 assertions):
- turn **completed**, the model invokes the plugin_manager install leg;
- the device tree grows `plugins/win-hello/{manifest.json,plugin.js,card.json}`
  and a registry row `enabled:true` (under the el2
  `files/profiles/default/dsh/plugins/registry.json` area);
- hilog delta: 0 new FAIL;
- on any failure: **verbatim capture** — a missing harmony host primitive
  must surface as a structured refusal, never a silent fake success.

---

## T4 fs boundary three shapes + relative spelling (same JS bytes, expected verbatim-identical)

Have the model read four paths; capture the raw journal tool results (or the
page transcript):

| Input | Expected result (verbatim-identical to Android r18/r20 — same shim bytes) |
| --- | --- |
| `/system/app` | in-band refusal: workspace root (the el2 dsh path) + "maybe you meant …/dsh/system/app?" |
| `/system/definitely-not-here-xyz` | absence semantics (not found / ENOENT), **no** anchor refusal |
| `dsh/../plugins/registry.json` | resolves; registry content rendered (#383 semantics) |
| `../../../../etc/passwd` | pinned in-root: ENOENT form, **no** passwd content |

Any divergence from Android = a host-seam difference (harmony's fs primitive
implementation), one queue row each — that probe is this test's real value.

---

## T5 web_search reality check

Have the model run any web_search.

**Expected results**: either outcome passes — (a) in-band
`[WEB_SEARCH_KEYLESS_CHALLENGED]` (the anti-bot reality, matching the Android
seat; the model handles it honestly), or (b) real results (harmony's network
stack may not be challenged). **The defect line = a silent empty success**
(the original r8 defect shape).

---

## T6 Light soak

5 cold-boot cycles (the T1 protocol) + a memory sample per round:

```
hdc shell "hidumper --mem $(pidof com.dshmobile.host)"   # or ps -o RSSHLK
```

**Expected results**: 5/5 ready; boot seconds zero-or-small variance
(record the distribution); no FAIL accumulation; no monotonic memory growth
(5 samples ≤ 1.5× the first round; above that, queue a suspected leak).

---

## T7 (optional) Android-on-Windows proxy-free control

If the Windows side has an Android SDK/emulator: install the same release APK
on a **proxy-free** Windows emulator and replay three probes: one-sentence
creation, web_search, a mid-stream network cut (watchdog latency).

**Expected results / value**: behavior matches the WSL seat (± network
differences); **web_search may return real results on a proxy-free network** —
settling whether CHALLENGED is an environment reality or a product defect;
the cut watchdog should still fire at the 120s scale (without the proxy a
Connection reset may surface earlier — expected).

---

## Exit criteria and feedback loop

- T1-T6 all at expectation → harmony's verification boundary upgrades from
  "structure proof" to "runtime proof (emulator)" and the wrap report states
  it as such; a real device (hdc + usbipd) remains a further option.
- Any assertion off → screenshot + hilog excerpt + journal evidence into the
  queue, handled by the fixer track; expected host differences (timer denied)
  are not failures — they go to the owner-decision list.
- Never touch the WSL-side repository's git/gov state; everything on Windows
  happens inside the emulator.

---

## Execution status (2026-10-05, Windows host — first full pass)

| Item | Result |
| --- | --- |
| P0 provisioning | DONE — CLT 26.0.0.851 (D:\harmonyos-commandlinetools, includes the SDK + Emulator + hdc), image HarmonyOS 7.0.0(26.0.0), dsh_phone instance (D:), target 127.0.0.1:5559, WHPX on. No DevEco Studio needed. |
| T1 cold boot | DONE, exceeded — the full 8-scenario `run-host-e2e.sh` suite ran green 4× (PR #390): composer renders, page serves, 0 checker failures. |
| T2 timer honesty | DONE from run logs — exactly one `arm/failed` warning per runtime (2 runtimes → 2 lines, no storm), GatewayCore denying timerSchedule logged, turns complete. |
| T3 real-model turn | DONE at the pinned seat — glm-5.3-flash streamed a full turn on the Windows emulator: scenario verdict PASS, device manifest 14/114 (reasoning + content deltas, repeat-aware), carrier 7/7, served-model verbatim, key-leak audit clean, credentials removed; receipt authored on the green path (`hosts/harmony/artifacts/windows-t3-live-llm/`). An earlier OpenRouter free-pool attempt (before the key arrived) had proven the transport and left the device manifest at 13/14 — its `llm.reasoning.delta` pin is bigmodel-seat-specific (free routes serve no reasoning; Android behaves IDENTICALLY, see T7) — that finding is the manifest's provider pin, not a host defect. |
| T4 fs shapes | DONE (2026-10-05) — the `real.agent.loop` leg: the full spine on the staged bigmodel credential, glm-5.3-flash driving the four probe turns itself. All four shapes verbatim-identical to the Android expectations (anchored refusal / relative-resolves with the seeded registry / plain absence / in-root pin); manifest 21/21, receipt on the live host line. |
| T5 web_search | DONE (2026-10-05) — same leg, fifth turn: the model called web_search and the tool ANSWERED on the proxy-free network (no keyless challenge, no silent empty success — the best-case outcome, and it settles T7's environment question for this probe). |
| T6 soak | DONE — 5/5 cold boots green (boot 31/69/63/66/65s, app ready +3s every round, PSS 97.7→106.3→98.9→102.4→99.2MB = 1.09×, FAIL delta 0). |
| T7 Android control | DONE for the real-turn leg — the same OpenRouter turn on the local proxy-free Android emulator: scenario ALL PASS, and the device-manifest failure is byte-identical to harmony's (want reasoning.delta @7, got llm.delta "Hello") — the seats match; the mismatch is the manifest's provider pin. |

Environment facts learned (fix or remember):

- `/proc/net/tcp6` shows NO socket rows to the shell user on this image — T1's
  readiness poll must use the app's own hilog marker (`session.mock-llm PASS`).
- `hdc` treats forward-slash and MSYS paths as RELATIVE (prefixes its cwd);
  pass `D:\...` backslash forms and set `MSYS_NO_PATHCONV=1` for device args.
- `hdc file send` cannot land into the app sandbox without the runtime's
  others-writable placeholder (the run-live-llm handshake); `run-as` is an
  Android-only convenience.
- The Emulator's first-run IME wizard hijacks the screen once — tap through
  before driving, or the uitest drive starves.
- OpenRouter free-pool 429s are transient and per-model; probe before spending
  a device attempt, and the free routes never serve the reasoning field
  through the vendored adapter (manifest pin, not a defect).
