#!/bin/sh
# build/build.sh — the ONE build entry for dsh-mobile (the DSH-method facade).
#
# What "build" means here, in order, per platform (ARCHITECTURE.md §8's
# one-core-three-hosts model made executable):
#
#   sync      re-stage the host's committed closure from the canonical
#             runtime/dsh tree (byte-identical, single source — D6/D9)
#   compile   the platform's own toolchain build, the exact command its
#             dev/<platform> CI workflow runs
#   test      the platform's log-verified e2e leg (never screenshots)
#
# So a green `build.sh <platform>` means the same thing it means in CI:
# the closure is fresh, the app compiled, and the scenario verdicts passed.
#
# usage:
#   build/build.sh [build|test|check|sync] [ios|android|harmony|core|all ...] [--release] [--list]
#
#   build/build.sh android            # sync + compile + test, one platform
#   build/build.sh android harmony    # multiple platforms
#   build/build.sh test ios           # the e2e leg only (build must be fresh)
#   build/build.sh check              # closure drift check only (the closures gate)
#   build/build.sh sync               # re-stage every committed closure
#   build/build.sh --list             # platforms + toolchain state, no work done
#
# The default command is `build`; the default platform set is `all`. `all` is
# the CI matrix — one machine rarely has every toolchain (iOS needs macOS), and
# a missing tool fails LOUD naming the tool and how to get it (rule 5), never a
# silent skip.
#
# dev script (out of the logging gate's scope; echo IS the product here).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

COMMAND=build
PLATFORMS=""
RELEASE=0
LIST=0

for arg in "$@"; do
    case "$arg" in
        build|test|check|sync) COMMAND=$arg ;;
        --release) RELEASE=1 ;;
        --list) LIST=1 ;;
        ios|android|harmony|core) PLATFORMS="$PLATFORMS $arg" ;;
        all) PLATFORMS="$PLATFORMS ios android harmony core" ;;
        *,*)
            # Comma lists are split here, so they are validated here — an
            # unknown token must never reach the stage dispatch, where a
            # missing case arm would silently skip it (fail loud, rule 5).
            for t in $(echo "$arg" | tr ',' ' '); do
                case "$t" in
                    ios|android|harmony|core) PLATFORMS="$PLATFORMS $t" ;;
                    all) PLATFORMS="$PLATFORMS ios android harmony core" ;;
                    *) echo "build: unknown platform '$t' in '$arg'" >&2
                       echo "usage: build/build.sh [build|test|check|sync] [ios|android|harmony|core|all ...] [--release] [--list]" >&2
                       exit 2 ;;
                esac
            done ;;
        *) echo "build: unknown platform or flag '$arg'" >&2
           echo "usage: build/build.sh [build|test|check|sync] [ios|android|harmony|core|all ...] [--release] [--list]" >&2
           exit 2 ;;
    esac
done
[ -n "$PLATFORMS" ] || PLATFORMS=" ios android harmony core"

# ---- toolchain probes (fail loud, name the tool) ----------------------------

need() { # $1=executable $2=how-to-get
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "::error::build: '$1' not found on PATH — $2" >&2
    return 1
}

have() { command -v "$1" >/dev/null 2>&1; }

ios_toolchain() {
    need xcodebuild "iOS compiles only on macOS with Xcode (CI: dev-ios.yml on macos-15)"
    need xcodegen "brew install xcodegen (regenerates DSHHost.xcodeproj from project.yml)"
}

android_toolchain() {
    need java "a JDK (CI pins the runner image's default)"
    [ -x hosts/android/gradlew ] || { echo "::error::build: hosts/android/gradlew missing" >&2; return 1; }
    if [ -z "${ANDROID_HOME:-}" ] && ! have adb; then
        echo "::error::build: ANDROID_HOME not set and no adb on PATH — install the Android SDK (CI: dev-android.yml installs NDK 27.0.12077973 + CMake 3.22.1)" >&2
        return 1
    fi
}

harmony_toolchain() {
    CLT=${DSH_CLT:-}
    if [ -z "$CLT" ] || [ ! -x "$CLT/bin/hvigorw" ]; then
        echo "::error::build: HarmonyOS command-line tools not found — set DSH_CLT to the directory containing bin/hvigorw (CI: dev-harmonyos.yml downloads the CLT; locally the DevEco install)" >&2
        return 1
    fi
}

core_toolchain() {
    need cmake "the C host + iSH engine build via CMake"
}

# ---- platform steps (the exact CI commands; BUILD.md keeps the mapping) -----

stage_sync() {
    case "$1" in
        ios)
            ios_toolchain
            echo "build: sync ios (embed the dsh bundle as C arrays + regen the project)"
            (cd hosts/ios && ./gen.sh) ;;
        android)
            echo "build: sync android (stage the spine closure into assets)"
            hosts/android/ci/stage-spine-closure.sh ;;
        harmony)
            echo "build: sync harmony (materialize the rawfile closure)"
            hosts/harmony/ci/vendor-official.sh --closure-only ;;
        core)
            echo "build: sync core (verify the vendored pins)"
            (cd runtime/dsh && ./vendor/ensure.sh) ;;
        *)
            echo "::error::build: sync: unknown platform '$1' (want ios|android|harmony|core)" >&2
            return 1 ;;
    esac
}

