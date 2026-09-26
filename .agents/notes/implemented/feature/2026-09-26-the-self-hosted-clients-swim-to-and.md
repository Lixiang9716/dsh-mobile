# Agent Note: the self-hosted web clients swim to Android (next + whale, creation leg included)

Status: implemented

## Problem

The self-hosted Web Clients — `dsh-web-client-next` (the official-plane full
client, PR #214) and `dsh-web-client-whale` (the creation-mode client, PR
#218) — existed only on iOS. Android had no staging, no seat selection, and
no drive: its assets carried just the v0 hand-committed `webclient/web`
copy, `SessionServe.kt` hardcoded the official dist root, and the only
page-driving seats (`SessionWriteSession`-class) targeted the official page.
The owner asked for the Android/HarmonyOS port to complete the
cross-platform story (Harmony lands as its own follow-up change on the same
pattern).

## Decision

Android serves both clients through its existing seats, mirroring the iOS
seam one-to-one:

- **Staging**: `hosts/android/ci/stage-spine-closure.sh` mirrors
  `presentation/web-client-{next,whale}` into
  `assets/spike/webclient-{next,whale}` whole-tree, with the same
  sync+byte-check discipline as the upstream layer (the older v0 hand-commit
  predates the discipline and stays as-is).
- **The next client** rides `SessionServe` (the SAME seat the user-facing
  release boot runs): a `clientID` constructor parameter selects it — the
  dist root becomes `spike/webclient-next/web` and the index injection rows
  become empty (the page owns its whole boot); every other selection serves
  the official dist untouched. The release boot reads the selection from the
  `--es dsh.web.client <id>` launch extra (a client selection, not a drive —
  the iOS `-dsh-web-client` arg's sibling). The interactive config gains the
  `creation` row, and the seat grows the iOS hook block (no-op defaults).
- **The whale client** rides the M4 session host: `SpikeHostM4` takes
  `clientId`/`webRootDir`/`whaleLeg` constructor parameters (defaults keep
  the m4 leg byte-identical) and `startWhale` runs
  `scenario/session-mock-llm.js` under the whale web root — the iOS
  session-mock-llm `--client whale` leg mirrored.
- **The scripted turns** port into `MockLlmRoute`: `SLOW_TURN` drips the
  success body in ~8 slices ~220 ms apart on the carrier's per-connection
  thread (blocking pacing is safe there), `CREATE_TURN` answers ONE request
  per launch with a write+present tool-call pair (absolute path inside the
  workspace; the one-shot latch stops the post-tool continuation from
  looping).
- **The drive** (`NextWebSession` + `NextWebProbe`) chains page-side async
  legs through the `dshProbe` JavascriptInterface — the Android WebView
  keeps page timers live, so the legs carry their own bounded waits (unlike
  the iOS probe's stateless legs + drive-side polling, which exists because
  a driven WKWebView throttles page timers to near-zero). One readiness seam
  differs: `session-mock-llm.js` never posts `bus.ready` (it parks on the
  `host.info` EVENT until the page connects), so the whale leg opens the
  origin on handle+port alone (`deliverHostHello`'s whaleLeg branch).
- **Evidence**: `test/e2e/run-android-next-web-mount.sh` runs both legs with
  the canary-pinned logcat capture (the `c0dc88d` discipline), asserting
  `android.whale.mount` 7/7 and `android.nextweb.mount` 19/19 — the full
  creation chain (prompt → streamed reply → optimistic stop mid-drip →
  cancel settled by the 已请求停止 toast → CREATE round → creation card →
  fullscreen viewer carrying the file's own content). `session.attached` and
  `journal.frame.forwarded` are pinned `order: any` (the journal baseline
  races the probe's DOM phases by construction — the composer-live-write
  manifests' own convention).

The drive caught TWO real product defects on its way green, both fixed here:

1. **The interactive closure was missing its npm-scope packages.** Every
   `commands:true` boot (the RELEASE boot's default interactive
   configuration!) failed on the first import: command-feedback imports
   `@deepseek-ai/dsh-anonymous-user-id` at module load, and the
   goals/fileReferences coverage rows need `dsh-goal` +
   `dsh-file-reference{,-local}` — none staged on Android (nor on Harmony).
   iOS never saw this because its embedder carried all four. All four now
   stage from `runtime/spike/vendor/npm/@deepseek-ai/` (lib trees, minus
   .d.ts), byte-checked.
2. **A scripted tool-call pair must carry distinct wire indices.** Two
   `tool_calls` entries with `index: 0` in one delta merge into a single
   misnamed call (observed: `present` executed with `write`'s `file_path`
   arguments — the transcript dump surfaced it). The parity helper hardcoding
   index 0 was fine for its single-call shape; the create script now sends
   indices 0 and 1.

## Alternatives considered

- **Inject CSS into the official dist or extend the v0 client** — rejected
  when the iOS client landed (see the web-client-next note); this change
  only ports that decision.
- **A dedicated whale/next serving class per client** (duplicating the
  SessionWriteSession pattern per flavor) — rejected: the iOS seam (one
  SessionServe, hook block with no-op defaults, client-id swap) keeps ONE
  implementation of the serving path that both users and the manifest
  exercise.
- **Modifying `scenario/session-mock-llm.js` to post `bus.ready`** so the
  M4 host's default readiness gate works — rejected: the scenario is shared
  frozen evidence (m2 manifests pin it), and the honest fix is the
  whale-leg branch in `deliverHostHello` (the scenario's contract is the
  `host.info` EVENT, not the bus).
- **Whack-a-mole staging of the missing npm packages one at a time** —
  replaced by diffing the iOS embed list against the Android curated list
  and staging all four at once.

## Consequences

The Android release boot's interactive configuration (commands + skills +
goals + fileReferences + creation) is now actually bootable — before this
change it failed silently on the first module import. Harmony needs the same
four packages (its `vendor-official.sh` + `BUNDLE_FILES` rows land with its
port). The `60_000`-style numeric literals never appear in the probe legs
(plain `60000`), and the legs deliberately never nest (each posts exactly
one result — a nested `window.__next.type` call would interleave leg
results at the drive).
