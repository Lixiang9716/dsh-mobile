#!/usr/bin/env python3
"""doc-crosslinks gate: every bilingual doc pair must link to its counterpart.

A pair is <stem>.md + <stem>.zh.md where both sides are git-tracked and the
English side is in scope (README.md at the root, docs/**/*.md) — matching the
pairing gate's scope.

Rule: each side must contain a markdown link whose target resolves to the
other side's file (loose match: target ends with the counterpart's basename,
optionally followed by an anchor). Readers must always be able to hop
languages from the page itself, without going through the repo listing.

Exit 0 clean (or no pairs), 1 listing every side that lacks its link.
"""
import re
import subprocess
import sys
from pathlib import Path


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [n for n in out.splitlines() if n.endswith(".md") and Path(n).exists()]


def in_scope(name):
    return name == "README.md" or name.startswith("docs/")


def links_to(text, counterpart):
    """Loose markdown-link match: target ends with the counterpart basename."""
    base = re.escape(Path(counterpart).name)
    return re.search(r"\]\([^)]*/?" + base + r"(#[^)]*)?\)", text) is not None


def main():
    files = set(tracked_files())
    violations = []
    for name in sorted(files):
        if not in_scope(name):
            continue
        zh_name = name[:-3] + ".zh.md"
        if zh_name not in files:
            continue
        en_text = Path(name).read_text(encoding="utf-8", errors="replace")
        zh_text = Path(zh_name).read_text(encoding="utf-8", errors="replace")
        if not links_to(en_text, zh_name):
            violations.append(f"{name}: missing cross-language link to {zh_name}")
        if not links_to(zh_text, name):
            violations.append(f"{zh_name}: missing cross-language link to {name}")
    if not violations and not any(1 for n in files if in_scope(n)):
        print("doc-crosslinks: no in-scope documents — nothing to check")
        return 0
    for v in violations:
        print(v)
    print(f"doc-crosslinks: each bilingual pair must link both ways; {len(violations)} violation(s)")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
