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
# closure: session-persistence-jsonl (native koffi dep), subagent, base, and
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
# util-workspace-path stays out: nothing in this closure imports it. See
# runtime/spike/upstream/README.md for the shim coverage table.
set -e
cd "$(dirname "$0")"

DSH_BASE="https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/master/vendor/dsh-runtime/0.1.6-alpha.2"
# The last upstream commit that still carried the 0.1.6-alpha.2 vendor dir
# (a934d9886106, 2026-09-18 "beta 通道切到 dsh 0.1.6-alpha.2 内核"); see the
# fallback note inside fetch_dsh.
DSH_BASE_FROZEN="https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/a934d9886106/vendor/dsh-runtime/0.1.6-alpha.2"
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
diff@9.0.0|diff/-/diff-9.0.0.tgz|b898bf23c95594607576e25ddd4013f1d51ed0e862aaf0732815830c87b3b58f
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
    # Upstream DELETED vendor/dsh-runtime/0.1.6-alpha.2 from master on
    # 2026-09-22 (the beta channel moved to 0.1.7-alpha.2, commit 69982afb),
    # so a cold fetch of these pins 404s on master. The pinned bytes still
    # live at the last commit that carried the dir — verified 2026-09-23:
    # every tarball fetched at DSH_FROZEN_REF reproduces its pin's sha256.
    # The integrity check below is unchanged, so the fallback can never
    # deliver wrong bytes; it only makes a dead-on-master pin fetchable.
    fetch_retry "$DSH_BASE/$tgz" "$tmp" \
        || fetch_retry "$DSH_BASE_FROZEN/$tgz" "$tmp"
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
