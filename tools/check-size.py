#!/usr/bin/env python3
"""code-size gate: source files <=500 lines, functions <=50 lines, indent <=5 levels.

Scope: git-tracked source files (extensions below). Checked from the repository
root, so it works identically under `gov run`, pre-push hooks, and CI.

Language coverage:
- Python: exact spans via the `ast` module.
- Brace languages (JS/TS/JSX/TSX/Swift/Kotlin): function-signature heuristics
  plus brace-depth tracking, after stripping strings and comments line-wise.
  Known approximation: brace-like interpolation inside string templates
  (e.g. Kotlin `${...}`) and multi-line constructs can skew the count for a
  single function; the team aligns on this ruler, not on a perfect parser.

Output: one `path:line kind detail` line per violation, then a summary.
Exit 0 when clean (or no tracked source files), 1 on any violation.
"""
import ast
import re
import subprocess
import sys
from pathlib import Path

MAX_FILE_LINES = 500
MAX_FUNC_LINES = 50
MAX_INDENT_LEVEL = 5

SOURCE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".kt", ".kts", ".py"}
PYTHON_EXTS = {".py"}
BRACE_EXTS = SOURCE_EXTS - PYTHON_EXTS

# Bare-method signature: `name(args) {` — exclude control-flow keywords so
# `if (...) {` is not counted as a function start.
CTRL = r"(?!(if|for|while|switch|catch|else|try|do|match|when|with|return|function)\b)"
SIG_PATTERNS = [
    re.compile(r"^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*[\w$]"),
    re.compile(r"^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s*)?(\([^)]*\)|[\w$]+)\s*=>\s*\{"),
    re.compile(r"^\s*(export\s+)?(abstract\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|override\s+|open\s+|suspend\s+)*(fun|func)\s"),
    re.compile(r"^\s*(async\s+)?" + CTRL + r"[A-Za-z_$][\w$]*\s*(<[^>()]*>)?\s*\([^;{}]*\)\s*\{\s*$"),
]


def tracked_sources():
    try:
        out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
        names = out.splitlines()
    except Exception:
        names = [str(p) for p in Path(".").rglob("*") if p.is_file()]
    return [n for n in names if Path(n).suffix in SOURCE_EXTS and Path(n).exists()]


def strip_code(line, state):
    """Blank out string/comment contents of one line, carrying multi-line state.

    state: dict with keys bc (in block comment), bt (in backtick template), q (open quote char).
    Returns the line with only structural characters (braces, keywords) preserved.
    """
    out = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        nxt = line[i + 1] if i + 1 < n else ""
        if state["bc"]:
            if c == "*" and nxt == "/":
                state["bc"] = False
                i += 2
            else:
                i += 1
            continue
        if state["bt"]:
            if c == "\\":
                i += 2
                continue
            if c == "`":
                state["bt"] = False
            i += 1
            continue
        if state["q"]:
            if c == "\\":
                i += 2
                continue
            if c == state["q"]:
                state["q"] = None
            i += 1
            continue
        if c == "/" and nxt == "/":
            break
        if c == "/" and nxt == "*":
            state["bc"] = True
            i += 2
            continue
        if c == "`":
            state["bt"] = True
            i += 1
            continue
        if c in "'\"":
            state["q"] = c
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def brace_functions(path, lines):
    """Yield (start_line, end_line) for heuristic brace-language functions."""
    state = {"bc": False, "bt": False, "q": None}
    stack = []  # [start_line, depth] entries
    results = []
    for idx, raw in enumerate(lines, 1):
        code = strip_code(raw, state)
        if not stack:
            if any(p.search(code) for p in SIG_PATTERNS) and "{" in code:
                stack.append([idx, 0])
        if stack:
            for ch in code:
                if ch == "{":
                    stack[-1][1] += 1
                elif ch == "}":
                    stack[-1][1] -= 1
                    if stack[-1][1] <= 0:
                        results.append((stack.pop()[0], idx))
                        if not stack:
                            break
    return results


def indent_violations(path, lines, is_python):
    bad = []
    unit = None
    leadings = []
    for raw in lines:
        if raw.strip():
            leadings.append(len(raw) - len(raw.lstrip(" ")))
    positive = [n for n in leadings if n > 0]
    if positive and not is_python:
        unit = min(positive)
        if unit not in (1, 2, 4):
            unit = 2 if leadings.count(2) >= leadings.count(4) else 4
    for idx, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        if is_python:
            level = (len(raw) - len(raw.lstrip(" "))) // 4 + raw[: len(raw) - len(raw.lstrip(" "))].count("\t")
        elif "\t" in raw[: len(raw) - len(raw.lstrip())] and not raw.lstrip().startswith(" "):
            level = len(raw) - len(raw.lstrip("\t"))
        else:
            level = (len(raw) - len(raw.lstrip(" "))) // (unit or 4)
        if level > MAX_INDENT_LEVEL:
            bad.append((idx, level))
    return bad


def check(path):
    violations = []
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    if len(lines) > MAX_FILE_LINES:
        violations.append((1, "FILE", f"{len(lines)} lines > {MAX_FILE_LINES}"))
    if path.endswith(".py"):
        try:
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    span = node.end_lineno - node.lineno + 1
                    if span > MAX_FUNC_LINES:
                        violations.append((node.lineno, "FUNC", f"{span} lines > {MAX_FUNC_LINES}"))
        except SyntaxError as e:
            violations.append((e.lineno or 1, "PARSE", f"python syntax error: {e.msg}"))
    else:
        for start, end in brace_functions(path, lines):
            if end - start + 1 > MAX_FUNC_LINES:
                violations.append((start, "FUNC", f"{end - start + 1} lines > {MAX_FUNC_LINES}"))
    for line_no, level in indent_violations(path, lines, path.endswith(".py")):
        violations.append((line_no, "INDENT", f"indent level {level} > {MAX_INDENT_LEVEL}"))
    return violations


def main():
    files = tracked_sources()
    if not files:
        print("code-size: no tracked source files — nothing to check")
        return 0
    all_violations = []
    for f in files:
        for line_no, kind, detail in check(f):
            all_violations.append(f"{f}:{line_no}: {kind} {detail}")
    for v in all_violations:
        print(v)
    print(
        f"code-size: {len(files)} source file(s) checked "
        f"(file<={MAX_FILE_LINES}, func<={MAX_FUNC_LINES}, indent<={MAX_INDENT_LEVEL}); "
        f"{len(all_violations)} violation(s)"
    )
    return 1 if all_violations else 0


if __name__ == "__main__":
    sys.exit(main())
