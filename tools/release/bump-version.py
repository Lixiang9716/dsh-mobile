#!/usr/bin/env python3
"""Bump every version file, and write the changelog section for the release.

The version-bump commit is authored by a person or an agent on a normal branch
(D13/D14), so it goes through the ordinary pull request flow and gets the
ordinary `gates` check. That is the whole point of this script: the bump is
mechanical and easy to get subtly wrong by hand — four files, three formats,
one of them JSON5 — so it is one command instead of four edits, and every edit
is re-read and asserted.

    tools/release/bump-version.py 0.1.0            # bump to 0.1.0
    tools/release/bump-version.py 0.1.0 --dry-run  # show what would change

Then: commit, open a PR, merge it, and push the tag. The tag is the release
trigger (D12) and `check-tag-version.sh` runs in the package workflows, so the
two cannot drift apart without a loud failure.

The suggested version is derived from the conventional commits since the last
tag and printed as a hint — a person makes the call, but nobody should have to
count commit types by hand.
"""

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# (path, human label, regex whose group 2 is the version). version.txt's
# regex is unused — it holds the version alone.
EDITS = [
    ("version.txt", "the version stream's source of truth", r"(?s)^(.*)$"),
    ("hosts/ios/App/Info.plist", "CFBundleShortVersionString",
     r"(<key>CFBundleShortVersionString</key>\s*<string>)([^<]*)(</string>)"),
    ("hosts/android/app/build.gradle.kts", "versionName",
     r'(\bversionName\s*=\s*")([^"]*)(")'),
    ("hosts/harmony/AppScope/app.json5", "versionName",
     r'("versionName"\s*:\s*")([^"]*)(")'),
]

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
CONVENTIONAL = re.compile(r"^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$")

HEADINGS = (("feat", "Features"), ("fix", "Bug Fixes"))


