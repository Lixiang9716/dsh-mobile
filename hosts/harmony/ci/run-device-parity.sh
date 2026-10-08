#!/bin/sh
# run-device-parity.sh (HarmonyOS) — the ONE-CLICK real-device leg of the
# upstream parity differential + the tool-rows on-device mount proof
# (decision D-g: scripts ready on standby; the moment a device is attached,
# one invocation produces the receipts). Two phases, two launches:
#
#   parity     — the SAME parity leg iOS/Android meet: the canonical
#                scenario/upstream-parity.js boots the vendored spine inside
#                quickjs against the in-app scripted route
#                (model/ParityMockRoute.ets — success → todo_write tool
#                round → success → 401), and the projected session log MUST
#                equal the committed 25-record golden
#                (test/e2e/fixtures/upstream-parity-reference.jsonl)
#                record-for-record (runtime/dsh/ci/parity-compare.mjs).
#   tool-rows  — T-0048 item 3: the interactive seat (v2web.mount launch,
#                which evals web-live/composer-web-live.js) probes
#                agentPresets/list + pluginInventory/list on-device; the
#                capture must show the roster all-healthy AND the composed
#                tool rows NAMED — bash/pwsh/present/ralph resolve through
#                their node_modules markers (a missing package breaks the
#                preset's composition, so healthy drops below 4 and the
#                rows vanish).
#
# Standby contract: `hdc list targets` is checked ONCE, up front — no online
# target prints the ready-standby report and exits 0 (never blocks, never
# sleeps waiting for a device — the ask's rule, rules.md rule 8 applied to
# presence). Everything AFTER a device is found fails loud on exhaustion
# (rule 5): every wait polls a condition with a deadline.
#
# Evidence faces (the e2e-matrix walks the filesystem):
#   <out>/parity/     logs.txt scenario.jsonl receipt.json port.jsonl
#                     parity-verdict.txt capture.txt
#   <out>/tool-rows/  logs.txt scenario.jsonl receipt.json capture.txt
#
# usage: [DSH_HDC=...] [DSH_HDC_TARGET=...] [DSH_SKIP_BUILD=1]
#        [DSH_PARITY_OUT=...] hosts/harmony/ci/run-device-parity.sh [out-dir]
#        (default out: hosts/harmony/artifacts/device-parity)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC_BIN=${DSH_HDC:-"$CLT/sdk/default/openharmony/toolchains/hdc"}
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.host
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache
OUT=${1:-${DSH_PARITY_OUT:-hosts/harmony/artifacts/device-parity}}
GOLDEN="$ROOT/test/e2e/fixtures/upstream-parity-reference.jsonl"
PARITY_DEADLINE_SECONDS=${DSH_PARITY_DEADLINE:-300}
TOOLROWS_DEADLINE_SECONDS=${DSH_TOOLROWS_DEADLINE:-180}
TOOL_ROW_NAMES='@deepseek-ai/dsh-tool-bash @deepseek-ai/dsh-tool-present @deepseek-ai/dsh-tool-ralph @deepseek-ai/dsh-tool-pwsh'

say() { echo "run-device-parity: $*"; }
die() { echo "::error::run-device-parity: $*" >&2; exit 1; }

[ -x "$HDC_BIN" ] || die "hdc not found at $HDC_BIN (set DSH_HDC or DSH_CLT)"
[ -f "$GOLDEN" ] || die "parity golden missing: $GOLDEN"

# ---- device detection: ONE shot, never a wait -------------------------------
# `hdc list targets` prints "[Empty]" when nothing is attached; presence is
# judged by OUTPUT (an hdc rc is meaningless — the run-upstream-suite
# measured lesson). DSH_HDC_TARGET pins one device on a multi-device farm;
# otherwise the first target is taken and announced.
TARGETS=$("$HDC_BIN" list targets 2>/dev/null | grep -v '^\[Empty\]$' | sed '/^[[:space:]]*$/d' || true)
if [ -z "$TARGETS" ]; then
    say "READY-STANDBY — no HarmonyOS target online; nothing ran, nothing blocked."
    say "attach a real device or start the emulator ($CLT/emulator/Emulator -start dsh_phone), then re-run."
    printf '{"status":"standby","reason":"no-device","targets":[],"runner":"hosts/harmony/ci/run-device-parity.sh","checkedAt":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit 0
fi
if [ -n "${DSH_HDC_TARGET:-}" ]; then
    echo "$TARGETS" | grep -Fxq "$DSH_HDC_TARGET" \
        || die "DSH_HDC_TARGET=$DSH_HDC_TARGET is not an online target (found: $TARGETS)"
else
    DSH_HDC_TARGET=$(echo "$TARGETS" | head -1)
