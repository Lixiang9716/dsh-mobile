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
  L4  runtime/logger keeps its `__DSH_RELEASE__` no-op branch — the mechanism
      that makes logging disappear in release builds must stay wired

Function boundaries are reused from tools/check-size.py (same heuristic ruler).
Exit 0 clean, 1 on any violation.
"""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

SCOPE_DIRS = ("runtime/", "system-plugins/", "presentation/", "hosts/")
EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
LOGGER_DIR = "runtime/logger"
EXEMPT_MARKER = "// dsh:logging-exempt"
EXEMPT_SCAN_LINES = 12

LOGGER_FACTORY = re.compile(r"\bcreateLogger\s*\(")
BARE_CONSOLE = re.compile(r"\bconsole\.(log|debug|info|warn|error|trace)\s*\(")
LOG_CALL = re.compile(r"\blog\s*\.(debug|info|warn|error)\s*\(")


def _load_sibling():
    spec = importlib.util.spec_from_file_location(
        "check_size", Path(__file__).resolve().parent / "check-size.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cs = _load_sibling()


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [
        n for n in out.splitlines()
        if n.startswith(SCOPE_DIRS) and Path(n).suffix in EXTS and Path(n).exists()
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
    logger_files = [f for f in files if f.startswith(LOGGER_DIR) and f.endswith((".ts", ".js"))]
    if not logger_files:
        return []
    wired = any("__DSH_RELEASE__" in Path(f).read_text(encoding="utf-8", errors="replace")
                for f in logger_files)
    return [] if wired else [f"{LOGGER_DIR}: L4 release no-op branch (__DSH_RELEASE__) missing"]


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
