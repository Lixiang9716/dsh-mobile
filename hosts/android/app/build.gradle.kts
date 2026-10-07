plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The Exec bash: a bare `bash` launched by a Windows parent resolves
// C:\Windows\System32\bash.exe — the WSL launcher (CreateProcess searches
// System32 BEFORE the PATH) — and the POSIX script arguments then go looking
// inside the WSL filesystem, failing "No such file or directory". Scan the
// PATH for bash.exe explicitly instead (Git for Windows wins there); POSIX
// hosts keep the bare name. DSH_BASH overrides the scan.
val execBash: String = when {
    !org.gradle.internal.os.OperatingSystem.current().isWindows -> "bash"
    else -> System.getenv("DSH_BASH")
        ?: System.getenv("PATH")?.split(File.pathSeparator)
            ?.map { File(it, "bash.exe") }
            ?.firstOrNull { it.isFile }?.absolutePath
        ?: "bash"
}

// The vendored engine sources are untracked by design (runtime/dsh/README.md):
// this materializes them (sha256-verified tarball, idempotent) before any build
// that compiles the engine. Absolute path: an Exec task inherits the launcher
// cwd, which must never decide whether the engine sources are found.
// POSIX spelling for the bash argument: a Windows absolutePath carries
// backslashes that bash consumes as escapes (`D:workspacedsh-mobile…`);
// forward slashes reach the shell intact on every host.
val ensureSpikeScript = layout.projectDirectory.file("../../../runtime/dsh/vendor/ensure.sh")
val ensureDshVendor = tasks.register<Exec>("ensureDshVendor") {
    commandLine(execBash, ensureSpikeScript.asFile.absolutePath.replace('\\', '/'))
}

// The official upstream web app is vendored UNTRACKED too
// (presentation/official-web: the dist + the application-tier client
// bundles; PROVENANCE + MANIFEST pinned). Stage both into the assets merge
// dir (official-web/dist/**, web-plugins/npm/@deepseek-ai/**) — Gradle packs
// them into the APK. Missing trees fail loud with the ensure-script fix —
// the check is a plain task because a Copy whose source is absent skips as
// NO-SOURCE before any doFirst can fire (rule 5); the D6 pin record wins
// for the bootstrap package (identical copy rule, same as the iOS runner's
// staging order). Paths are rootProject-relative: hosts/android + ../.. is
// the repo root (the app-module-relative ../../../ convention above does
// not apply here).
val officialDistDir = rootProject.file("../../presentation/official-web/dist")
val clientBundlesDir = rootProject.file("../../presentation/official-web/client-bundles")
val vendoredBootstrap = rootProject.file(
    "../../runtime/dsh/vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2",
)
val dshAssets = layout.buildDirectory.dir("generated/dsh-assets")

// The D9 spine closure (W-SESS vendored trees: 14 spine packages + the zod
// classic runtime closure) is UNTRACKED by the same discipline as the engine
// sources: hosts/android/ci/stage-spine-closure.sh materializes it from the
// ensure-dsh.sh pin (byte-identity-verified) into assets before packaging.
// The script fails loud when the runtime pin checkout is missing.
val stageSpineScript = rootProject.file("../../hosts/android/ci/stage-spine-closure.sh")
val stageSpineClosure = tasks.register<Exec>("stageSpineClosure") {
    commandLine(execBash, stageSpineScript.absolutePath.replace('\\', '/'))
}

val verifyOfficialTrees = tasks.register("verifyOfficialTrees") {
    group = "dsh"
    doLast {
        if (!officialDistDir.isDirectory) {
            throw GradleException(
                "official dist missing: $officialDistDir — run tools/e2e/ensure-official-dist.sh",
            )
        }
        if (!clientBundlesDir.resolve("npm").isDirectory) {
            throw GradleException(
                "client bundles missing: $clientBundlesDir — run tools/e2e/ensure-client-bundles.sh",
            )
        }
    }
}

val stageOfficialDist = tasks.register<Copy>("stageOfficialDist") {
    group = "dsh"
    dependsOn(verifyOfficialTrees)
    from(officialDistDir)
    into(dshAssets.map { it.dir("official-web/dist") })
}

