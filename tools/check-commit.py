#!/usr/bin/env python3
"""commit-format gate: landed commits follow Angular Conventional Commits.

Header pattern: `type(scope)!: subject`
- type: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
- scope optional; letters, digits, dots, dashes
- optional `!` before the colon marks breaking changes
- subject: non-empty, does NOT start with an ASCII uppercase letter, does
  not end with `.`, and the full header stays within 100 characters

Range: commits in `origin/main..HEAD` — the unpushed set, which under
`gov run`, the pre-push hook, and CI (push event, fetch-depth 0) is exactly
what is about to land. Without origin/main, only HEAD is checked. Explicit
refs may be passed as arguments (e.g. `check-commit.py origin/main..HEAD`).

Exit 0 when nothing to check or all clean; 1 with one line per bad commit.
"""
import re
import subprocess
import sys

TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"
HEADER = re.compile(
    rf"^({TYPES})(\([A-Za-z0-9.-]+\))?(!)?: (?![A-Z])(.+?)(?<!\.)$"
)
MAX_HEADER = 100


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def commit_range(args):
    if args:
        return args[0]
    probe = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
        capture_output=True, text=True,
    )
    return "origin/main..HEAD" if probe.returncode == 0 else "HEAD"


def commits(rev):
    out = git("log", "--format=%h%x00%s", rev)
    return [(sha, subject) for sha, subject in
            (line.split("\x00", 1) for line in out.splitlines() if line)]


def check_subject(sha, subject):
    problems = []
    if len(subject) > MAX_HEADER:
        problems.append(f"header longer than {MAX_HEADER} chars")
    if not HEADER.match(subject):
        problems.append("header must be 'type(scope)?: subject' with a known type, "
                        "a non-uppercase subject start, and no trailing period")
    for problem in problems:
        print(f"{sha}: {problem} — {subject!r}")
    return len(problems)


def main():
    rev = commit_range(sys.argv[1:])
    commits_in_range = commits(rev)
    if not commits_in_range:
        print(f"commit-format: no commits in {rev} — nothing to check")
        return 0
    count = sum(check_subject(sha, subject) for sha, subject in commits_in_range)
    print(
        f"commit-format: {len(commits_in_range)} commit(s) in {rev} checked "
        f"against Angular Conventional Commits; {count} problem(s)"
    )
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main())
