#!/usr/bin/env python3
"""code-size gate: source files <=500 lines, functions <=50 lines, indent <=5 levels.

Scope: git-tracked source files (extensions below). Checked from the repository
root, so it works identically under `gov run`, pre-push hooks, and CI.

Parsing backend, in order:
1. `gov parse --json` — govrail's declared parse primitive (tree-sitter facts:
   function spans, line counts). Primary for every language govrail ships.
2. Python `ast` — exact spans, used if gov parse is unavailable.
3. Signature heuristic + brace-depth — last resort for brace languages
   (documented approximation; Swift/Kotlin live here until grammars ship).

Indent depth is checked on code lines only — pure comment/string lines are
skipped so JSDoc continuation lines cannot poison the indent-unit detection.

Output: one `path:line kind detail` line per violation, then a summary line
reporting which backend each file used. Exit 0 clean, 1 on any violation.
"""
import ast
import json
import re
import subprocess
import sys
from pathlib import Path

MAX_FILE_LINES = 500
MAX_FUNC_LINES = 50
MAX_INDENT_LEVEL = 5

SOURCE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".kt", ".kts", ".py"}

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


def gov_facts(files):
    """Batch parse via govrail's parse primitive; {path: facts} or None."""
    if not files:
        return None
    try:
        out = subprocess.run(
            ["gov", "parse", *files, "--json"],
            capture_output=True, text=True, check=True, timeout=120,
        ).stdout
        facts = json.loads(out)
    except Exception:
        return None
    result = {}
    for entry in facts if isinstance(facts, list) else []:
        functions = [(f["start"], f["end"]) for f in entry.get("functions", [])]
        result[entry["path"]] = {"total": entry["lines"]["total"], "functions": functions}
    return result or None


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
    """Blank out string/comment contents of one line, carrying multi-line state."""
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
    """Heuristic (start_line, end_line) spans for brace-language functions."""
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
    """Check indent depth on code lines only — pure comment/string lines are
    skipped, so JSDoc continuation lines cannot poison the indent-unit detection."""
    state = {"bc": False, "bt": False, "q": None}
    code_lines = []
    for orig_idx, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        stripped = strip_code(raw, state)
        if stripped.strip():
            code_lines.append((orig_idx, stripped))
    leadings = [len(_leading(stripped)) for _, stripped in code_lines]
    unit = 4 if is_python else _indent_unit(leadings)
    bad = []
    for orig_idx, stripped in code_lines:
        level = _indent_level(stripped, unit, is_python)
        if level > MAX_INDENT_LEVEL:
            bad.append((orig_idx, level))
    return bad


def fallback_functions(path, lines):
    """ast (Python) or brace heuristic — used when gov parse is unavailable."""
    if path.endswith(".py"):
        try:
            tree = ast.parse("\n".join(lines))
        except SyntaxError:
            return []
        return [(n.lineno, n.end_lineno) for n in ast.walk(tree)
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return brace_functions(lines)


def check(path, facts):
    """Return (violations, backend) where backend is 'gov-parse' or 'fallback'."""
    violations = []
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    is_python = path.endswith(".py")
    if facts is not None:
        backend, total, spans = "gov-parse", facts["total"], facts["functions"]
    else:
        backend, total, spans = "fallback", len(lines), fallback_functions(path, lines)
    if total > MAX_FILE_LINES:
        violations.append((1, "FILE", f"{total} lines > {MAX_FILE_LINES}"))
    for start, end in spans:
        if end - start + 1 > MAX_FUNC_LINES:
            violations.append((start, "FUNC", f"{end - start + 1} lines > {MAX_FUNC_LINES}"))
    for line_no, level in indent_violations(lines, is_python):
        violations.append((line_no, "INDENT", f"indent level {level} > {MAX_INDENT_LEVEL}"))
    return violations, backend


def main():
    files = tracked_sources()
    if not files:
        print("code-size: no tracked source files — nothing to check")
        return 0
    facts = gov_facts(files)
    if facts is None:
        print("code-size: note — gov parse unavailable, ast/heuristic fallback in effect")
    all_violations, backends = [], {}
    for f in files:
        violations, backend = check(f, facts.get(f) if facts else None)
        backends[f] = backend
        for line_no, kind, detail in violations:
            all_violations.append(f"{f}:{line_no}: {kind} {detail}")
    for v in all_violations:
        print(v)
    gov_count = sum(1 for b in backends.values() if b == "gov-parse")
    print(
        f"code-size: {len(files)} source file(s) checked "
        f"({gov_count} via gov parse, {len(files) - gov_count} fallback; "
        f"file<={MAX_FILE_LINES}, func<={MAX_FUNC_LINES}, indent<={MAX_INDENT_LEVEL}); "
        f"{len(all_violations)} violation(s)"
    )
    return 1 if all_violations else 0


if __name__ == "__main__":
    sys.exit(main())
