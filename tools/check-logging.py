#!/usr/bin/env python3
"""logging gate: unified logger only, per-module logger, per-function logs, release silence.

Scope: git-tracked JS/TS files under runtime/, system-plugins/, presentation/, hosts/.
(excluding files marked `// dsh:logging-exempt` in their first lines; tools/ dev
scripts are out of scope entirely).

Rules:
  L1  no bare `console.(log|debug|info|warn|error|trace)` calls — log through
      `createLogger` from runtime/logger
  L2  every module containing a block-bodied function declares a logger via
      `createLogger(...)` and uses it as `log.*`
  L3  every block-bodied function body contains at least one `log.*` call
      (expression-bodied arrows are exempt; nested-function bodies are
      attributed to the innermost function, never the outer one)
  L4  the release strip is REAL end to end, not a branch one file carries:
      a) runtime/logger keeps its `__DSH_RELEASE__` no-op branch;
      b) runtime/spike/logger.js — the logger the SHIPPED app actually runs —
         honors the injected `globalThis.__DSH_RELEASE__`;
      c) every host's Release configuration actually DEFINES the flag (iOS,
         Android, HarmonyOS) and the desktop CLI has a release build mode.
      The 2026-09-21 audit found (a) true while (b) did not exist and (c) was
      empty, so the "mechanism" was cosmetic: nothing ever set the flag and
      the shipping logger had no branch at all. (c) is what makes this rule
      able to see that violation.

Function boundaries are reused from tools/check-size.py (same heuristic ruler).
Exit 0 clean, 1 on any violation.
"""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

SCOPE_DIRS = ("runtime/", "system-plugins/", "presentation/", "hosts/")
# .ets is ArkTS (#343): the layer most likely to log natively was the one
# this gate never inspected — a false green (rule 6). The tree-sitter TS
# grammar ERRORs on ArkTS `struct` syntax, so gov parse skips these files
# and the brace heuristic carries them, exactly like Kotlin/Swift in the
# size gate. Files whose contract is a native logger (hilog) declare
# // dsh:logging-exempt instead of silently sitting outside scope.
EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".ets"}
LOGGER_DIR = "runtime/logger"
EXEMPT_MARKER = "// dsh:logging-exempt"
EXEMPT_SCAN_LINES = 12
# Vendored upstream packages live under a vendor/ dir and are kept verbatim
# (upstream discipline): they cannot declare our logger, so the unified-
# logging contract applies only to code this repo authors.
VENDOR_SEGMENT = "/vendor/"

LOGGER_FACTORY = re.compile(r"\bcreateLogger\s*\(")
BARE_CONSOLE = re.compile(r"\bconsole\.(log|debug|info|warn|error|trace)\s*\(")
LOG_CALL = re.compile(r"\blog\s*\.(debug|info|warn|error)\s*\(")

# L4: the operative logger (the one the shipped app actually runs — the
# canonical TS file is bundled by nothing) and the JS global the shared C host
# injects under -DDSH_RELEASE.
OPERATIVE_LOGGER = "runtime/spike/logger.js"
RELEASE_GLOBAL = "globalThis.__DSH_RELEASE__"

# L4c: every host's Release configuration must DEFINE the flag. One row per
# platform; the marker is the define as it appears in that build system, so a
# silently dropped define names the exact file that lost it (rule 5).
PLUMBING = (
    ("iOS", "hosts/ios/DSHSpike.xcodeproj/project.pbxproj",
     "SWIFT_ACTIVE_COMPILATION_CONDITIONS = DSH_RELEASE"),
    ("Android", "hosts/android/app/build.gradle.kts", "DSH_RELEASE"),
    ("HarmonyOS", "hosts/harmony/entry/build-profile.json5", "DSH_RELEASE"),
    ("macOS CLI", "runtime/spike/host/build.sh", "DSH_RELEASE"),
)


