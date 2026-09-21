# Agent Note: the HarmonyOS host compiles with zero ArkTS warnings — the notification migration, the throw declarations, and one measured linter false positive

Status: implemented

## Problem

The `dev/harmonyos` build emitted **27 ArkTS warnings across 6 `.ets` files** —
verified twice: locally from a clean debug build
(`hvigorw assembleHap --mode module -p product=default -p buildMode=debug
--no-daemon`) and again by counting `ArkTS:WARN File:` in the CI job of the head
commit (27). The previous change — the C host's warning sweep — read them out of
the logs but deliberately deferred them, with the reason that the notification
and keychain paths are exercised end to end **only** by the on-device
`m5.host-binding` battery, so a migration there needed its own run.

The inventory, by message:

- **21 × `Function may throw exceptions. Special handling is required.`** —
  `KeychainPrimitives.ets` 10 (`fs.openSync`/`statSync`/`readSync`/`closeSync`,
  `cryptoFramework.createMd`, `md.updateSync`/`digestSync`, `huks.initSession`/
  `finishSession`/`generateKeyItem`), `CarrierServer.ets` 5 (`socket`'s
  `close()`), `PickerPrimitives.ets` 3, `OfficialServe.ets` 2
  (`resourceManager.getRawFileListSync`), `pages/Index.ets` 1
  (`getRawFileContent`). The checker fires for a call to a function the SDK
  documents with `@throws` when the call is neither inside a `try` **with a
  `catch` clause** (`try/finally` does not count) nor inside a method that
  itself declares `@throws`.
- **3 × `'notification' / 'ContentType' / 'NOTIFICATION_CONTENT_BASIC_TEXT' has
  been deprecated`** — all on `HostPhase.ets:513`, the `notify` primitive's
  request body.
- **3 × `The system capacity of this api '<createRandom|generateRandomSync|\
createMd>' is not supported on all devices`** — `KeychainPrimitives.ets`.

Two further `hvigor` warnings appear in the same log and are **explicitly not
part of this change**: `Unexpected source code files packaged in 'entry'` (the
`.d.ts` files of the vendored upstream packages, staged into `rawfile/` verbatim
by design — deleting them breaks the verbatim claim, and switching off
`packOptions.enableSourceCodeCheck` is its own decision) and `No signingConfig
found for product default` (the documented unsigned-by-design state). Both
predate this change; neither is an ArkTS warning.

## Decision

**The build is clean: 0 ArkTS warnings, on the same command and in the runner's
own build log.**

1. **Notification, migrated rather than suppressed.** `notification` from
   `@ohos.notification` is deprecated since API 9; the request body's
   `contentType` field is deprecated since API 11 in favour of
   `notificationContentType`, typed `notificationManager.ContentType`. The field
   is renamed, the enum comes from the already-imported `@kit.NotificationKit`,
   and the deprecated import is deleted.

2. **The 21 throw sites: `@throws` on the enclosing method**, which is the
   checker's own exit for "this method propagates exceptions" — and it is true:
   the errors travel to a `run()` catch that maps them to GatewayError codes.
   Where the code already had a better answer than declaring, that answer is
   used instead of the declaration:

   - `CarrierServer`: the five `close()` sites collapse into one `closeQuietly`
     (plus the two teardown sites in `stop()` and the socket `'close'` handler),
     which logs the failure and swallows it. A throw there would escape into a
     socket event handler and take the carrier's fault handling with it, and the
     connection is going away regardless.
   - `KeychainPrimitives.get`/`set`: the ref-keying call runs *before* the async
     body, so its failure had no `run()` catch behind it — a throw escaped into
     the dispatch sink and left the call **unanswered**. Both now settle an `io`
     rejection instead.
   - `PickerPrimitives.writeRegistry` returns a boolean; `fsScope.persist`
     rejects with `io` when the registry could not be written, instead of
     claiming a persisted ref that the next launch cannot resolve.
   - `OfficialServe` and `Index`: the rawfile calls are wrapped and re-stated
     with the searched path (`official-web plugins not staged: <prefix> …`) or
     turned into the same rejected promise the materialization chain already
     reports — a build defect named, never a bare `BusinessError`.

