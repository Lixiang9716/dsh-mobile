// dsh:logging-exempt (build-flavor constant; nothing to log through)
/**
 * BuildFlavor — the ArkTS half of the release log strip, decided at build
 * time by entry/build-profile.json5: BOTH buildOptionSet modes publish
 * `arkOptions.buildProfileFields.DSH_RELEASE` into hvigor's generated
 * BuildProfile module (true for release, false for debug), and the release
 * mode additionally passes `-DDSH_RELEASE=1` into the spike target's CMake
 * build, so the shared C host injects globalThis.__DSH_RELEASE__ and the JS
 * logger drops debug/info at the source.
 *
 * The harness (debug) is the verification vehicle — full structured logging,
 * E2E drives run. The release build is what a user gets: no E2E machinery,
 * no per-event stream, and the critical set retained. ArkTS sibling of
 * hosts/ios App/Source/SpikeRuntime.swift's BuildFlavor and hosts/android
 * BuildFlavor.kt.
 */
import { DSH_RELEASE } from 'BuildProfile';

export class BuildFlavor {
  /**
   * True in a release build (the debug mode's BuildProfile publishes the
   * literal false). Returned directly, never compared: ArkTS types each
   * mode's generated constant as its own boolean LITERAL, so `=== true`
   * is a "no overlap" compile error in the debug mode.
   */
  static isRelease(): boolean {
    return DSH_RELEASE;
  }
}
