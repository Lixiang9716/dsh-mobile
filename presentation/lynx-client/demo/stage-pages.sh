#!/bin/sh
# stage-pages.sh — assemble the GitHub Pages artifact for the lynx-client web
# demo. The SAME script runs locally and in .github/workflows/pages.yml, so
# the layout verified locally is the layout deployed. Everything is relative:
# Pages serves project pages from a subpath (https://<owner>.github.io/<repo>/).
#
# Staged layout:
#   index.html        the landing page (demo/index.html, committed)
#   web.tokens.css    the generated token face (theme/, committed output of
#                     theme/gen.mjs — the page consumes the SAME generated
#                     file the theme:check gate keeps in sync)
#   main.web.bundle   the web-target build (bundle/dist-web/, `npm run build:web`)
#   web-core/...      @lynx-js/web-core's static client runtime, pinned by the
#                     workflow step and copied VERBATIM (upstream discipline:
#                     never modified copies)
#
# Usage: sh presentation/lynx-client/demo/stage-pages.sh <repo-root> <out-dir>
set -eu

ROOT="${1:?usage: stage-pages.sh <repo-root> <out-dir>}"
OUT="${2:?usage: stage-pages.sh <repo-root> <out-dir>}"

DEMO="$ROOT/presentation/lynx-client/demo"
THEME="$ROOT/presentation/lynx-client/theme"
BUNDLE="$ROOT/presentation/lynx-client/bundle"
RUNTIME="$ROOT/.pages-runtime/node_modules/@lynx-js/web-core/dist/client_prod"

test -f "$BUNDLE/dist-web/main.web.bundle" || {
  echo "stage-pages: $BUNDLE/dist-web/main.web.bundle missing — run:" \
       "npm run build:web --prefix presentation/lynx-client/bundle" >&2
  exit 1
}
test -f "$RUNTIME/static/js/client.js" || {
  echo "stage-pages: $RUNTIME missing — install the pinned web runtime first:" \
       "npm install --prefix $ROOT/.pages-runtime @lynx-js/web-core@<pin>" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT/web-core"
cp "$DEMO/index.html" "$OUT/"
# The demo presents the DARK aurora face only: the ReactLynx bundle is a
# dark-fixed pilot face, so the landing page pins the same face. Mechanically
# derived from the generated token file — keep everything up to (excluding)
# its light-scheme media block; the values still flow from tokens.json alone
# (the theme:check gate keeps that single source in sync).
awk '/^@media \(prefers-color-scheme: light\)/{exit} {print}' \
  "$THEME/web.tokens.css" > "$OUT/web.tokens.css"
cmp -s "$OUT/web.tokens.css" "$THEME/web.tokens.css" \
  || echo "stage-pages: web.tokens.css staged as the dark face (light media block dropped)"
cp "$BUNDLE/dist-web/main.web.bundle" "$OUT/"
cp -R "$RUNTIME/." "$OUT/web-core/"

# Fail loud on the two load-bearing files (the page is dead without either).
test -f "$OUT/web-core/static/js/client.js"
test -f "$OUT/web-core/static/css/client.css"
test -f "$OUT/index.html"
test -f "$OUT/web.tokens.css"
echo "stage-pages: staged $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT"