fi
hdc() { "$HDC_BIN" -t "$DSH_HDC_TARGET" "$@"; }
say "target: $DSH_HDC_TARGET"
# The receipts name their host honestly: the 127.0.0.1 serials are the CLT
# emulator; any other serial is a real device.
case "$DSH_HDC_TARGET" in
    127.0.0.1:*) HOST_KIND="emulator" ;;
    *) HOST_KIND="real device" ;;
esac

# ---- build (or reuse) --------------------------------------------------------
if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    say "staging the rawfile closure + building the HAP"
    sh hosts/harmony/ci/vendor-official.sh --closure-only
    (cd hosts/harmony && "$CLT/bin/ohpm" install --all >/dev/null)
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-parity-build.log 2>&1) \
        || { cat /tmp/dsh-parity-build.log >&2; die "hvigorw build failed — see /tmp/dsh-parity-build.log"; }
fi
[ -f "$HAP" ] || die "no HAP at $HAP (build first or set DSH_SKIP_BUILD=1)"

# NOTE: the unsigned debug HAP installs on the emulator directly; a REAL
# device needs the signed build (docs/troubleshooting.md — the ~/.ohos
# signing material). An install that keeps failing lands in the die below
# with the remedy named.
deadline=$(( $(date +%s) + 180 ))
until hdc install -r "$HAP" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        die "hdc install kept failing within 180s (real device? signing: docs/troubleshooting.md)"
    fi
    sleep 3
done

# hilog FLOW CONTROL drops the canonical record stream under burst (the
# run-host-e2e measured lesson) — off with a loud warning; a device that
# refuses it still runs, but the starvation it causes looks like a failure.
for knob in pidoff domainoff; do
    out=$(hdc shell hilog -Q "$knob" 2>&1 || true)
    case "$out" in
        *successfully*) ;;
        *) echo "::warning::hilog -Q $knob failed ($out) — the record stream may drop and a phase may starve its deadline" >&2 ;;
    esac
done

wake_unlock() {
    hdc shell power-shell wakeup >/dev/null 2>&1 || true
    hdc shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
}

# One CLEAN launch per phase, VERIFIED by process (aa start's exit code lies
# right after install — the cold-boot BMS lesson; the waited-for condition is
# the PID, rule 8). $1 = the aa start extra, $2 = the hilog stream file.
STREAMER=0
launch_leg() {
    hdc shell aa force-stop "$BUNDLE" >/dev/null 2>&1 || true
    if [ -n "$(hdc shell pidof "$BUNDLE" 2>/dev/null | tr -d '[:space:]')" ]; then
        die "aa force-stop left $BUNDLE resident"
    fi
    hdc shell hilog -r >/dev/null 2>&1 || true
    : > "$2"
    hdc shell hilog > "$2" 2>/dev/null &
    STREAMER=$!
    attach_deadline=$(( $(date +%s) + 60 ))
    until [ -s "$2" ]; do
        [ "$(date +%s)" -ge "$attach_deadline" ] && die "hilog streamer never attached"
        sleep 0.2
    done
    launch_deadline=$(( $(date +%s) + 120 ))
    while :; do
        wake_unlock
        # $1 is the caller's extra-args string (e.g. "--ps k v") — the split is the contract
        # shellcheck disable=SC2086 # intentional word split
        hdc shell aa start -b "$BUNDLE" -a EntryAbility $1 >/dev/null 2>&1 || true
        # ONE start, then poll before re-firing: a slow spawn (a tired
        # emulator, a cold real device) takes re-fires onto a warming app
        # whose boot chain re-enters — four interleaved web.plugins trains
        # jammed the interactive seat's afterCompose (measured 2026-09-30).
        # Poll 20s per attempt; re-fire only on a real no-show.
        spawn_deadline=$(( $(date +%s) + 20 ))
        until [ -n "$(hdc shell pidof "$BUNDLE" 2>/dev/null | tr -d '[:space:]')" ]; do
            [ "$(date +%s)" -ge "$launch_deadline" ] && die "$BUNDLE process never appeared within 120s"
            [ "$(date +%s)" -ge "$spawn_deadline" ] && break
            sleep 2
        done
        if [ -n "$(hdc shell pidof "$BUNDLE" 2>/dev/null | tr -d '[:space:]')" ]; then
            break
        fi
    done
}

stop_streamer() {
    [ "$STREAMER" -ne 0 ] || return 0
    kill "$STREAMER" 2>/dev/null || true
    wait "$STREAMER" 2>/dev/null || true
    STREAMER=0
}

# ---- phase 1: the parity leg --------------------------------------------------
PARITY_OUT="$OUT/parity"
mkdir -p "$PARITY_OUT"
STREAM="$PARITY_OUT/hilog-stream.txt"
say "phase 1/2: upstream.parity (the golden differential)"
launch_leg "--ps dsh.e2e.leg upstream.parity" "$STREAM"