3. **The three syscap warnings are a toolchain false positive, and the
   suppression is scoped and explained.** The SDK documents those APIs with a
   *versioned* syscap (`@syscap SystemCapability.Security.CryptoFramework [since
   9 - 11]`, then `…CryptoFramework.Rand [since 12]`), and the checker compares
   the raw tag text — version bracket included — against the phone syscap set,
   which can never match. Measured, not assumed: `canIUse()` with the *real*
   syscap does **not** clear the warning, while
   `canIUse('…CryptoFramework.Rand [since 12]')` does — which is how the
   mechanism was pinned down, and why `canIUse` is not the fix. Both syscaps are
   in the device set (`api/device-define/default.json`), so the finding is
   false. `// @SuppressWarnings syscap` is applied per call site, with the
   reasoning in the file header.

   That silencer's own rules shape the code: it reads the **leading comment of
   the enclosing statement**, it must be a `//` comment, and its chain-call walk
   climbs past an arrow-function body without finding one. Hence two crypto
   factories are private *methods* (`newNonce`, `sha256HexSync`) rather than
   inline in the callback, and the fresh-nonce call is split into two statements
   so each has its own comment.

4. **Verified on the device, because that is where these paths run.** The host
   E2E battery (`hosts/harmony/ci/run-host-e2e.sh`) is green end to end on the
   emulator (`dsh_phone`, 127.0.0.1:5557), one build + install + drive:

   ```
   e2e: PASS m1.spike.boot (7/7 events, in order)
   e2e: PASS m2.bridge.smoke (6/6 events, in order)
   e2e: PASS m2.session (23/23 events, in order)
   e2e: PASS m5.host-binding (27/27 events, in order)
   e2e: PASS b-harmony.official-web-mount (17/17 events, in order)
   e2e: PASS b-harmony.httpfetch-v2 (6/6 events, in order)
   e2e: PASS b-harmony.session.live (43/43 events, in order)
   e2e: PASS b-harmony.write.live (33/33 events, in order)
   ```

   The drive exercises the migrated paths directly: the notification shade and
   the DSH notification (the `notify` request body), and the keychain/picker
   grant-and-persist path. The run was made with the runner's default artifacts
   dir, which would have written the four official-web legs' verdicts into
   `hosts/harmony/artifacts/m5-host/` alongside that unit's own — so the
   refreshed artifacts were NOT committed: each leg's evidence belongs to the
   unit the `DSH_*_ART` convention names (`d9-official-web`, `d9-session-live`,
   `d9-write-live`), and the committed `m5-host` unit stays as its receipt
   describes it. The verdict block above is the run's record.

5. **No shared code changed, so the iOS and Android legs are not implicated.**
   The diff is 6 `.ets` files under `hosts/harmony/`; `runtime/`, `contract/`,
   `presentation/` and `hosts/ios|android` are untouched, which is what
   `gov change-scope` reports and what those legs' path filters select on. The
   smallest sufficient set here is the harmony leg, and it ran.

## Alternatives considered

**`canIUse('<the real syscap>')` in front of the three crypto calls.** Rejected
on measurement: it does not clear the warning (the raw tag text carries the
version bracket). Adding it would have meant a guard that can never fire *and*
a warning that stays — a comment claiming safety plus the noise it was meant to
answer.

**A `try`/`catch` at each of the 21 throw sites.** Rejected: their only honest
action would be to rethrow (`@throws` says the same thing once, per method), and
21 catch blocks would hide the four sites where handling rather than declaring
was right — which is exactly where the engineering in item 2 happened.

**`@SuppressWarnings syscap` at the file level (or on the class).** Rejected:
the suppression belongs on the three call sites that trip the false positive. A
file-wide switch would also swallow the day the checker grows a real syscap
finding in this file.

**Keep deferring them, as the C host change did.** Rejected: the owner's bar is
"every production piece fixed or explicitly N/A", and no permission path is
being rushed here any more — the migration is a rename plus declarations, and
the device battery that covers it now exists and is green.

**Also clear the hvigor packaging warning in this change.** Rejected: it is not
an ArkTS warning, the offending files are the vendored upstream `.d.ts` set that
this directory exists to ship verbatim, and silencing a pack check deserves its
own decision rather than a ride-along.