stage_compile() {
    case "$1" in
        ios)
            ios_toolchain
            echo "build: compile ios (xcodebuild, the dev-ios.yml command)"
            # POSIX sh on purpose (this script is dash-safe): `set -o pipefail`
            # is undefined there, so xcodebuild's status is carried explicitly —
            # the last 30 log lines still print on both paths.
            (cd hosts/ios
             xb_log=$(mktemp /tmp/dsh-xcodebuild.XXXXXX)
             xcodebuild build \
                 -project DSHHost.xcodeproj \
                 -scheme DSHHost \
                 -destination 'generic/platform=iOS Simulator' \
                 -derivedDataPath DerivedData \
                 >"$xb_log" 2>&1 || { xb_st=$?; tail -30 "$xb_log"; rm -f "$xb_log"; exit "$xb_st"; }
             tail -30 "$xb_log"
             rm -f "$xb_log") ;;
        android)
            android_toolchain
            echo "build: compile android (gradlew assembleDebug, the dev-android.yml command)"
            (cd hosts/android && ./gradlew assembleDebug --no-daemon) ;;
        harmony)
            harmony_toolchain
            CLT=${DSH_CLT:?}
            echo "build: compile harmony (hvigorw assembleHap, the dev-harmonyos.yml command)"
            (cd hosts/harmony && "$CLT/bin/ohpm" install --all)
            (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
                -p product=default -p buildMode=debug --no-daemon) ;;
        core)
            core_toolchain
            if [ "$RELEASE" = "1" ]; then
                echo "build: compile core (C host CLI, debug + release flavors)"
                (cd runtime/dsh && ./host/build.sh && ./host/build.sh --release)
            else
                echo "build: compile core (C host CLI, debug flavor)"
                (cd runtime/dsh && ./host/build.sh)
            fi ;;
        *)
            echo "::error::build: compile: unknown platform '$1' (want ios|android|harmony|core)" >&2
            return 1 ;;
    esac
}

stage_test() {
    case "$1" in
        ios)
            ios_toolchain
            echo "build: test ios (run-ios.sh: m1 legs + the UI-driven legs, log-verified)"
            test/e2e/run-ios.sh ;;
        android)
            android_toolchain
            need adb "the e2e leg installs the APK on an emulator (CI boots a system-images;android-35 emulator)"
            echo "build: test android (run-dsh-e2e.sh: the regression trio, log-verified)"
            hosts/android/ci/run-dsh-e2e.sh ;;
        harmony)
            harmony_toolchain
            echo "build: test harmony (run-host-e2e.sh: the on-device legs, log-verified)"
            hosts/harmony/ci/run-host-e2e.sh ;;
        core)
            echo "build: test core (the CLI proof legs over the vendored upstream spine)"
            runtime/dsh/ci/run-upstream-e2e.sh
            runtime/dsh/ci/run-upstream-boot-e2e.sh
            runtime/dsh/ci/run-settings-surfaces-e2e.sh
            runtime/dsh/ci/run-session-preset-join-node.sh
            runtime/dsh/ci/run-open-design-e2e.sh
            runtime/dsh/ci/run-office-e2e.sh
            runtime/dsh/ci/run-shim-exposure-probe.sh ;;
        *)
            echo "::error::build: test: unknown platform '$1' (want ios|android|harmony|core)" >&2
            return 1 ;;
    esac
}

# ---- commands ----------------------------------------------------------------

list_platforms() {
    echo "platforms (build = sync + compile + test):"
    for p in ios android harmony core; do
        case "$p" in
            ios)      s="SwiftUI host — macOS + Xcode + xcodegen" ;;
            android)  s="Compose host — JDK + Android SDK/NDK" ;;
            harmony)  s="ArkUI host — DevEco CLT via DSH_CLT" ;;
            core)     s="canonical runtime — cmake (the shared-core vehicle)" ;;
        esac
        echo "  $p  $s"
    done
    echo "run build/build.sh check for the closure drift gate (no toolchains needed)."
}

if [ "$LIST" = "1" ]; then
    list_platforms
    exit 0
fi

if [ "$COMMAND" = "check" ]; then
    exec "$ROOT/build/check-closures.sh"
fi

echo "build: command=$COMMAND platforms=[$PLATFORMS ] release=$RELEASE"
for p in $PLATFORMS; do
    if [ "$COMMAND" = "sync" ]; then
        echo ""
        echo "== build: sync $p ==============="
        stage_sync "$p"
    else
        echo ""
        echo "== build: $COMMAND $p ==============="
        case "$COMMAND" in
            build) stage_sync "$p"; stage_compile "$p"; stage_test "$p" ;;
            test)  stage_test "$p" ;;
        esac
    fi
done
echo ""
echo "build: $COMMAND done for [$PLATFORMS ]"
