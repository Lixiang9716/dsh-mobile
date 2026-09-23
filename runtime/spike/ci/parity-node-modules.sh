#!/bin/sh
# parity-node-modules.sh — materialize the Node resolution layout for the
# parity reference leg (idempotent; lives INSIDE the untracked vendor tree,
# so a vendor re-fetch wipes it and this script rebuilds it).
#
# Node resolves package specifiers from the REAL path of the importing file
# (symlinks are realpath'd by default), so a node_modules beside the driver
# never satisfies imports made from inside vendor/dsh/*/. The layout that
# works is one on the real ancestor chain shared by every vendored package:
# runtime/spike/vendor/node_modules/ — reachable from vendor/dsh/<pkg>/lib
# and vendor/npm/<pkg>/lib alike.
#
# One deliberate substitute: @deepseek-ai/dsh-session-persistence is served
# under quickjs by the errors-only linkage shim
# (upstream/shims/dsh-session-persistence.js — the real package is koffi-bound
# and not vendored); the same shim bytes become a Node package here, so the
# reference spine links exactly what the port spine links.
set -eu
SPIKE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$SPIKE_ROOT/vendor"
NM="$VENDOR/node_modules"
SCOPE="$NM/@deepseek-ai"

mkdir -p "$SCOPE"

# Every vendored dsh package, symlinked under its real npm name.
for dir in "$VENDOR"/dsh/*/; do
    name="$(node -e "console.log(require('${dir}package.json').name)")"
    link="$SCOPE/${name#@deepseek-ai/}"
    mkdir -p "$(dirname "$link")"
    ln -sfn "$dir" "$link"
done

# The vendored npm dependencies (cordis and friends), same treatment.
ln -sfn "$VENDOR/npm/cordis@4.0.2" "$SCOPE/cordis"
ln -sfn "$VENDOR/npm/cosmokit@1.8.3" "$SCOPE/cosmokit"
ln -sfn "$VENDOR/npm/schemastery@3.18.2" "$SCOPE/schemastery"
ln -sfn "$VENDOR/npm/@deepseek-ai/cordis-plugin-loader@1.0.3" "$SCOPE/cordis-plugin-loader"
ln -sfn "$VENDOR/npm/@deepseek-ai/cordis-plugin-include@1.0.7" "$SCOPE/cordis-plugin-include"
ln -sfn "$VENDOR/npm/zod@4.4.3" "$NM/zod"
ln -sfn "$VENDOR/npm/diff@9.0.0" "$NM/diff"

# The errors-only persistence linkage shim as a real (tiny) package.
SHIM="$NM/.parity-shim-session-persistence"
mkdir -p "$SHIM/lib"
printf '{"name":"@deepseek-ai/dsh-session-persistence","version":"0.1.6-alpha.2","type":"module","exports":{".":"./lib/index.js"}}' \
    > "$SHIM/package.json"
cp "$SPIKE_ROOT/upstream/shims/dsh-session-persistence.js" "$SHIM/lib/index.js"
ln -sfn "$SHIM" "$SCOPE/dsh-session-persistence"

# The driver itself lives at runtime/spike/ci/ — OUTSIDE the vendor tree —
# so its own specifier resolution needs one more link on ITS ancestor chain.
ln -sfn vendor/node_modules "$SPIKE_ROOT/node_modules"

echo "parity node_modules layout ready: $NM (+ $SPIKE_ROOT/node_modules link)"
