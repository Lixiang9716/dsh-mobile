#!/bin/sh
# Fetch + verify the vendored upstream DSH runtime packages (the agent-loop
# dependency closure) and their pinned third-party npm dependencies.
#
# Pattern (see the pin tables below — the tracked provenance record): each
# package is vendored VERBATIM from its upstream tarball, pinned by tgz
# sha256. The vendored trees are UNTRACKED by design (like
# vendor/quickjs-ng/, so the syntax-class checker never judges upstream
# code); this script materializes any missing package (first checkout on a
# fresh machine, or after `git clean -fdX`) and sha256-verifies every fetch.
#
#   - dsh packages: anywhere-labs/dsh-desktop @ master,
#     vendor/dsh-runtime/0.1.6-alpha.2/deepseek-ai-dsh-<name>-0.1.6-alpha.2.tgz
#   - npm packages: registry.npmjs.org, exact pinned versions
#
# Run before the upstream E2E (runtime/spike/ci/run-upstream-e2e.sh). Network
# is only needed for packages missing on disk. @deepseek-ai/dsh-client-modules
# is vendored since the W-INTEG web-boot leg: the OFFICIAL web boot composer
# (its node half) plus the browser bootstrap bundle the injected facade queue
# expects (lib/client.js). Still staged OUT of the
# closure: session-persistence (agent-loop hard-imports its error type at
# module top — the 2026-09-23 ios parity leg died loading it), subagent, base,
# and
# the transport adapters (llm-deepseek / llm-pi-ai — their direct-fetch
# transport is the desktop's; the mobile seam is the gateway adapter in
# runtime/spike/upstream/llm-transport.js). dsh-llm is vendored since the
# W-LLM leg; llm-mock-server is vendored as the E2E test vehicle (its
# node-side driver is runtime/spike/ci/mock-llm-server.mjs); llm-replay stays
# out (peer deps on compaction + api-extensions, none of it needed).
# The FILE-TOOLS row (the dsh-desktop fs tool family over ctx.fs) vendors
# fs-local + tool-fs + tool-str-replace-editor + attachment (tool-fs' only
# not-yet-vendored link-time import) plus the npm `diff` (tool-fs' hunk
# diffs). tool-fs-search STAYS OUT the same way the other native rows do:
# its engine is the @vscode/ripgrep packaged BINARY (a postinstall platform
# download) driven through real OS subprocesses — no in-runtime equivalent;
# grep/glob on mobile waits for the PR-B subprocess/fs-service seam.
# util-workspace-path stays out: nothing in this closure imports it.
# The INTERACTIVE CIRCLE (2026-09-23, the official UI's unresolved-plugin
# report) vendors the plugins behind the "/" menu and the standard preset:
# persona + agent-instructions (the prompt planes), plan-mode, the goal pair
# (command-goal + tool-goal over dsh-goal), the jobs pair (tool-jobs over
# dsh-jobs + output-retention), the subagent family (tool-subagent +
# tool-subagent-control over dsh-subagent + chunked-list + util-time),
# tool-ask-user (over dsh-user-questions), the workflow pair (tool-workflow
# over dsh-workflow — its WorkflowEngine contract), the credentials + terminal
# server faces,
# and the compaction story (compaction-basic + command-compact over
# dsh-compaction + token-meter + compaction-tool-result-pruner — the report's
# "tool-result-pruner" is the npm name dsh-compaction-tool-result-pruner;
# the bare name is not published). Closure rule: every lib/ link-time
# @deepseek-ai import plus every hard cordis `inject` a plugin declares
# (compaction-basic needs the tokenMeter service) is vendored; peers that are
# only ctx.get()-soft stay out and are listed in upstream/README.md. Skips:
# tool-fs-search stays out (the @vscode/ripgrep binary — unchanged); tool-web
# stays out because its link-time dep turndown's ESM face executes a bare
# `require('@mixmark-io/domino')` at module top (no DOMParser exists in this
# runtime, so the native branch never applies) and domino is CJS-only — the
# ESM-only loader has no require seam, the chokidar precedent's harder
# sibling; dsh-web is tool-web's peer and joins that leg; workflow-ptc stays
# out because it imports node:vm at link time and drives createContext/
# runInContext host-side — the confined guest realm IS the PTC execution
# model, the subprocess-class seam; tool-workflow stays IN (it loads clean)
# with dsh-workflow as the engine contract its `workflowEngine` inject
# demands, mount-staged until an engine implementation exists on this side;
# dsh-ptc-runtime is
# the abstract PtcRuntime contract whose only concrete implementation is the
# desktop's sandboxed Node process (subprocess class). See
# runtime/spike/upstream/README.md for the shim coverage table.
# The SKILL row (2026-09-23, the agent-flow E2E) vendors the upstream skill
# family: dsh-skill (the ctx.skills registry), dsh-skill-filesystem (project/
# custom/user discovery) + dsh-tool-skill (the model-facing `skill` tool and
# the durable session catalog). Their dsh peer deps (scope, llm, tools,
# home-paths, fs, agent, cordis, schemastery, util-values) are already pinned
# above; the npm additions are skill-filesystem's own deps: yaml@2.9.0
# (SKILL.md frontmatter parsing — served verbatim behind the bare specifier
# through the npm-bridges runtime seam) and chokidar@5.0.0 (the file watcher —
# STAYS OUT the same way @vscode/ripgrep does: its engine is real OS fs events
# plus the awaitWriteFinish wall-clock timers, and the runtime has neither
# seam; skill-filesystem imports it at link time, so the npm-bridges seam
# registers a LOUD linkage shim whose watch() throws naming the gap — the
# mobile profile mounts skill-filesystem with watch:false and never reaches
# it). The dsh skill tarballs ride the tracked mirror like the rest (upstream
# deleted the vendor dir; the npm registry is the pin source).
set -e
cd "$(dirname "$0")"

