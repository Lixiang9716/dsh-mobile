# Agent Note: the C host compiles clean, and what the other build warnings actually are

Status: implemented
Related: D2, D13

## Problem

Read out of the CI build logs (history as the evidence, no re-runs), the three
platform builds emitted warnings in six families. Only some of them are this
repository's to fix, and telling them apart is most of the work.

**Mine, in `runtime/spike/host/dsh_spike_host.c`** — reported by the Android
build's C/C++ step:

```
dsh_spike_host.c:16:53: warning: '/*' within block comment [-Wcomment]
dsh_spike_host.c:109:13: warning: unused function 'dsh_emit' [-Wunused-function]
```

The first is a literal `/*` inside a block comment (the `@deepseek-ai/*` glob),
which opens a nested comment as far as the compiler is concerned. The second is
dead code: `dsh_emit` was `static` and referenced nowhere in the host tree.

**Two more, invisible to CI's flag set.** Recompiling the same file with
`-Wall -Wextra -Wcomment -Wunused-function` reported **4** warnings, not 2 — the
extra pair being unused parameters that CI's flags do not enable. A warning
budget measured with a weaker flag set understates itself.

**Not this repository's:**

- `clang: warning: argument unused during compilation: '--gcc-toolchain=…'`
  (7 occurrences) — emitted by the **HarmonyOS CLT's own CMake toolchain file**,
  which passes a GCC flag to clang. Silencing it means weakening a whole warning
  class for everyone, or forking Huawei's toolchain.
- `(node:NNNN) [DEP0040] DeprecationWarning: The 'punycode' module is
  deprecated` — raised **inside `actions/setup-node`**, in the action's own
  runtime. Not addressable from a workflow file.
- ArkTS deprecations in this repository's `.ets` files — real, but a migration
  rather than a warning fix: `'notification' has been deprecated`,
  `'NOTIFICATION_CONTENT_BASIC_TEXT' has been deprecated`, `'ContentType' has
  been deprecated`, plus `Function may throw exceptions. Special handling is
  required.` and three `The system capacity of this api '<x>' is not supported on
  all devices`. Named as its own change so a working permission path is not
  rushed for a log line.
- Xcode: `Run script build phase 'StageOfficialWeb' will be run during every
  build because it does not specify any outputs` — this repository's project
  config, but the phase is **not in `hosts/ios/project.yml`**, only in the
  generated `project.pbxproj`, so fixing it properly means establishing how that
  phase is generated first.

## Decision

**The C host compiles with zero warnings under `-Wall -Wextra -Wcomment
-Wunused-function`.**

The `/*` becomes `@deepseek-ai/<pkg>` — same meaning, no nested comment. The
dead `dsh_emit` is **deleted** rather than annotated unused: it is `static` and
referenced nowhere, and a silent `unused` attribute on dead code keeps the code
without keeping the reason. The two unused parameters are silenced with `(void)`
statements, which is how this file already handles `this_val` — the signature is
left alone because callers and the JS binding depend on it.

Verified with the flag set that exposes all four, and the project's own
`runtime/spike/host/build.sh` still builds `build/dsh-spike-cli`.

## Alternatives considered

**Add `-Wno-unused-parameter` (or `-Wno-unused-function`) to the build.** Rejected:
suppressing a class to silence four instances removes the class's future value,
and the instances were a comment, dead code, and two casts.

**Mark `dsh_emit` `__attribute__((unused))` instead of deleting it.** Rejected —
it is unreachable and unexported; a comment would have been the only thing
keeping it alive.

**Change `dsh_require_resolve`'s signature to drop `out_len`.** Rejected for now:
the parameter documents the caller contract, and the fix belongs with whoever
next touches that function's buffer sizing, not with a warning sweep.

**Fix the ArkTS deprecations in the same change.** Rejected: they are in the
permission and notification paths, which the E2E exercises end to end
(`m5.host-binding` 27/27). A migration there needs its own run, not a ride-along
on a warning cleanup.