val stageWebPlugins = tasks.register<Copy>("stageWebPlugins") {
    group = "dsh"
    dependsOn(stageOfficialDist)
    // The overlay below re-copies the bootstrap package over the build
    // output at the same path — the LAST copy wins (the pin), which is the
    // declared intent, so duplicates are included, not excluded.
    duplicatesStrategy = DuplicatesStrategy.INCLUDE
    from(clientBundlesDir.resolve("npm"))
    into(dshAssets.map { it.dir("web-plugins/npm") })
    // The pinned vendored tarball wins for the bootstrap package (D6 pin
    // record; byte-identical lib/client.js to the workspace build —
    // PROVENANCE); the path is relative to web-plugins/npm so the overlay
    // lands ON the staged package, not in a dead npm/npm/ double. When the
    // vendored tree is absent the manifest-verified build output stands.
    if (vendoredBootstrap.isDirectory) {
        from(vendoredBootstrap) {
            into("@deepseek-ai/dsh-client-modules@0.1.6-alpha.2")
        }
    }
}

android {
    namespace = "com.dshmobile.host"
    compileSdk = 35

    // aapt2's default ignore pattern excludes EVERY dotfile ('.*') from
    // assets — which silently dropped the vendored pi-ai
    // providers/data/.manifest.json (the providers barrel's require target)
    // from the APK while the repo staging carried it faithfully. Re-state
    // the pattern WITHOUT the '.*' token so the bundle's dotfiles package
    // (2026-09-29, the parity m4 mount's "cannot read
    // '.../data/.manifest.json'").
    androidResources {
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    // BuildConfig carries DSH_RELEASE into Kotlin; AGP 8 defaults the class
    // off, so ask for it (the Release build type sets the field below).
    buildFeatures {
        buildConfig = true
    }

    dshBuildTypes()
    dshSourceSets(assetDir = dshAssets)
    dshDefaultConfig()
    dshNativeBuild()

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// The android {} sub-configurations, one unit each and called above in the
// DSL's own order: the size gate measures Kotlin/Gradle blocks precisely since
// govrail 0.48.0, and a 75-line configuration block is one unit nobody skims.
private fun com.android.build.api.dsl.ApplicationExtension.dshBuildTypes() {
    buildTypes {
        // The harness (debug) is the verification vehicle: full structured
        // logging, the E2E drives run. The release build is what a user
        // gets: the define reaches BOTH halves — BuildConfig.DSH_RELEASE in
        // Kotlin and -DDSH_RELEASE in the dsh .so (where the shared C host
        // injects globalThis.__DSH_RELEASE__, which strips the JS logger to
        // the critical set) — and the drives refuse to start.
        release {
            isMinifyEnabled = false
            buildConfigField("boolean", "DSH_RELEASE", "true")
            externalNativeBuild {
                cmake {
                    // The dsh target is C-ONLY (CMakeLists: project(… C)), so
                    // the define must ride cFlags — cppFlags covers C++ sources
                    // and silently reaches nothing here.
                    cFlags += "-DDSH_RELEASE=1"
                }
            }
        }
        debug {
            buildConfigField("boolean", "DSH_RELEASE", "false")
        }
    }
}

private fun com.android.build.api.dsl.ApplicationExtension.dshSourceSets(
    assetDir: Provider<Directory>,
) {
    sourceSets {
        getByName("main") {
            // the staged official-web trees ride the normal assets merge
            assets.srcDir(assetDir)
        }
    }
}

private fun com.android.build.api.dsl.ApplicationExtension.dshDefaultConfig() {
    defaultConfig {
        applicationId = "com.dshmobile.host"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.1"
        ndk {
            // arm64-v8a drives the local AVD; x86_64 drives the CI emulator image.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                // C-only build: no C++ runtime needed.
                arguments += "-DANDROID_STL=none"
            }
        }
    }
}

private fun com.android.build.api.dsl.ApplicationExtension.dshNativeBuild() {
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
}

dependencies {
    // Intentionally none: plain android.app.Activity + TextView.
}

// Belt and braces: whatever task graph shape AGP picks, the native build,
// preBuild, and asset packaging all wait for the staged trees to be on disk.
tasks.configureEach {
    if (name.startsWith("buildCMake") || name.startsWith("externalNativeBuild") ||
        name == "preBuild" || name.startsWith("merge") && name.endsWith("Assets") ||
        name.startsWith("package") && name.endsWith("Assets") ||
        name.startsWith("bundleDebug") || name.startsWith("assemble")
    ) {
        dependsOn(ensureDshVendor, stageSpineClosure, stageWebPlugins)
    }
}