def _load_sibling():
    spec = importlib.util.spec_from_file_location(
        "check_size", Path(__file__).resolve().parent / "check-size.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cs = _load_sibling()


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True,
        encoding="utf-8", errors="replace",
    ).stdout
    return [
        n for n in out.splitlines()
        if n.startswith(SCOPE_DIRS) and VENDOR_SEGMENT not in n
        and Path(n).suffix in EXTS and Path(n).exists()
    ]


def is_exempt(text):
    return EXEMPT_MARKER in "\n".join(text.splitlines()[:EXEMPT_SCAN_LINES])


def uncovered(funcs, index):
    """Line numbers of function #index not covered by any other (nested) function."""
    start, end = funcs[index]
    covered = set()
    for other, (s2, e2) in enumerate(funcs):
        if other != index and s2 >= start and e2 <= end:
            covered.update(range(s2, e2 + 1))
    return set(range(start, end + 1)) - covered


def check_file(path):
    """Return violation strings for one file."""
    out = []
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    exempt = is_exempt(text)
    if not exempt:
        for m in BARE_CONSOLE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            out.append(f"{path}:{line_no}: L1 bare console call — use createLogger")
    funcs = cs.brace_functions(lines)
    if funcs and not exempt and not LOGGER_FACTORY.search(text):
        out.append(f"{path}:1: L2 module has functions but no createLogger declaration")
    if not exempt:
        for i, _ in enumerate(funcs):
            body = [lines[n - 1] for n in sorted(uncovered(funcs, i))]
            if not any(LOG_CALL.search(l) for l in body):
                start = funcs[i][0]
                out.append(f"{path}:{start}: L3 function body has no log call")
    return out


def check_release_silence(files):
    out = []
    logger_files = [f for f in files if f.startswith(LOGGER_DIR) and f.endswith((".ts", ".js"))]
    if not logger_files:
        out.append(f"{LOGGER_DIR}: L4 no logger module found — the canonical logger is missing")
    elif not any("__DSH_RELEASE__" in Path(f).read_text(encoding="utf-8", errors="replace")
                 for f in logger_files):
        out.append(f"{LOGGER_DIR}: L4a release no-op branch (__DSH_RELEASE__) missing")

    # L4b: the logger the SHIPPED app runs. The canonical TS logger is bundled
    # by nothing; runtime/spike/logger.js is embedded byte-identically into the
    # iOS C arrays, the Android assets and the HarmonyOS rawfile tree. A
    # release branch in the canonical file alone strips nothing.
    operative = Path(OPERATIVE_LOGGER)
    if not operative.exists():
        out.append(f"{OPERATIVE_LOGGER}: L4b the operative spike logger is missing")
    else:
        text = operative.read_text(encoding="utf-8", errors="replace")
        if RELEASE_GLOBAL not in text:
            out.append(
                f"{OPERATIVE_LOGGER}: L4b does not honor the injected "
                f"{RELEASE_GLOBAL} — the shipped app's debug/info would survive "
                f"a release build")
        for level in ("debug", "info"):
            if not re.search(rf"\b{level}\b\s*\(\s*\)\s*\{{", text):
                out.append(
                    f"{OPERATIVE_LOGGER}: L4b no release no-op for '{level}' "
                    f"(warn/error must stay live, debug/info must fold away)")

    # L4c: a branch nobody defines is cosmetic — the flag must be DEFINED by
    # each host's Release configuration and by the CLI's release mode.
    for label, path, marker in PLUMBING:
        f = Path(path)
        if not f.exists():
            out.append(f"{path}: L4c {label} build config is missing — cannot confirm "
                       f"the release flag is defined")
            continue
        if marker not in f.read_text(encoding="utf-8", errors="replace"):
            out.append(f"{path}: L4c {label} Release configuration does not define "
                       f"the release flag ('{marker}' absent) — the strip is cosmetic")
    return out


def main():
    files = tracked_files()
    if not files:
        print("logging: no in-scope files — nothing to check")
        return 0
    violations = check_release_silence(files)
    for f in files:
        violations.extend(check_file(f))
    for v in violations:
        print(v)
    print(f"logging: {len(files)} file(s) checked (L1 console / L2 module logger / "
          f"L3 function logs / L4 release silence); {len(violations)} violation(s)")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
