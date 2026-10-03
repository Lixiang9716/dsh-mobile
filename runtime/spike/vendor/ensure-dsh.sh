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
# tool-fs-search stays out (the @vscode/ripgrep binary — unchanged);
# workflow-ptc stays
# out because it imports node:vm at link time and drives createContext/
# runInContext host-side — the confined guest realm IS the PTC execution
# model, the subprocess-class seam; tool-workflow stays IN (it loads clean)
# with dsh-workflow as the engine contract its `workflowEngine` inject
# demands, mount-staged until an engine implementation exists on this side;
# dsh-ptc-runtime is
# the abstract PtcRuntime contract whose only concrete implementation is the
# desktop's sandboxed Node process (subprocess class). 2026-10-03 (issue #335
# B5): tool-web JOINED the product closure — the W4-P suite round had already
# solved its turndown→domino CJS seam (the shims' cjs-loader + the
# npm-bridges linkage rows), and the web plane's keyless search provider
# (upstream/web-search-keyless.js) gives it a transport over gateway
# httpFetch; dsh-web is its seam peer and joins the same leg. See
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

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download
# failure, with the window sized for CI's cold materialization: when neither
# the CI cache nor the tracked mirror has the bytes, the runner's network is
# the ONLY path, and a blip there must not sink the job (measured: one
# upstream `curl: (56) ... 504` failed an entire CI job, run 35614651794,
# and did not recur). 5 outer attempts, inner curl --retry 2, waits of
# 5/10/20/40 between them — ~75s of pacing plus up to 15 dials worst case,
# still bounded. `--retry` alone does not cover a 504; that is why the outer
# loop states the policy where it can be read.
fetch_retry() {
  _url="$1"; _out="$2"; _n=0; _wait=5
  while [ "$_n" -lt 5 ]; do
    _n=$((_n + 1))
    if curl -fsSL --retry 2 --retry-delay 3 --connect-timeout 20 --max-time 300 \
         "$_url" -o "$_out"; then
      return 0
    fi
    echo "vendor: download attempt $_n/5 failed: $_url" >&2
    if [ "$_n" -lt 5 ]; then sleep "$_wait"; _wait=$((_wait * 2)); fi
  done
  echo "vendor: download FAILED after 5 attempts: $_url" >&2
  return 1
}

