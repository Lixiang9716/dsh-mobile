#!/bin/sh
# Assert that a release tag agrees with every version file in the tree.
#
# WHY THIS EXISTS
# The release trigger is the tag push, which puts the *timing* decision in a
# human's hands — deliberately, so cutting a release does not depend on
# a bot completing (D12). But the same gesture would also put the
# *bookkeeping* in a human's hands, and that is the drift D10 was adopted to
# prevent: pushing `v0.0.3` while `version.txt` still says `0.0.2` ships an
# app whose Info.plist, versionName and app.json5 all disagree with the tag it
# is attached to, silently. Nothing downstream would notice — the package
# builds fine and installs fine under the wrong number.
#
# So the tag is checked against all four sources before anything builds, and
# every mismatch is named at once rather than one per run.
#
# usage: check-tag-version.sh v0.0.2

set -eu

tag="${1:-}"
if [ -z "$tag" ]; then
  echo "usage: $0 <tag>   (e.g. v0.0.2)" >&2
  exit 2
fi

fail=0
check() { # <label> <actual-version>
  if [ "$tag" != "v$2" ]; then
    echo "MISMATCH $1: tag is $tag but the file says $2 (expected v$2)" >&2
    fail=1
  fi
}

want=$(tr -d '[:space:]' < version.txt)
check "version.txt" "$want"

# The four files are kept in step by packages/release/bump-version.py, which
# writes them together; a bump that missed one — or a tag chosen by hand — is
# exactly what this catches.
ios=$(sed -n '/<key>CFBundleShortVersionString<\/key>/{n;s/.*<string>\([^<]*\)<\/string>.*/\1/p;}' \
  hosts/ios/App/Info.plist | head -1)
check "hosts/ios/App/Info.plist CFBundleShortVersionString" "$ios"

android=$(sed -n 's/^[[:space:]]*versionName[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
  hosts/android/app/build.gradle.kts | head -1)
check "hosts/android/app/build.gradle.kts versionName" "$android"

harmony=$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  hosts/harmony/AppScope/app.json5 | head -1)
check "hosts/harmony/AppScope/app.json5 versionName" "$harmony"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "The tag and the version files disagree. Merge the release PR first" >&2
  echo "(it is what bumps all four), then tag that commit — or delete the tag." >&2
  exit 1
fi

echo "tag/version check: $tag == version.txt == Info.plist == build.gradle.kts == app.json5"
