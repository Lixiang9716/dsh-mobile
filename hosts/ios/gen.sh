#!/bin/sh
# Regenerate the iOS spike app: embed the runtime/spike JS bundle as C byte
# arrays, then regenerate DSHSpike.xcodeproj from project.yml. Run
# runtime/spike/vendor/ensure.sh first — xcodegen needs the quickjs sources
# on disk to reference them. CI does not need this script: the generated
# project is committed and the Xcode pre-build phase re-runs the generator.
#
# The guest userland tarball must exist BEFORE xcodegen runs: project.yml
# picks App/Generated up as resources at GENERATE time, so a tarball that
# only appears in the build phase (FetchIshRootfs) lands in no project and
# the built app ships without the guest — measured live 2026-10-01 (the
# ish probe answered `unavailable: ... is missing` with no tarball in the
# bundle; regenerating after ensure-ish-rootfs.sh fixed it).
set -e
cd "$(dirname "$0")"
python3 Tools/gen_bundle_header.py
../../runtime/spike/vendor/ensure-ish-rootfs.sh App/Generated
xcodegen generate