deadline=$(( $(date +%s) + PARITY_DEADLINE_SECONDS ))
status=timeout
until grep -q 'upstream/completed\|scenario\.failed' "$STREAM" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        break
    fi
    sleep 1
done
if grep -q 'upstream/completed' "$STREAM" 2>/dev/null; then
    status='done'
fi
sleep 1   # let the terminal record flush into the stream
stop_streamer

# `hdc file recv` exits 0 even when the transfer fails, and a repo-relative
# destination lands nowhere on the Windows seat (MSYS) — remove first, recv
# FROM $PARITY_OUT with a bare name, then demand the bytes (rule 5).
rm -f "$PARITY_OUT/capture.txt"
(cd "$PARITY_OUT" && MSYS_NO_PATHCONV=1 "$HDC_BIN" file recv "$BASE/dsh-parity-capture.log" capture.txt >/dev/null 2>&1) \
    || die "parity capture pull failed — no $BASE/dsh-parity-capture.log on $DSH_HDC_TARGET"
[ -s "$PARITY_OUT/capture.txt" ] \
    || die "parity capture pull wrote nothing — no $BASE/dsh-parity-capture.log on $DSH_HDC_TARGET"
grep 'dsh.runtime' "$STREAM" > "$PARITY_OUT/logs.txt" || true
grep -h '^dsh.runtime.log:' "$PARITY_OUT/capture.txt" > "$PARITY_OUT/scenario.jsonl" || true

if [ "$status" != "done" ]; then
    if grep -q 'scenario\.failed' "$STREAM" "$PARITY_OUT/capture.txt" 2>/dev/null; then
        die "the parity scenario failed on-device (scenario.failed) — evidence: $PARITY_OUT"
    fi
    die "upstream/completed never appeared within ${PARITY_DEADLINE_SECONDS}s — evidence: $PARITY_OUT"
fi