# fetch_verified <label> <url> <out> <sha256> — the download WITH its
# integrity check, retried as one bounded unit. A 200 with a truncated or
# corrupt body passes curl's exit code, so the digest check sits inside the
# retry window (a retry policy ABOVE verification would just accept a bad
# artifact more persistently): a digest mismatch refetches, and three
# mismatches fail loud naming the package, the source URL, and the expected
# digest — never a bare shasum line on a mktemp filename (that cryptic death
# is what a swallowed failure looked like downstream, #289 feedback: the
# ensure script gave no name and the gap surfaced only at a later gate).
fetch_verified() {
  _label="$1"; _url="$2"; _out="$3"; _sha="$4"; _d=0
  while :; do
    fetch_retry "$_url" "$_out" || {
      echo "vendor: $_label — download FAILED after retries from $_url" >&2
      exit 1
    }
    if echo "$_sha  $_out" | shasum -a 256 -c - >/dev/null 2>&1; then
      return 0
    fi
    _d=$((_d + 1))
    if [ "$_d" -ge 3 ]; then
      echo "vendor: $_label — sha256 MISMATCH after 3 fetches from $_url (expected $_sha) — refusing to continue" >&2
      rm -f "$_out"
      exit 1
    fi
    echo "vendor: $_label — digest mismatch (fetch $_d) — refetching from $_url" >&2
    rm -f "$_out"
  done
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

# The upstream-suite growth round 3 (2026-09-25): the test faces the suite's
# own packages import — pinned at the dsh-v0.1.6-alpha.2 lockfile's exact
# resolutions. Served to specs through the npm-bridges shim (subpath rows);
# NEVER mounted by the product boot (test faces, not closure).
# dir|tarball-url-suffix|sha256 — pinned third-party npm packages
# (vendor/npm/<dir>/); versions are exactly what the dsh closure requires.
# The office plane's zip engine (2026-09-27): fflate is the pure-JS
# zip read/write face the dsh-office system plugin mounts the OOXML
# container on (docx/xlsx/pptx are zip+xml; the frozen gateway has no
# inflate primitive — the tar-mini.js note). Mounted by the product
# boot through the npm-bridges seam (the bare name "fflate").
# NOTE: rows below are pipe-delimited dir|suffix|sha — the reader loop
# cannot skip comment lines, so prose stays HERE, never inside the string.
# The WEB PLANE row's npm faces (issue #335 B5): the ctx.web seam + the
# model-facing web tools (staged at the vendor/dsh/<stripped> rel path like
# tool-present — the mirror serves no vendor/dsh tree for them), plus
# tool-web's link-time deps: turndown's ESM face, its CJS-only HTML parser
# domino (served through the shims' cjs-loader), and the GFM rules plugin.
# Shas mirror the suite-side pins in ensure-dsh-tests.sh (same bytes, one
# pin per face).
NPM_PACKAGES="
cordis@4.0.2|@deepseek-ai/cordis/-/cordis-4.0.2.tgz|686ca44fc6e8d217804de9062b716b7c72755dde09c2a433dd07045eea3c6a97
@noble/hashes@2.3.0|@noble/hashes/-/hashes-2.3.0.tgz|892281f5dd25ddea8e215c740945bacdfc78aa4fca81f2c25a06876366c8beac
@earendil-works/pi-ai@0.85.1|@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz|af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253
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
@deepseek-ai/dsh-goal@0.1.6-alpha.2|@deepseek-ai/dsh-goal/-/dsh-goal-0.1.6-alpha.2.tgz|fad5689d46a8798dcef9cb3eda948fba461ce0c8f81d484d6ec1ef1c8403ef41
@deepseek-ai/dsh-tool-present@0.1.6-alpha.2|@deepseek-ai/dsh-tool-present/-/dsh-tool-present-0.1.6-alpha.2.tgz|ec7b417bcc013c345ee98b3d71195c11f0e9a3f181ab2a02d5da3d3e954ac431
@deepseek-ai/dsh-tool-ralph@0.1.6-alpha.2|@deepseek-ai/dsh-tool-ralph/-/dsh-tool-ralph-0.1.6-alpha.2.tgz|e1b7a6f937411936c0a1ee16933e741e3197c0de835b0894365d9055ac6829c2
@deepseek-ai/dsh-tool-bash@0.1.6-alpha.2|@deepseek-ai/dsh-tool-bash/-/dsh-tool-bash-0.1.6-alpha.2.tgz|6f170629f3762b895a079511aad1931953e3c1fd8c3e03ef6dc677ed9f2ac249
@deepseek-ai/dsh-tool-pwsh@0.1.6-alpha.2|@deepseek-ai/dsh-tool-pwsh/-/dsh-tool-pwsh-0.1.6-alpha.2.tgz|6647a1a0c8a7fdaa4d836e6dd9aca638df02c8434c8a03be0ddf73b9c5bc71df
@deepseek-ai/dsh-client-ui-slots@0.1.6-alpha.2|@deepseek-ai/dsh-client-ui-slots/-/dsh-client-ui-slots-0.1.6-alpha.2.tgz|90ef036a6622b027dfbcb46986122eda45e7d0f7617d9fa82aa3d444a99ac887
diff@9.0.0|diff/-/diff-9.0.0.tgz|b898bf23c95594607576e25ddd4013f1d51ed0e862aaf0732815830c87b3b58f
yaml@2.9.0|yaml/-/yaml-2.9.0.tgz|008fa204cb1ba700e0272ba045abbf09a6ffe63456e8146ba97cac6c2ad1ef91
zustand@4.4.7|zustand/-/zustand-4.4.7.tgz|c22d32f791abba72fc246ef1d3ca964d01da204bc73727318a5be61daa2ad66b
eventsource-parser@3.1.0|eventsource-parser/-/eventsource-parser-3.1.0.tgz|eca84ce0e9314076ea17bcc8bbdfed0316cc5b4a291565b347a275ffdac5053a
fflate@0.8.2|fflate/-/fflate-0.8.2.tgz|61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc1cc9998d141dc
jpeg-js@0.4.4|jpeg-js/-/jpeg-js-0.4.4.tgz|269f988267bc71efe58baf97e8b2da064b5bbbbb8b0eab11e2149049935e1160
pngjs@5.0.0|pngjs/-/pngjs-5.0.0.tgz|4d960bbbe078022d7a36822e2874f884c7410ead111f3603d69d70fc7af36f20
@deepseek-ai/dsh-web@0.1.6-alpha.2|@deepseek-ai/dsh-web/-/dsh-web-0.1.6-alpha.2.tgz|a9caf68f424d3c622dc10327c7a39f28139dbf59cb9588355aa75628aeeeac79
@deepseek-ai/dsh-tool-web@0.1.6-alpha.2|@deepseek-ai/dsh-tool-web/-/dsh-tool-web-0.1.6-alpha.2.tgz|96032606273af1d4179db1e675a4b07304b3f9deaa43fb68ab56d284fef99ab0
turndown@7.2.4|turndown/-/turndown-7.2.4.tgz|05f61bc3f0aeca5e5cd7f1b5492e26b9040bb00708cd41fb1b0f7b216e296fa0
@mixmark-io/domino@2.2.0|@mixmark-io/domino/-/domino-2.2.0.tgz|b829bcca09544649f6432020dd6915b6fb054154d7a77eb6f8b3fb1f4165afec
@joplin/turndown-plugin-gfm@1.0.67|@joplin/turndown-plugin-gfm/-/turndown-plugin-gfm-1.0.67.tgz|59f5c59b28bb690bc1cb2d00c67b5e798ce5b29032989892b27a491093e6cde5

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
        fetch_verified "dsh/$dir" "$DSH_BASE/$tgz" "$tmp" "$sha"
    fi
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
    # Tier 1: the TRACKED MIRROR (vendor/dsh-tarballs/, the same record
    # fetch_dsh reads) — PARTIAL coverage: add-package.sh fetch drops a
    # tarball there only for packages vendored through it (measured
    # 2026-09-29: 14/26 npm rows carry a mirror tarball), so a cold checkout
    # materializes THOSE pins without network; the rest still ride the
    # registry. The mirror file name is add-package.sh's FLAT spelling of
    # dir (leading @ stripped, / and @ folded to -) — the exact bytes the
    # pin row's sha256 names. Digest check unchanged: a mismatched or
    # missing mirror falls through to network, and the caller's sha256 -c
    # still guards whatever lands.
    MIRROR="dsh-tarballs/$(printf '%s' "$dir" | sed 's/^@//; s|/|-|g; s/@/-/').tgz"
    if [ -f "$MIRROR" ]; then
        echo "$sha  $MIRROR" | shasum -a 256 -c - >/dev/null \
            && cp "$MIRROR" "$tmp" \
            || echo "vendor: mirror digest mismatch for $dir — falling through to network" >&2
    fi
    if [ ! -s "$tmp" ]; then
        fetch_verified "npm/$dir" "$NPM_BASE/$suffix" "$tmp" "$sha"
    fi
    rm -rf "npm/$dir"
    mkdir -p "npm/$dir"
    # Directory modes ride the tarball verbatim, and some registry tarballs
    # pack dirs without the execute bit (pngjs@5.0.0 measured 2026-09-29:
    # lib/ landed drw-r--r--) — every require under it then fails
    # MODULE_NOT_FOUND-shaped while the files are all there, and the embed
    # generator's rglob silently yields an empty row. Worse, the two tar
    # flavors disagree MID-extract: GNU tar applies a directory's archived
    # mode the moment the entry lands, so pngjs's drw-rw-rw-packed lib/ and
    # coverage/ blocked their OWN children and the extract itself died
    # "Cannot open: Permission denied" across lib/* and coverage/lcov-report/*
    # before any chmod could run (CI 2026-09-30, run 36609975825); bsdtar
    # defers all dir modes to the end, which is why local trees extracted
    # clean. Delay the restore where the tar is GNU; the u+rwX below then
    # normalizes the end state on both hosts. Owner hygiene, not a content
    # edit (D6: the file BYTES are untouched; a re-extract reproduces them
    # exactly).
    if tar --version 2>/dev/null | grep -q GNU; then
        tar xzf "$tmp" -C "npm/$dir" --strip-components=1 --delay-directory-restore
    else
        tar xzf "$tmp" -C "npm/$dir" --strip-components=1
    fi
    chmod -R u+rwX "npm/$dir"
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

# FINAL VERIFICATION — the script is its own gate, not a later gate's prey
# (#289 feedback: a materialization gap surfaced only when a downstream gate
# tripped over the missing tree). Every pin row must sit on disk with
# package.json AND a stamp naming ITS digest; anything else is a named,
# non-zero failure here, at top level (outside the fetch pipelines above, so
# the verdict cannot be lost to a subshell boundary).
miss=0
for row in $DSH_PACKAGES; do
    name=${row%%|*}; rest=${row#*|}; ver=${rest%%|*}; sha=${rest##*|}
    dir="dsh/$name@$ver"
    if ! [ -f "$dir/package.json" ] || ! [ -f "$dir/.vendor-pin" ] \
        || [ "$(cat "$dir/.vendor-pin")" != "$sha" ]; then
        echo "vendor: MISSING/UNSTAMPED $dir — pin $sha, source $DSH_BASE/deepseek-ai-dsh-$name-$ver.tgz" >&2
        miss=1
    fi
done
for row in $NPM_PACKAGES; do
    dir=${row%%|*}; rest=${row#*|}; sha=${rest##*|}
    if ! [ -f "npm/$dir/package.json" ] || ! [ -f "npm/$dir/.vendor-pin" ] \
        || [ "$(cat "npm/$dir/.vendor-pin")" != "$sha" ]; then
        echo "vendor: MISSING/UNSTAMPED npm/$dir — pin $sha, source $NPM_BASE/${rest%%|*}" >&2
        miss=1
    fi
done
[ "$miss" -eq 0 ] || {
    echo "vendor: upstream DSH closure INCOMPLETE — see the MISSING/UNSTAMPED rows above; refusing to report ready" >&2
    exit 1
}

echo "vendor: upstream DSH closure ready"
