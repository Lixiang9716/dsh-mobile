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


def _consume_open(line, i, state):
    """Consume while inside a block comment / template / quote; return next index."""
    if state["bc"]:
        if i + 1 < len(line) and line[i] == "*" and line[i + 1] == "/":
            state["bc"] = False
            return i + 2
        return len(line)
    closer = "`" if state["bt"] else state["q"]
    while i < len(line):
        if line[i] == "\\":
            i += 2
            continue
        if line[i] == closer:
            state["bt" if state["bt"] else "q"] = False
            return i + 1
        i += 1
    return i


def strip_code(line, state):
    """Blank out string/comment contents of one line, carrying multi-line state.

    state keys: bc (block comment), bt (backtick template), q (open quote char).
    Only structural characters (braces, keywords) survive.
    """
    out, i = [], 0
    while i < len(line):
        if state["bc"] or state["bt"] or state["q"]:
            i = _consume_open(line, i, state)
            continue
        nxt = line[i + 1] if i + 1 < len(line) else ""
        if line[i] == "/" and nxt == "/":
            break
        if line[i] == "/" and nxt == "*":
            state["bc"] = True
            i += 2
            continue
        if line[i] == "`":
            state["bt"] = True
            i += 1
            continue
        if line[i] in "'\"":
            state["q"] = line[i]
            i += 1
            continue
        out.append(line[i])
        i += 1
    return "".join(out)


def brace_functions(lines):
    """Yield (start_line, end_line) for heuristic brace-language functions."""
    state = {"bc": False, "bt": False, "q": None}
    stack, results = [], []
    for idx, raw in enumerate(lines, 1):
        code = strip_code(raw, state)
        if not stack and "{" in code and any(p.search(code) for p in SIG_PATTERNS):
            stack.append([idx, 0])
        if not stack:
            continue
        for ch in code:
            if ch == "{":
                stack[-1][1] += 1
            elif ch == "}":
                stack[-1][1] -= 1
                if stack[-1][1] <= 0:
                    results.append((stack.pop()[0], idx))
                    break
    return results


def _leading(raw):
    return raw[: len(raw) - len(raw.lstrip())]


def _indent_unit(leadings):
    positive = [n for n in leadings if n > 0]
    if not positive:
        return 4
    unit = min(positive)
    if unit in (1, 2, 4):
        return unit
    return 2 if leadings.count(2) >= leadings.count(4) else 4


def _indent_level(raw, unit, is_python):
    ws = _leading(raw)
    if is_python:
        return ws.count("\t") + len(ws) // 4
    if ws.startswith("\t"):
        return ws.count("\t")
    return len(ws) // unit


def indent_violations(lines, is_python):
    leadings = [len(_leading(l)) for l in lines if l.strip()]
    unit = 4 if is_python else _indent_unit(leadings)
    bad = []
    for idx, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        level = _indent_level(raw, unit, is_python)
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
        violations.extend(check_python(text))
    else:
        for start, end in brace_functions(lines):
            if end - start + 1 > MAX_FUNC_LINES:
                violations.append((start, "FUNC", f"{end - start + 1} lines > {MAX_FUNC_LINES}"))
    for line_no, level in indent_violations(lines, path.endswith(".py")):
        violations.append((line_no, "INDENT", f"indent level {level} > {MAX_INDENT_LEVEL}"))
    return violations


def check_python(text):
    violations = []
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [(e.lineno or 1, "PARSE", f"python syntax error: {e.msg}")]
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            span = node.end_lineno - node.lineno + 1
            if span > MAX_FUNC_LINES:
                violations.append((node.lineno, "FUNC", f"{span} lines > {MAX_FUNC_LINES}"))
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