# The differential: extract the projected records, diff against the golden.
node - "$PARITY_OUT" <<'EXTRACT'
const fs = require('fs');
const out = process.argv[2];
const lines = fs.readFileSync(`${out}/scenario.jsonl`, 'utf8').split('\n');
const records = [];
for (const line of lines) {
  const at = line.indexOf('{');
  if (at < 0) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.scenario === 'upstream.parity' && e2e.event === 'parity/event' && e2e.record !== undefined) {
    records.push(e2e.record);
  }
}
fs.writeFileSync(`${out}/port.jsonl`, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (records.length === 0) { console.error('no parity/event records in the pulled capture'); process.exit(1); }
EXTRACT

node runtime/dsh/ci/parity-compare.mjs "$GOLDEN" "$PARITY_OUT/port.jsonl" \
    | tee "$PARITY_OUT/parity-verdict.txt"
grep -q 'identical' "$PARITY_OUT/parity-verdict.txt" \
    || die "parity differential FAILED — see $PARITY_OUT/parity-verdict.txt"

REF_COUNT="$(wc -l < "$GOLDEN" | tr -d ' ')"
TREE_LINE="$(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$PARITY_OUT/receipt.json" <<EOF
{
  "host": "harmony ($DSH_HDC_TARGET, $HOST_KIND)",
  "runner": "hosts/harmony/ci/run-device-parity.sh",
  "phase": "upstream.parity",
  "launch": "--ps dsh.e2e.leg upstream.parity (Debug, in-app ParityMockRoute)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/dsh/vendor/ensure.sh)",
  "upstream": "@deepseek-ai/dsh-* (vendored verbatim, sha256-pinned; the SAME closure the Node reference ran)",
  "scenario": "upstream.parity",
  "proves": [
    "the vendored upstream spine produces the SAME projected session log on the HarmonyOS device as under plain Node: record-for-record identity against the committed ${REF_COUNT}-record golden, the scripted route replaying success → todo_write tool round → success → 401",
    "the 401 transport-error leg surfaces as the same upstream error-finish"
  ],
  "checker": "runtime/dsh/ci/parity-compare.mjs vs test/e2e/fixtures/upstream-parity-reference.jsonl",
  "referenceRecords": $REF_COUNT,
  "exitCode": 0
}
EOF
say "phase 1/2 PASS — parity $REF_COUNT/$REF_COUNT identical ($PARITY_OUT)"

# ---- phase 2: the tool-rows on-device markers ---------------------------------
TOOLROWS_OUT="$OUT/tool-rows"
mkdir -p "$TOOLROWS_OUT"
STREAM="$TOOLROWS_OUT/hilog-stream.txt"
say "phase 2/2: tool-rows markers (interactive seat probes)"
launch_leg "--ps dsh.e2e.leg v2web.mount" "$STREAM"

deadline=$(( $(date +%s) + TOOLROWS_DEADLINE_SECONDS ))
until grep -q 'settings\.plugin\.inventory' "$STREAM" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        stop_streamer
        die "settings.plugin.inventory never appeared within ${TOOLROWS_DEADLINE_SECONDS}s — the interactive seat's probes did not run"
    fi
    sleep 1
done
sleep 1
stop_streamer

# The same recv discipline: remove first, recv from $TOOLROWS_OUT with a
# bare name, demand the bytes (the lying exit code, measured 2026-10-08).
rm -f "$TOOLROWS_OUT/capture.txt"
(cd "$TOOLROWS_OUT" && MSYS_NO_PATHCONV=1 "$HDC_BIN" file recv "$BASE/dsh-v2web-capture.log" capture.txt >/dev/null 2>&1) \
    || die "tool-rows capture pull failed — no $BASE/dsh-v2web-capture.log on $DSH_HDC_TARGET"
[ -s "$TOOLROWS_OUT/capture.txt" ] \
    || die "tool-rows capture pull wrote nothing — no $BASE/dsh-v2web-capture.log on $DSH_HDC_TARGET"
grep 'dsh.runtime' "$STREAM" > "$TOOLROWS_OUT/logs.txt" || true
grep -h '^dsh.runtime.log:' "$TOOLROWS_OUT/capture.txt" > "$TOOLROWS_OUT/scenario.jsonl" || true

# The assertion: the roster all-healthy + the four tool rows NAMED in the
# composed inventory (a row exists only when its preset composed — which
# breaks loud when the package is missing from the closure/markers).
# TOOL_ROW_NAMES is a whitespace-separated roster — each name becomes its own argv entry
# shellcheck disable=SC2086 # intentional word split
node - "$TOOLROWS_OUT" $TOOL_ROW_NAMES <<'ASSERT'
const fs = require('fs');
const out = process.argv[2];
const wanted = process.argv.slice(3).sort();
const lines = fs.readFileSync(`${out}/scenario.jsonl`, 'utf8').split('\n');
let roster = null, inventory = null;
for (const line of lines) {
  const at = line.indexOf('{');
  if (at < 0) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.scenario !== 'composer.live-write') continue;
  if (e2e.event === 'settings.preset.roster' && roster === null) roster = e2e;
  if (e2e.event === 'settings.plugin.inventory' && inventory === null) inventory = e2e;
}
if (roster === null || inventory === null) {
  console.error(`missing probe records: roster=${roster !== null} inventory=${inventory !== null}`);
  process.exit(1);
}
const healthy = roster.healthy, presets = (roster.presets ?? []).length;
const toolRows = (inventory.toolRows ?? []).slice().sort();
const missing = wanted.filter((n) => !toolRows.includes(n));
console.log(`roster: ${JSON.stringify(roster.presets)} default=${JSON.stringify(roster.default ?? null)} healthy=${healthy}/${presets}`);
console.log(`toolRows: ${JSON.stringify(toolRows)}`);
// 5 = the four vendored presets + the MOBILE preset (the deployment default
// the T-0048 tail item joins): the outboard composition doc staged into the
// vendored presets copy by vendor-official.sh. healthy 5/5 still breaks
// loud when any row's package is missing from the closure/markers.
if (presets !== 5 || healthy !== 5) {
  console.error(`the preset roster is not all-healthy (${healthy}/${presets}, want 5 with the staged mobile doc) — a composition broke`);
  process.exit(1);
}
if (roster.default !== 'mobile') {
  console.error(`the deployment default is not the mobile preset: ${JSON.stringify(roster.default ?? null)}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`tool rows NOT mounted on-device: ${JSON.stringify(missing)}`);
  process.exit(1);
}
console.log('tool-rows: all four rows composed on-device (bash/pwsh/present/ralph)');
ASSERT

cat > "$TOOLROWS_OUT/receipt.json" <<EOF
{
  "host": "harmony ($DSH_HDC_TARGET, $HOST_KIND)",
  "runner": "hosts/harmony/ci/run-device-parity.sh",
  "phase": "harmony.tool-rows (T-0048 item 3)",
  "launch": "--ps dsh.e2e.leg v2web.mount (Debug, interactive seat)",
  "tree": "$TREE_LINE",
  "scenario": "composer.live-write",
  "proves": [
    "the preset roster composes all-healthy on-device (healthy 5/5, the staged mobile doc among them, default=mobile) — a composition breaks loud when a row's package is missing",
    "the bash/pwsh/present/ralph tool rows are NAMED in the composed inventory: each resolves through its agentPresets.seed node_modules marker onto the staged vendored package"
  ],
  "checker": "run-device-parity.sh ASSERT block vs the pulled capture (settings.preset.roster + settings.plugin.inventory.toolRows)",
  "exitCode": 0
}
EOF
say "phase 2/2 PASS — the four tool rows mounted on-device ($TOOLROWS_OUT)"
say "ALL PASS — artifacts: $OUT"
