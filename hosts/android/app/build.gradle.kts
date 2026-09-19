plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The vendored engine sources are untracked by design (runtime/spike/README.md):
// this materializes them (sha256-verified tarball, idempotent) before any build
// that compiles the engine. Absolute path: an Exec task inherits the launcher
// cwd, which must never decide whether the engine sources are found.
val ensureSpikeScript = layout.projectDirectory.file("../../../runtime/spike/vendor/ensure.sh")
val ensureSpikeVendor = tasks.register<Exec>("ensureSpikeVendor") {
    commandLine("bash", ensureSpikeScript.asFile.absolutePath)
}

android {
    namespace = "com.dshmobile.spike"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dshmobile.spike"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-spike"
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

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Intentionally none: plain android.app.Activity + TextView.
}

// Belt and braces: whatever task graph shape AGP picks, the native build and
// preBuild both wait for the vendored engine sources to be on disk.
tasks.configureEach {
    if (name.startsWith("buildCMake") || name.startsWith("externalNativeBuild") || name == "preBuild") {
        dependsOn(ensureSpikeVendor)
    }
}
