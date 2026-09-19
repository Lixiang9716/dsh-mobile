#!/bin/sh
# Regenerate the iOS spike app: embed the runtime/spike JS bundle as C byte
# arrays, then regenerate DSHSpike.xcodeproj from project.yml. Run
# runtime/spike/vendor/ensure.sh first — xcodegen needs the quickjs sources
# on disk to reference them. CI does not need this script: the generated
# project is committed and the Xcode pre-build phase re-runs the generator.
set -e
cd "$(dirname "$0")"
python3 Tools/gen_bundle_header.py
xcodegen generate