DSH_BASE="https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/master/vendor/dsh-runtime/0.1.6-alpha.2"
NPM_BASE="https://registry.npmjs.org"

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download failure.
#
# Measured: one upstream `curl: (56) The requested URL returned error: 504`
# failed an entire CI job (run 35614651794, the iOS "Vendor quickjs-ng + the
# pinned upstream DSH closure" step) and did not recur — transient, not
# systemic. `--retry` alone does not cover it: that retries connection blips,
# while a 504 from the origin or a proxy is not reliably in its retry set.
#
# The integrity check is deliberately NOT part of this: every caller still
# verifies sha256 over what lands, so a retry can never turn a corrupt or
# truncated download into an accepted one. Bounded at 3 attempts, and it fails
# loud naming the URL.
fetch_retry() {
  _url="$1"; _out="$2"; _n=0
  while [ "$_n" -lt 3 ]; do
    _n=$((_n + 1))
    if curl -fL --retry 3 --retry-delay 5 --connect-timeout 20 \
         "$_url" -o "$_out" 2>/dev/null; then
      return 0
    fi
    echo "vendor: download attempt $_n/3 failed: $_url" >&2
    [ "$_n" -lt 3 ] && sleep 5
  done
  echo "vendor: download FAILED after 3 attempts: $_url" >&2
  return 1
}