def die(msg: str) -> None:
    print(f"bump-version: FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def git(*args: str) -> str:
    """Run git in the repo; fail loud rather than returning a half-answer."""
    proc = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        die(f"git {' '.join(args)}: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout


def current_version() -> str:
    path = REPO / "version.txt"
    if not path.is_file():
        die("version.txt is missing — it is the version source of truth")
    value = path.read_text(encoding="utf-8").strip()
    if not SEMVER.match(value):
        die(f"version.txt does not hold a semver version (got {value!r})")
    return value


def last_tag() -> str | None:
    """The most recent v* tag, or None when nothing is tagged yet."""
    proc = subprocess.run(
        ["git", "-C", str(REPO), "describe", "--tags", "--abbrev=0",
         "--match", "v*"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    return proc.stdout.strip() or None if proc.returncode == 0 else None


def commits_since(ref: str | None) -> list[str]:
    rng = f"{ref}..HEAD" if ref else "HEAD"
    return [c for c in git("log", rng, "--format=%s").splitlines() if c.strip()]


def suggest(commits: list[str], base: str) -> tuple[str, str]:
    """The version the conventional commits imply, and why.

    Pre-1.0 rules, matching what this repository has always published: a
    breaking change bumps the minor rather than jumping to 1.0.0.
    """
    major, minor, patch = (int(p) for p in base.split("."))
    if any("!:" in c or "BREAKING CHANGE" in c for c in commits):
        return f"{major}.{minor + 1}.0", "a breaking change"
    if any(c.startswith("feat") for c in commits):
        return f"{major}.{minor + 1}.0", "at least one feat"
    if any(c.startswith("fix") for c in commits):
        return f"{major}.{minor}.{patch + 1}", "at least one fix"
    return base, "no feat or fix (a release with no user-visible change)"


def classify(commit: str) -> tuple[str, str]:
    """(changelog heading, bullet line) for one commit subject."""
    m = CONVENTIONAL.match(commit)
    if not m:
        return "Other Changes", f"* {commit}"
    kind, scope, subject = m.group(1), m.group(2), m.group(3).strip()
    line = f"* **{scope}:** {subject}" if scope else f"* {subject}"
    for prefix, heading in HEADINGS:
        if kind == prefix:
            return heading, line
    return "Other Changes", line


def render_section(version: str, commits: list[str], today: str) -> str:
    groups: dict[str, list[str]] = {}
    for commit in commits:
        heading, line = classify(commit)
        groups.setdefault(heading, []).append(line)
    body = [f"## [{version}] - {today}"]
    for heading in ("Features", "Bug Fixes", "Other Changes"):
        if groups.get(heading):
            body += ["", f"### {heading}", ""] + groups[heading]
    return "\n".join(body) + "\n"


def plan_edits(version: str) -> list[tuple[Path, str]]:
    """Resolve every edit, or die before any file is touched.

    A partially-applied bump is worse than no bump, so an unmatched pattern
    aborts the whole run rather than skipping that file.
    """
    planned: list[tuple[Path, str]] = []
    for rel, label, pattern in EDITS:
        path = REPO / rel
        if not path.is_file():
            die(f"{rel} is missing — cannot bump {label}")
        text = path.read_text(encoding="utf-8")
        if rel == "version.txt":
            planned.append((path, version + "\n"))
            continue
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1:
            die(f"{rel}: expected exactly one {label}, found {len(matches)} "
                "— refusing a partial bump")
        m = matches[0]
        planned.append((path, text[:m.start(2)] + version + text[m.end(2):]))
    return planned


def write_edits(planned: list[tuple[Path, str]], version: str) -> None:
    for path, new in planned:
        path.write_text(new, encoding="utf-8")
        # Re-read: the write is only trusted once it has been read back.
        if version not in path.read_text(encoding="utf-8"):
            die(f"{path.relative_to(REPO)} lacks {version} after writing")
        print(f"  wrote {path.relative_to(REPO)}")


def prepend_changelog(section: str) -> None:
    changelog = REPO / "CHANGELOG.md"
    if not changelog.is_file():
        header = ("# Changelog\n\nAll notable changes to this project are "
                  "recorded here.\n\n")
        changelog.write_text(header + section, encoding="utf-8")
        return
    old = changelog.read_text(encoding="utf-8")
    head, sep, rest = old.partition("\n\n")
    # Newest release first: the section goes directly under the title.
    if sep:
        changelog.write_text(f"{head}{sep}{section}\n{rest.lstrip()}",
                             encoding="utf-8")
    else:
        changelog.write_text(f"{section}\n{old}", encoding="utf-8")


def print_plan(planned: list[tuple[Path, str]], base: str, version: str,
               section: str, commits: list[str], scope: str) -> None:
    print("\n--- would write ---")
    for path, _new in planned:
        print(f"  {path.relative_to(REPO)}: {base} -> {version}")
    print(f"  CHANGELOG.md: prepend a [{version}] section "
          f"({len(commits)} commit(s); {scope})")
    print("\n" + section)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("version", help="the version to bump to, e.g. 0.1.0")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change; write nothing")
    args = ap.parse_args()

    if not SEMVER.match(args.version):
        die(f"{args.version!r} is not a three-part semver (e.g. 0.1.0)")
    base = current_version()
    if args.version == base:
        die(f"version.txt already says {base} — nothing to bump")

    tag = last_tag()
    commits = commits_since(tag)
    hinted, why = suggest(commits, base)
    scope = f"commits since {tag}" if tag else "every commit (no tags yet)"
    print(f"bump-version: {base} -> {args.version}   "
          f"({scope} imply {hinted}: {why})")

    if tuple(int(p) for p in args.version.split(".")) < \
            tuple(int(p) for p in base.split(".")):
        print(f"bump-version: NOTE: {args.version} is LOWER than {base}. That "
              "is allowed (correcting a mistaken release) but rare — check "
              "you meant it.", file=sys.stderr)

    planned = plan_edits(args.version)
    section = render_section(args.version, commits,
                             datetime.date.today().isoformat())
    if args.dry_run:
        print_plan(planned, base, args.version, section, commits, scope)
        return 0

    write_edits(planned, args.version)
    prepend_changelog(section)
    print(f"  wrote CHANGELOG.md ({len(commits)} commit(s); {scope})")

    print(f"\nbump-version: {base} -> {args.version} done. Next:\n"
          f"  git checkout -b chore/release-{args.version}\n"
          f"  git commit -am 'chore(release): {args.version}'\n"
          f"  gh pr create   # an ORDINARY pr: it gets the `gates` check (D13)\n"
          f"  # after the merge:\n"
          f"  git pull --ff-only && git tag v{args.version} && "
          f"git push origin v{args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
