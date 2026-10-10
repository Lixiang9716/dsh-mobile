#!/bin/bash
# tools/plugin/dev.sh — the mobile twin of the upstream tutorial's
# `pnpm dsh web --patch ./scratch-plugin/cordis.yml` loop
# (docs/plugin-dev.md): compile a TypeScript (or pass through a JavaScript)
# plugin source ON THE DEV MACHINE (the device never compiles — the
# one-to-one mapping of "create the plugin file" onto mobile), write the
# workspace tree + ENABLE its registry row inside the iOS simulator's app
# container, and (by default) relaunch the app in serve mode — the boot
# list mounts every enabled row at spine boot (the cordis.yml-insert
# equivalent), and an already-mounted plugin reloads by relaunching.
#
# usage:
#   tools/plugin/dev.sh <plugin-dir> [--udid <id>] [--bundle <id>]
#                       [--no-launch] [--mode serve]
#
# <plugin-dir> layout (the tutorial's scratch-plugin, mobile spelling):
#   plugin.json   { "id", "name"?, "version"?, "entry"?, "capabilities"? }
#   src/index.ts  the entry (or .js — passed through verbatim)
#
# The TS compile needs esbuild on the dev machine (`npx esbuild`); without
# it, .ts fails loud (never a silent wrong build) while .js just works.
set -eu
DIR=""
UDID="${DSH_DEV_UDID:-}"
BUNDLE="org.dsh.DSHHost"
LAUNCH=1
MODE="serve"
while [ $# -gt 0 ]; do
    case "$1" in
        --udid) UDID="$2"; shift 2 ;;
        --bundle) BUNDLE="$2"; shift 2 ;;
        --no-launch) LAUNCH=0; shift ;;
        --mode) MODE="$2"; shift 2 ;;
        -*) echo "dev.sh: unknown flag $1" >&2; exit 2 ;;
        *) DIR="$1"; shift ;;
    esac
done
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "usage: dev.sh <plugin-dir> [--udid <id>] [--bundle <id>] [--no-launch] [--mode serve]" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
[ -f "$DIR/plugin.json" ] || { echo "dev.sh: $DIR/plugin.json missing (need {id, version?, entry?})" >&2; exit 2; }

command -v xcrun >/dev/null || { echo "dev.sh: xcrun missing (macOS only)" >&2; exit 2; }
[ -n "$UDID" ] || UDID="$(xcrun simctl list devices booted -j | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((x['udid'] for dev in d['devices'].values() for x in dev if x['state']=='Booted'), ''))")"
[ -n "$UDID" ] || { echo "dev.sh: no booted simulator (pass --udid or boot one)" >&2; exit 2; }

# ---- 1. read the descriptor, resolve the entry --------------------------------
ID="$(python3 -c "import json;print(json.load(open('$DIR/plugin.json'))['id'])")"
VERSION="$(python3 -c "import json;print(json.load(open('$DIR/plugin.json')).get('version','1.0.0'))")"
ENTRY="$(python3 -c "import json;print(json.load(open('$DIR/plugin.json')).get('entry','index.js'))")"
SRC="$DIR/src/${ENTRY%.*}.ts"
PASS_JS="$DIR/src/${ENTRY%.*}.js"
OUT="$(mktemp -d)/${ENTRY}"
if [ -f "$SRC" ]; then
    command -v esbuild >/dev/null 2>&1 || npx -y esbuild --version >/dev/null 2>&1 || { echo "dev.sh: esbuild not found — install it (npm i -g esbuild) or author .js" >&2; exit 2; }
    (command -v esbuild >/dev/null 2>&1 && esbuild "$SRC" --format=esm --outfile="$OUT") || npx -y esbuild "$SRC" --format=esm --outfile="$OUT"
    echo "dev.sh: compiled $SRC -> ${ENTRY}"
elif [ -f "$PASS_JS" ]; then
    cp "$PASS_JS" "$OUT"
    echo "dev.sh: passing $PASS_JS through verbatim"
else
    echo "dev.sh: no src/${ENTRY%.*}.ts|.js under $DIR" >&2; exit 2
fi

# ---- 2. write the workspace tree into the simulator container -----------------
CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data 2>/dev/null)" || {
    echo "dev.sh: $BUNDLE not installed on $UDID" >&2; exit 2; }
WS="$CONTAINER/Documents/profiles/default/dsh"
mkdir -p "$WS/plugins/$ID"
python3 - "$DIR/plugin.json" "$WS/plugins/$ID/manifest.json" "$ID" "$VERSION" "$ENTRY" <<'EOF'
import json, sys
src, dst, pid, version, entry = sys.argv[1:6]
d = json.load(open(src))
out = {
    "schemaVersion": 1, "type": "service", "id": pid,
    "name": d.get("name", pid), "version": d.get("version", version),
    "entry": d.get("entry", entry), "capabilities": d.get("capabilities", {"required": []}),
}
open(dst, "w").write(json.dumps(out, indent=2) + "\n")
EOF
cp "$OUT" "$WS/plugins/$ID/$ENTRY"

# ---- 3. enable the registry row (the cordis.yml insert) -----------------------
REG="$WS/dsh.plugins/1/registry.json"
python3 - "$REG" "$ID" <<'EOF'
import json, os, sys
path, pid = sys.argv[1:3]
doc = {"version": 1, "plugins": []}
if os.path.exists(path):
    try: doc = json.load(open(path))
    except Exception: pass
row = next((r for r in doc.get("plugins", []) if r and r.get("id") == pid), None)
if row is None:
    row = {"id": pid, "name": pid, "version": "1.0.0", "path": f"plugins/{pid}",
           "source": "workspace", "enabled": True, "installedAt": "1970-01-01T00:00:00.000Z"}
    doc.setdefault("plugins", []).append(row)
row["enabled"] = True
os.makedirs(os.path.dirname(path), exist_ok=True)
open(path, "w").write(json.dumps(doc, indent=2) + "\n")
print(f"registry: {pid} enabled ({len(doc['plugins'])} rows)")
EOF

echo "dev.sh: $ID staged at $WS/plugins/$ID (enabled row in dsh.plugins/1)"
if [ "$LAUNCH" = "1" ]; then
    xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE" -dsh-mode "$MODE"
    echo "dev.sh: relaunched in $MODE mode — the boot list mounts $ID at spine boot"
    echo "        (watch: xcrun simctl spawn $UDID log stream --predicate 'process == \"${BUNDLE##*.}\"')"
else
    echo "dev.sh: --no-launch — next launch mounts $ID"
fi