# name|version|sha256 — upstream dsh packages (vendor/dsh/<name>@<version>/)
# 2026-09-22 re-pin: upstream re-cut agent-presets 0.1.6-alpha.2 in place and
# PROMOTED atomic-write / home-paths from their rc versions into 0.1.6-alpha.2,
# deleting the rc tarballs — a cold fetch of the old pins now 404s / mismatches.
# New digests verified against the upstream manifest on this date.
DSH_PACKAGES="
agent|0.1.6-alpha.2|1e4a587e5f7ebe32155a2e2eca3e18ad3b9b18b45071bdb2aad809b8af60fbe2
agent-loop|0.1.6-alpha.2|ec0350fd72ccb78e85220168055339fb53dd16f84cded1740c306f4f28784898
brand|0.1.6-alpha.2|47e97c6e19c562c2581b6e1ee0e30a5b38babec662142cbd28d3d1786c991b95
cordis-host-runner|0.1.6-alpha.2|b95b934a24a9cae50712ef7c907551b294b3883eed8b788004879e7e2826df49
fs|0.1.6-alpha.2|dc9a540f4c6d870d5654f313c1fbb9f5d5d4798365f836e1cd29caa72995f23a
hook-protocol|0.1.6-alpha.2|f884c7b4e421844dc94889d394fbc1346b24b38ad5cc09e1a9cb2a2eb0efc04a
invariants|0.1.6-alpha.2|7d9c6f674454d497fb9664b44a214982d9fee6af2883b301a667b1ab9bc92804
llm|0.1.6-alpha.2|2220720d9ed9ec912f94b6e10588a1e7d891436b83c1ec192cc00ee61a132d84
llm-mock-server|0.1.6-alpha.2|9b1f40a8711955c804afa3136460b33abea98898a7b73989a0b234deb38c75e1
sandbox|0.1.6-alpha.2|70bb044347254721533f7cc752cf6192666c87cd47620628edd52fc128386886
scope|0.1.6-alpha.2|1874e45d916d08fa402858ebdeb0de8be7ce3bee1b661a2015d7e243fe2605e0
sdk-protocol|0.1.6-alpha.2|accc5edff215d44a5ca39236ef1872a2d503db4ee2b282278ac9620cc8f8651e
session|0.1.6-alpha.2|bc2b7bf123067c3c328545f2fd36a03caf6d16a1a3c01bbba996ec410e0951b1
session-projection|0.1.6-alpha.2|dc9fd6db1c58e67ae80ccea5f4136439c8a665db2fd69b11ec5dde6373aa1d80
settings|0.1.6-alpha.2|4f96cf1446883c32e909951ecf6ddcb140e0080fe3ba80ea8796ac675cec806a
system-prompt|0.1.6-alpha.2|b270e70c50392d983657ff0e4d8f117e9297dd56415f86f924eff4629e10e7b7
timeout|0.1.6-alpha.2|1321ef1e4fb31818ae30743173251f03b07edc9976d9769a9102db9a8e850503
tool-todo|0.1.6-alpha.2|2e94329058e033f6e5937a77508ad32e5ec8a86cded0f09443ee9f00a9253021
tools|0.1.6-alpha.2|7c1e080bb765f44e1cac4890f5fdedd37059a569e21475dbb46d94c54c617cf5
typert-protocol|0.1.6-alpha.2|de7447ec069d8f00ca1bfaddd2487adf93446ec75f7852dffc82ff9eca8286e8
util-crypto|0.1.6-alpha.2|71ef6845f82a76ec058d405ca1c15c0f410e609216eb01dd9cc4873255af4d91
util-values|0.1.6-alpha.2|17cb0a738bd28ce8206c1583277b04b244622ec4c201530f88003a4954af86de
agent-presets|0.1.6-alpha.2|e69c10522c4ca4da5c375711d541f1e64fdefd4b15ce50a7781a492efaf8c272
attachment|0.1.6-alpha.2|f7d1a01cbc0009272b7913daa96fbde2990451f2c25f68c0e50097ebd740a18d
atomic-write|0.1.6-alpha.2|491c5b10694a2234c29e5f00807f7ed52c9f92800c8134909be0f2e79727bb4a
home-paths|0.1.6-alpha.2|1f08b24e43ec0418f1fcea84cf079bb010597c732de08ec89d59f632cfa04b3d
fs-local|0.1.6-alpha.2|716dac273817e25133b0b600fefd1fa7556dcf904840d6468518e99ec81255d8
tool-fs|0.1.6-alpha.2|3d649b28a3bd7719d02eeae600074890b12ef108dde19bf3188293c086e1c9be
tool-str-replace-editor|0.1.6-alpha.2|a4ac3ac8f4fae0fec43a0400071964e4be64296550840534a5e2dd9e49bcf31c
session-persistence|0.1.6-alpha.2|3bc8f2a2f8382b4985a059307dfbf7c689da4db5c66d26382f22b9bf0d785cad
skill|0.1.6-alpha.2|d77b76cab60c18a6bfce07951b648f9a730aa29162a6add96ca0a4b48382bfc3
skill-filesystem|0.1.6-alpha.2|3d0f30be04ef7362d1cf3fe7b83e4469efb9a593d8929c5c6e4568878b84cc5a
tool-skill|0.1.6-alpha.2|7608d917b6196b5a92b4643203509c936e169e7fcfe89b7e2852c7b6d7e0d83b
commands|0.1.6-alpha.2|cb0d940ad58ec13f5226f610523161deb0d85f36ab113047326dbb18f5c2e560
command-feedback|0.1.6-alpha.2|5ba012cda008469de1825040a7d2879626704c9d2de5ddbbec5eba73428fb724
persona|0.1.6-alpha.2|48be2c580c9aa989d790afa422029eb8f40cfc64fde4a4cc1f540b8bca507c0f
agent-instructions|0.1.6-alpha.2|17f1eec2cbbe9571320b8ad15a00d3ae7f063df4111b7bc18b13e4045e45eff3
plan-mode|0.1.6-alpha.2|2c43489e2b479782a72e08ce07c6b5bb4eba62e82a43732e1ee8b6fbfab35daa
goal|0.1.6-alpha.2|fad5689d46a8798dcef9cb3eda948fba461ce0c8f81d484d6ec1ef1c8403ef41
command-goal|0.1.6-alpha.2|693444996937916595dfd6ddf44785a17a2250141dcbb0a1f63034144a809408
tool-goal|0.1.6-alpha.2|a3d550065eccc273aabfb480951773f4c46d46ad1f8921f097b61668b3a28b80
jobs|0.1.6-alpha.2|4b4a1a4c4cd1e2aa992253dbb385de78c38c6e7d851dcbb8ee6e139d9b70dea7
output-retention|0.1.6-alpha.2|3b17f0a403e952d4860a3ca7f1c43fd7f76fbb07c0fde30f250ac6a9a0afd19a
tool-jobs|0.1.6-alpha.2|fc5726a83114c64232226bd3bf6c2de939019e18bf8e0fc1ef851a21f9553208
user-questions|0.1.6-alpha.2|0ba8afcc04dcd37b1ccb48f263190280e9139e3e11aa01b6da81a1d831dc6a56
tool-ask-user|0.1.6-alpha.2|891d48b5534c8e9f22d03ca524d3d29adabedeacac73bfd841e510f7febc2e13
chunked-list|0.1.6-alpha.2|e466f08af99c1ad8f155aac1c1e2e7672be6940ac2e87b0fb322aec6602efe6f
util-time|0.1.6-alpha.2|29a25568d19db1475153a65d0600aadc523186ee4eb63bf5641a8e4980d82ff4
subagent|0.1.6-alpha.2|d290a8dcc0a3b1407b469c43d1fc80d5ddac02692a662847a304f75ac04b512a
tool-subagent|0.1.6-alpha.2|009326aae20a7fa7d8bc2a1d8644e4ae285e38f10bc1ec503508a9f5c49ffb76
tool-subagent-control|0.1.6-alpha.2|66bdf77b1bb13f457a87e53fc173497fdf9585c461908d041839d0cd9025d552
workflow|0.1.6-alpha.2|67f06a3509b1b1ec1c87674e46090a883975965108d8f6271c97468f3815b452
tool-workflow|0.1.6-alpha.2|fe9e535111b8abef1b2412dac00b7207cae89b4f0cafa27c6066f7684fd77167
compaction|0.1.6-alpha.2|533f62737409e4f7a4336bc8665ec61fe7d968e4860d8815ae0f137e46bca1a4
token-meter|0.1.6-alpha.2|4a5d72a2fd904155c1b623bc2bad247b28e057e37507784b22a9786a049abc6f
compaction-tool-result-pruner|0.1.6-alpha.2|b1164d27ac6ff2ffa30da7fe7c16bfa57276dc09c32062e91ca062627c5f6b01
compaction-basic|0.1.6-alpha.2|5a46540df08aa0749b9ad08afe8ca00e20a7c6c288220e6ac524f29359e5b216
command-compact|0.1.6-alpha.2|e3fe6b0f2962253b4a0b459bbe3d162c8b879ba3d71916b74231705edb1955a5
credentials|0.1.6-alpha.2|b067f3fcdf5b4616afdfd9e73b89c58848a7ae3421433284f10a03d157fb982b
terminal|0.1.6-alpha.2|cb9b07571654bcfe6877f8ff860a3ebd17564fe17994a9e905aea0ef41b476a0
"

