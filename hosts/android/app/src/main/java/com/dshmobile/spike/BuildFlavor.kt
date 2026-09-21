package com.dshmobile.spike

/**
 * The build flavor, decided at build time by the Release configuration's
 * define (app/build.gradle.kts: `buildConfigField("boolean", "DSH_RELEASE",
 * "true")` for release, plus `-DDSH_RELEASE=1` through externalNativeBuild
 * cppFlags so the spike .so's shared C host injects the same flag into JS).
 *
 * The harness (debug) is the verification vehicle — full structured logging,
 * E2E drives run. The release build is what a user gets: no E2E machinery,
 * no per-event stream, and the critical set (warn/error) retained. Kotlin
 * sibling of hosts/ios App/Source/SpikeRuntime.swift's BuildFlavor.
 */
object BuildFlavor {
    val isRelease: Boolean = BuildConfig.DSH_RELEASE

    /**
     * One canonical record survives into a release build only when it is
     * warn/error class. The record is the unified logger's JSON envelope
     * (`{"level":…,"module":…,"message":…,"data":[…]}`), so the level is read
     * off the envelope rather than guessed from the text.
     */
    fun keeps(line: String): Boolean =
        !isRelease || line.contains("\"level\":\"warn\"") || line.contains("\"level\":\"error\"")
}