# dir|tarball-url-suffix|sha256 — pinned third-party npm packages
# (vendor/npm/<dir>/); versions are exactly what the dsh closure requires.
NPM_PACKAGES="
cordis@4.0.2|@deepseek-ai/cordis/-/cordis-4.0.2.tgz|686ca44fc6e8d217804de9062b716b7c72755dde09c2a433dd07045eea3c6a97
cosmokit@1.8.3|@deepseek-ai/cosmokit/-/cosmokit-1.8.3.tgz|552f10313ddfdc2b92cce1867b9bf30b2a4c9de55543ad222fe67c22015e4400
schemastery@3.18.2|@deepseek-ai/schemastery/-/schemastery-3.18.2.tgz|a0fe700b9c055f04dfec87cb46ae4a1106c6fac6c271f8a1df00e10038f0aac1
zod@4.4.3|zod/-/zod-4.4.3.tgz|ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c
@deepseek-ai/dsh-client-modules@0.1.6-alpha.2|@deepseek-ai/dsh-client-modules/-/dsh-client-modules-0.1.6-alpha.2.tgz|ebeccd78185289d1ca14f48e921c2dd8d96c6d455a76debf2fd2601bbd27d512
@deepseek-ai/cordis-plugin-loader@1.0.3|@deepseek-ai/cordis-plugin-loader/-/cordis-plugin-loader-1.0.3.tgz|86df86a31f58f306a4bb71c7b9bfe5d47dba8afaacf550ddc3bb654b57821e2f
@deepseek-ai/cordis-plugin-include@1.0.7|@deepseek-ai/cordis-plugin-include/-/cordis-plugin-include-1.0.7.tgz|fb6a2b9cc4b0da51f736c4bfb281b914dc9987c7235826b0cadb5efcabfe6352
js-yaml@4.1.0|js-yaml/-/js-yaml-4.1.0.tgz|0dae332559cf22b21c26ea70e732afd8303ff99412f9c3d9d209faa8882cf2ca
@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2|@deepseek-ai/dsh-anonymous-user-id/-/dsh-anonymous-user-id-0.1.6-alpha.2.tgz|2030491f97388ac6dfa5df01811c118354fe9a6b78d3b96dda0ce429d6da5ba3
@deepseek-ai/dsh-file-reference@0.1.6-alpha.2|@deepseek-ai/dsh-file-reference/-/dsh-file-reference-0.1.6-alpha.2.tgz|a26f311c6002f65c7aae9a40b32287d7d87352ea64a21405f1e9c070620fba5d
@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2|@deepseek-ai/dsh-file-reference-local/-/dsh-file-reference-local-0.1.6-alpha.2.tgz|05a17ee9e586514793078a7301c64c6c0bbcb40b48576988a9518846fe55412b
diff@9.0.0|diff/-/diff-9.0.0.tgz|b898bf23c95594607576e25ddd4013f1d51ed0e862aaf0732815830c87b3b58f
yaml@2.9.0|yaml/-/yaml-2.9.0.tgz|008fa204cb1ba700e0272ba045abbf09a6ffe63456e8146ba97cac6c2ad1ef91
"

have_pkg() { [ -f "$1/package.json" ]; }

# A package counts as present only when its stamp names the pin it carries —
# "the directory exists" is not evidence (the upstream re-cut surprise: the
# same version re-published with different bytes, and a present-but-stale
# tree short-circuits the fetch, so the pins silently stop describing the
# tree — measured again 2026-09-23 when the closures gate disagreed between
# a stale local tree and CI's fresh fetch).
stamped() { [ -f "$1/.vendor-pin" ] && [ "$(cat "$1/.vendor-pin")" = "$2" ]; }

fetch_dsh() {
    name="$1"; ver="$2"; sha="$3"
    dir="dsh/$name@$ver"
    have_pkg "$dir" && stamped "$dir" "$sha" && { echo "vendor: $dir present (pin-stamped)"; return; }
    tgz="deepseek-ai-dsh-$name-$ver.tgz"
    tmp=$(mktemp /tmp/dsh-vendor.XXXXXX)
    # Tier 1: the TRACKED MIRROR (vendor/dsh-tarballs/ — the pinned bytes,
    # committed 2026-09-23 after upstream deleted the dir from master and
    # CI runners proved unreachable-flaky against the frozen ref). Cold
    # checkouts need no network at all; the digest check below is unchanged.
    # Relative to the script's OWN directory (it cd'd at the top): $0 is
    # caller-relative, which breaks when invoked as
    # `runtime/spike/vendor/ensure-dsh.sh` from the repo root — exactly how
    # CI calls it (measured: the mirror silently missed and every cold
    # checkout fell to the deleted-on-master URL).
    MIRROR="dsh-tarballs/$tgz"
    if [ -f "$MIRROR" ]; then
        echo "$sha  $MIRROR" | shasum -a 256 -c - >/dev/null \
            && cp "$MIRROR" "$tmp" \
            || echo "vendor: mirror digest mismatch for $tgz — falling through to network" >&2
    fi
    if [ ! -s "$tmp" ]; then
        fetch_retry "$DSH_BASE/$tgz" "$tmp"
    fi
    echo "$sha  $tmp" | shasum -a 256 -c - >/dev/null
    rm -rf "$dir"
    mkdir -p "$dir"
    tar xzf "$tmp" -C "$dir" --strip-components=1
    echo "$sha" > "$dir/.vendor-pin"
    rm -f "$tmp"
    echo "vendor: fetched $dir (sha256 verified, pin-stamped)"
}

fetch_npm() {
    dir="$1"; suffix="$2"; sha="$3"
    have_pkg "npm/$dir" && stamped "npm/$dir" "$sha" && { echo "vendor: npm/$dir present (pin-stamped)"; return; }
    tmp=$(mktemp /tmp/dsh-vendor.XXXXXX)
    fetch_retry "$NPM_BASE/$suffix" "$tmp"
    echo "$sha  $tmp" | shasum -a 256 -c - >/dev/null
    rm -rf "npm/$dir"
    mkdir -p "npm/$dir"
    tar xzf "$tmp" -C "npm/$dir" --strip-components=1
    echo "$sha" > "npm/$dir/.vendor-pin"
    rm -f "$tmp"
    echo "vendor: fetched npm/$dir (sha256 verified, pin-stamped)"
}

echo "$DSH_PACKAGES" | while IFS='|' read -r name ver sha; do
    [ -z "$name" ] && continue
    fetch_dsh "$name" "$ver" "$sha"
done

echo "$NPM_PACKAGES" | while IFS='|' read -r dir suffix sha; do
    [ -z "$dir" ] && continue
    fetch_npm "$dir" "$suffix" "$sha"
done

echo "vendor: upstream DSH closure ready"
