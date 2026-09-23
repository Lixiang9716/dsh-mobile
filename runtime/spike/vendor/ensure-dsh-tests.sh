#!/bin/sh
# ensure-dsh-tests.sh — materialize the UPSTREAM TEST ASSETS for the
# full-suite compatibility run (decision D9's testing completion): the test
# files come from the upstream monorepo at the SAME tag the vendored runtime
# closure pins (dsh-v0.1.6-alpha.2 — tests are not carried by the npm
# tarballs), and the test-support vehicles (agent-loop-testkit, llm-replay,
# session-snapshot, loader-smoke) come from npm at the exact same version,
# vendored with the same pin discipline as ensure-dsh.sh.
#
# Everything lands under the UNTRACKED vendor tree (one codeload tarball,
# sha256-pinned; tests are extracted verbatim — never edited, D6).
set -eu
cd "$(dirname "$0")"

TAG="dsh-v0.1.6-alpha.2"
TARBALL_SHA256="fd7aa383a9ffd122ab9e3d50d21b860452f183c2a4d71990b3998c8fb19caaee"
TESTS_DIR="dsh-tests@$TAG"
STAMP="$TESTS_DIR/.vendor-pin"

if [ -f "$STAMP" ] && grep -q "$TARBALL_SHA256" "$STAMP" 2>/dev/null; then
    echo "vendor: $TESTS_DIR present (pin-stamped)"
else
    echo "vendor: fetching upstream tests at $TAG (one codeload tarball)"
    TMP_TGZ="$(mktemp /tmp/dsh-tests.XXXXXX.tgz)"
    fetch() {
        curl -sSL --retry 3 --max-time 300 \
            "https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/$TAG.tar.gz" \
            -o "$TMP_TGZ"
    }
    attempt=1
    until fetch; do
        attempt=$((attempt + 1))
        [ "$attempt" -gt 3 ] && { echo "vendor: download FAILED after $((attempt - 1)) attempts" >&2; exit 1; }
        echo "vendor: download attempt $attempt failed, retrying"
    done
    echo "$TARBALL_SHA256  $TMP_TGZ" | shasum -a 256 -c - >/dev/null
    rm -rf "$TESTS_DIR"
    mkdir -p "$TESTS_DIR"
    # Extract ONLY the test trees + the shared test scripts the suites
    # import (vitest setup files) — verbatim, paths preserved.
    tar xzf "$TMP_TGZ" -C "$TESTS_DIR" --strip-components=1 \
        --wildcards \
        "*/packages/*/tests" \
        "*/scripts/test-invariants.ts" \
        "*/scripts/test-proxy-environment.ts" \
        "*/vitest.shared.ts" 2>/dev/null || true
    rm -f "$TMP_TGZ"
    printf '%s\n' "tag=$TAG" "tarball-sha256=$TARBALL_SHA256" > "$STAMP"
    echo "vendor: $TESTS_DIR refreshed"
fi

# The test-support vehicles ride the SAME npm pin discipline as the runtime
# closure (ensure-dsh.sh's NPM_PACKAGES shape).
ensure_npm() {
    name="$1"; ver="$2"; sha="$3"
    # The pin table mixes SHORT names (the registry package minus the scope's
    # `dsh-` prefix: agent-loop-testkit → @deepseek-ai/dsh-agent-loop-testkit)
    # and FULL names (the test closure's bulk: dsh-agent-default-model →
    # @deepseek-ai/dsh-agent-default-model). Prefixing unconditionally built
    # dsh-dsh-… URLs that 404 — and without `curl -f` the 404 JSON body was
    # saved as the "tarball", surfacing only as a baffling shasum mismatch
    # (the first CI run of this table, run 35829896159). One prefix, never two.
    case "$name" in
        dsh-*) pkg="$name" ;;
        *) pkg="dsh-$name" ;;
    esac
    dir="npm/@deepseek-ai/$name@$ver"
    if [ -f "$dir/.vendor-pin" ] && grep -q "$sha" "$dir/.vendor-pin" 2>/dev/null; then
        echo "vendor: npm/$name@$ver present (pin-stamped)"
        return
    fi
    echo "vendor: fetching npm/$name@$ver"
    rm -rf "$dir"; mkdir -p "$dir"
    tgz="$(mktemp /tmp/dsh-npm.XXXXXX.tgz)"
    curl -fsSL --retry 3 --max-time 300 \
        "https://registry.npmjs.org/@deepseek-ai/$pkg/-/$pkg-$ver.tgz" -o "$tgz" \
        || { echo "vendor: download FAILED: @deepseek-ai/$pkg@$ver" >&2; rm -f "$tgz"; exit 1; }
    echo "$sha  $tgz" | shasum -a 256 -c - >/dev/null \
        || { echo "vendor: sha256 MISMATCH: @deepseek-ai/$pkg@$ver" >&2; rm -f "$tgz"; exit 1; }
    tar xzf "$tgz" -C "$dir" --strip-components=1
    rm -f "$tgz"
    printf '%s\n' "url=registry.npmjs.org/@deepseek-ai/$pkg@$ver" "sha256=$sha" > "$dir/.vendor-pin"
}

# Pins (see the closure table in upstream/README.md for the discipline).
ensure_npm "agent-loop-testkit" "0.1.6-alpha.2" "e38ea68a4247994cce31dbc2788eb9d3b28aae0bee2361acade3ad62234ca66b"
ensure_npm "llm-replay" "0.1.6-alpha.2" "85850f414d26bbdac00ebcc05a81212943b92864f386e37c5c2d5818e7b0d04b"
ensure_npm "session-snapshot" "0.1.6-alpha.2" "94f6e24d390271bb917242f628d898d0ab076b0d6e8385d35033f457e1860d81"
ensure_npm "loader-smoke" "0.1.6-alpha.2" "6090e12c50b9ff1d7104ea17ea8c0216644504664ea5698693387857f77c349c"

# The test closure: every additional package the suites import (same tag
# discipline; generated from the materialized pins — reproducible verbatim).
ensure_npm "chunked-list" "0.1.6-alpha.2" "e466f08af99c1ad8f155aac1c1e2e7672be6940ac2e87b0fb322aec6602efe6f"
ensure_npm "dsh-agent-default-model" "0.1.6-alpha.2" "649a1353fdbb65f87c9ac9d7e6ccc60948a88ead8cfbb8def94a8a91f6ee1fe6"
ensure_npm "dsh-agent-instructions" "0.1.6-alpha.2" "17f1eec2cbbe9571320b8ad15a00d3ae7f063df4111b7bc18b13e4045e45eff3"
ensure_npm "dsh-agent-loop-testkit" "0.1.6-alpha.2" "e38ea68a4247994cce31dbc2788eb9d3b28aae0bee2361acade3ad62234ca66b"
ensure_npm "dsh-agent-tool-presentation" "0.1.6-alpha.2" "8db309253780318c2508810a60d0cad9aaef1b21975640f4b42abc9a54a0bda6"
ensure_npm "dsh-anonymous-user-id" "0.1.6-alpha.2" "2030491f97388ac6dfa5df01811c118354fe9a6b78d3b96dda0ce429d6da5ba3"
ensure_npm "dsh-api-gateway" "0.1.6-alpha.2" "b5c5c561767dfec3c56d7828515a8038e655da84db92aac5bedcaefbee0428f9"
ensure_npm "dsh-api-remotes" "0.1.6-alpha.2" "e341d7e1f0a7c7c00380c27bbaf6697011063600359d5facba63a5c85b18903c"
ensure_npm "dsh-api-session-controller" "0.1.6-alpha.2" "21b02e2c55225c272cab6c04a88ad15a8f945abeff35a855377cb990b29d5485"
ensure_npm "dsh-api-settings-controller" "0.1.6-alpha.2" "16254274b80554a123801c4e4da44d11d5e4584888946d33b8b48912c2701479"
ensure_npm "dsh-api-terminal-controller" "0.1.6-alpha.2" "0bdb2f32b74e55aeaf3e2c0fb67ff23e62525d4f67ae0a90ddd38cbb606e467f"
ensure_npm "dsh-api-workspace-controller" "0.1.6-alpha.2" "3ab29914d0b9bc191047b9da8c0e7d8673491cb9b966953da1ab08d6926c767f"
ensure_npm "dsh-api-workspace-files" "0.1.6-alpha.2" "bd3b06780f9e3646ee0085ea2c5d40ec41e76eec5fd427b83276938754148591"
ensure_npm "dsh-app-boot" "0.1.6-alpha.2" "c0e5a1f7fcade8b699a0dd65852a1efd60793261b5eac1157007ad847d79b0cb"
ensure_npm "dsh-attachment-local" "0.1.6-alpha.2" "057210e268c5f4aeaa544428d807a1aaceeb011d0825daee91d553fa273968cc"
ensure_npm "dsh-authorization" "0.1.6-alpha.2" "3ea2a6351957681d2bf33b9bc21ceba657535f98585b7eb4a0224f4ea54b4a5f"
ensure_npm "dsh-bash-local" "0.1.6-alpha.2" "ca619362b42977c009196628363c1b0fa4950399510608096cad4d9a0dc4a9c4"
ensure_npm "dsh-bash-sandbox" "0.1.6-alpha.2" "fd66ec76a10ca6b521a837b2880c51f667469a5fd2dc1584aaf2ebf0c559125d"
ensure_npm "dsh-browser-use" "0.1.6-alpha.2" "dda6b644fe6103a3f2f607ea93b9d9643838456ea70f47f6d99e48c5c71e25b6"
ensure_npm "dsh-client-connection" "0.1.6-alpha.2" "30bcd62a13108d3a02069d73fc2c4c067554e4dbda0f9da033650f7ff5427ca3"
ensure_npm "dsh-client-file-upload" "0.1.6-alpha.2" "16fb4e67c8695572c48b1047355a676f7b62a57ee555a0fad514ef3e01447e9f"
ensure_npm "dsh-client-locale" "0.1.6-alpha.2" "37a650dec1856868ddc0d6e6f7d78f8ce1a926b4aed1604701f736cd504a122a"
ensure_npm "dsh-client-modules" "0.1.6-alpha.2" "ebeccd78185289d1ca14f48e921c2dd8d96c6d455a76debf2fd2601bbd27d512"
ensure_npm "dsh-client-resources" "0.1.6-alpha.2" "40ba615eca687d38d0ea7f6d5a9177d19b94555df3a7cc3277072a937e3380e5"
ensure_npm "dsh-client-store" "0.1.6-alpha.2" "5bd80cf6b75623858dd3f0f6bf9b0a7270dcef63c20f459a4b42d20e3a3d8c2e"
ensure_npm "dsh-client-test-runtime" "0.1.6-alpha.2" "9868af24a2fcedac53a2b2daa6e009e9e4708450f145b965f347de6e199df197"
ensure_npm "dsh-client-ui-agent-preset" "0.1.6-alpha.2" "16e7849b6f33cf8f5491fd3b4f017dbe2bc87328fdc635e2dbb670faacfbc6ec"
ensure_npm "dsh-client-ui-chat" "0.1.6-alpha.2" "42da7e0dc5f5f203fdbb6ee5cc1e61d643920ce958b368ae47c12c58be1c6fc1"
ensure_npm "dsh-client-ui-commands" "0.1.6-alpha.2" "4858b41d68f8e6576b2b8456445ad40db42e5abce3483282e3175eb9c31aafd0"
ensure_npm "dsh-client-ui-conversation" "0.1.6-alpha.2" "54cc606f67169da5d28c7c40f8d901c6b483acf37454478e2be464d105608b17"
ensure_npm "dsh-client-ui-dockkit" "0.1.6-alpha.2" "6e2a412afdad918fa747465054d52398f9dc94bbc15f219251ce12e300872b0a"
ensure_npm "dsh-client-ui-input-trigger" "0.1.6-alpha.2" "e3d40ec94a2b37d2f38d401e10c9f88a73868e88ab32acebcb315deb48a52b5d"
ensure_npm "dsh-client-ui-layout" "0.1.6-alpha.2" "b9bb135a88fd625bd39ce9b1acaf0bb1d5b7987ebacdee7b5102c5276610ae37"
ensure_npm "dsh-client-ui-primitives" "0.1.6-alpha.2" "4556033c6caa9aa00efc2d85ed61c2135df504d83aab6e4ecf1bf4cef9397220"
ensure_npm "dsh-client-ui-renderer" "0.1.6-alpha.2" "a53db336f53152f3f380ba8c2c78078a59bc16f5925d6786b579444e2687e699"
ensure_npm "dsh-client-ui-session" "0.1.6-alpha.2" "8777866e2c28807cf88f775fb7056c273c1cb950ebf231132677a1398c42ffeb"
ensure_npm "dsh-client-ui-settings" "0.1.6-alpha.2" "a89e6acc88367ab32678900bbab5f069b149924e84d225646d445a0c4db0014c"
ensure_npm "dsh-client-ui-settings-models" "0.1.6-alpha.2" "1e3d2bcab1810dd134b524798135f4dff9972c2974b16b5d6cc58e09a3df1340"
ensure_npm "dsh-client-ui-settings-plugins" "0.1.6-alpha.2" "0a34d0fcb0ac19b34dfbd0c6274bf7b56927b4c5a71212dd2365cdf77f88a17f"
ensure_npm "dsh-client-ui-sidebar-documentpreview" "0.1.6-alpha.2" "59549a6768e217ed357dee2fff0add5f769bcdacdd52c5cccc0d6eb20d769884"
ensure_npm "dsh-client-ui-sidebar-right" "0.1.6-alpha.2" "15e10633679f95253d76e68e0dffd67ae392137772ee551899376e6f76e6847d"
ensure_npm "dsh-client-ui-slots" "0.1.6-alpha.2" "90ef036a6622b027dfbcb46986122eda45e7d0f7617d9fa82aa3d444a99ac887"
ensure_npm "dsh-client-ui-theme" "0.1.6-alpha.2" "6f2d0c700c3534e7a984a6370534b0c62a2df2658f11a284b111edf680c0cc1d"
ensure_npm "dsh-client-ui-workspace" "0.1.6-alpha.2" "6215c6f2505fddf90a814589245c5c25fce79458438c6d73e08a91979d17e87f"
ensure_npm "dsh-client-web" "0.1.6-alpha.2" "8e4055d6c36067016feea4de993ab7f71bb6d2b0d4ab632c1a43f4a3dc5bf3c5"
ensure_npm "dsh-cmdline" "0.1.6-alpha.2" "3a854ef7daa62ab1e183fb4aebee2998a626210e1ff66ed515377b6c42b66073"
ensure_npm "dsh-command-compact" "0.1.6-alpha.2" "e3fe6b0f2962253b4a0b459bbe3d162c8b879ba3d71916b74231705edb1955a5"
ensure_npm "dsh-command-feedback" "0.1.6-alpha.2" "5ba012cda008469de1825040a7d2879626704c9d2de5ddbbec5eba73428fb724"
ensure_npm "dsh-command-goal" "0.1.6-alpha.2" "693444996937916595dfd6ddf44785a17a2250141dcbb0a1f63034144a809408"
ensure_npm "dsh-commands" "0.1.6-alpha.2" "cb0d940ad58ec13f5226f610523161deb0d85f36ab113047326dbb18f5c2e560"
ensure_npm "dsh-compaction" "0.1.6-alpha.2" "533f62737409e4f7a4336bc8665ec61fe7d968e4860d8815ae0f137e46bca1a4"
ensure_npm "dsh-compaction-basic" "0.1.6-alpha.2" "5a46540df08aa0749b9ad08afe8ca00e20a7c6c288220e6ac524f29359e5b216"
ensure_npm "dsh-compaction-image-offload" "0.1.6-alpha.2" "31abd3d1bd3b08ac43ee9b4e62a1d1965ff491738c4963cf66624028beccae7e"
ensure_npm "dsh-compaction-tool-result-pruner" "0.1.6-alpha.2" "b1164d27ac6ff2ffa30da7fe7c16bfa57276dc09c32062e91ca062627c5f6b01"
ensure_npm "dsh-computer-use" "0.1.6-alpha.2" "af731824b7b874b93040f87eafc63d88048e811ff55fcf5235c1a5d5944f5f17"
ensure_npm "dsh-cordis-client-runner" "0.1.6-alpha.2" "e172f686d7dbc7bdd20738e978d3bb16b98b803c37179e3412f32536a38c6971"
ensure_npm "dsh-credentials" "0.1.6-alpha.2" "b067f3fcdf5b4616afdfd9e73b89c58848a7ae3421433284f10a03d157fb982b"
ensure_npm "dsh-credentials-local" "0.1.6-alpha.2" "53a334aba961909964a85788cace81fcdff471633f39f5c09787669e1dfa7691"
ensure_npm "dsh-deepseek-llm-api-extensions" "0.1.6-alpha.2" "630acd1d87c6bb4d71910af6dee54d4e48388e1d1a5a403c87b2834acc7a8370"
ensure_npm "dsh-deque" "0.1.6-alpha.2" "0f13c9b4120b3d219c320df96e55a2856b2f77dd1e1654cd10648c35ec8e3143"
ensure_npm "dsh-experimental-agent-team" "0.1.6-alpha.2" "3929ab78504d8eab5a26f489c5d81feeb8c4a568081594a86465a7bdef602226"
ensure_npm "dsh-experimental-auto-review" "0.1.6-alpha.2" "bdf728e053137775610a2197c9c908c02b8f053bc6a038035eebbc2c3f867032"
ensure_npm "dsh-experimental-browser-use-runtime" "0.1.6-alpha.2" "147eadb719bae5558de658a2d8a5c9f7448072252258d297cf26c1d3c1f9898c"
ensure_npm "dsh-experimental-webworker-packer" "0.1.6-alpha.2" "f723e60bd6f1067de86fa95c4c056509ee46bde5cc0f482789dc567e377bfadd"
ensure_npm "dsh-experimental-webworker-runtime" "0.1.6-alpha.2" "d81e877ac81f41b19148d865512385051eeed13f611060673e5b1858e7851a07"
ensure_npm "dsh-file-reference" "0.1.6-alpha.2" "a26f311c6002f65c7aae9a40b32287d7d87352ea64a21405f1e9c070620fba5d"
ensure_npm "dsh-file-reference-local" "0.1.6-alpha.2" "05a17ee9e586514793078a7301c64c6c0bbcb40b48576988a9518846fe55412b"
ensure_npm "dsh-fs-observation-policy" "0.1.6-alpha.2" "0255ed745d392b20c086cc55745c5ee74f012b29f34a8342a2fd0809524a7112"
ensure_npm "dsh-fs-sandbox" "0.1.6-alpha.2" "c4ef917c21fdd04191bccade73e5bb4778bd6bfddee751c850277ac5a87297b2"
ensure_npm "dsh-fs-ssh" "0.1.6-alpha.2" "1b44b1319574093038ad59f5e120b4e7142d2f2234304f766f1b713a21ac3dc0"
ensure_npm "dsh-goal" "0.1.6-alpha.2" "fad5689d46a8798dcef9cb3eda948fba461ce0c8f81d484d6ec1ef1c8403ef41"
ensure_npm "dsh-goal-round-driver" "0.1.6-alpha.2" "82b33394a15622aa2842d6052f22cd56c7999a682b1a688130c6dec706446bd2"
ensure_npm "dsh-hmr" "0.1.6-alpha.2" "b6d61a6a961c750734d31aad951fb0ede80b554b041311a4616116729e17d39b"
ensure_npm "dsh-hooks-claude-code" "0.1.6-alpha.2" "0d3bad2d8d6a3d4489dea935adb2e7dcca632cd64ca0787d2fdd9520eb9ba7a0"
ensure_npm "dsh-hooks-codex" "0.1.6-alpha.2" "c3711d1576350b6b038677c7cb91a969c224feaf00733f6e8f906e660533f787"
ensure_npm "dsh-host-directory-picker" "0.1.6-alpha.2" "0620c19b056bc0ccf8282d9fcc8d5d0ad68b5e71feadab43c25af47df30da60f"
ensure_npm "dsh-host-directory-picker-browse" "0.1.6-alpha.2" "cf25364706956a2c596166152c005ef93634b42eeee570c02a091a70852432fb"
ensure_npm "dsh-host-directory-picker-native" "0.1.6-alpha.2" "1452e501b2a7836536c72447b70846a0ce17e4fc0fc31b787826580642becba2"
ensure_npm "dsh-host-webserver" "0.1.6-alpha.2" "c5135d1d24d4134f212105bf77ae393e0a39abc8dfa265b5a6038c2943910e8e"
ensure_npm "dsh-http-proxy" "0.1.6-alpha.2" "4e14dbd852837968f7f05409526665d058198167135e29a5d05b37a5d2c993ae"
ensure_npm "dsh-jobs" "0.1.6-alpha.2" "4b4a1a4c4cd1e2aa992253dbb385de78c38c6e7d851dcbb8ee6e139d9b70dea7"
ensure_npm "dsh-jobs-local" "0.1.6-alpha.2" "f6a5b4513498ab6f001730b641e84cbfb3fd807da9bf113254eb5b08a333825f"
ensure_npm "dsh-launch-environment" "0.1.6-alpha.2" "5dab2fac358f02b91a07107e2692a7e9ba8e694fc27f44de39f394d1817701c6"
ensure_npm "dsh-llm-deepseek" "0.1.6-alpha.2" "d4dd3b3f19fbce676d271b5109aa129a3760205fcea69c455b94610a72014d81"
ensure_npm "dsh-llm-pi-ai" "0.1.6-alpha.2" "ba7b73b5d7eb7570e1195aebb4325d2dd83ae4e939de82ec4f5fc0fc5c176854"
ensure_npm "dsh-llm-retry" "0.1.6-alpha.2" "69f1080bf42d134f0009a121aca3b79f945a1d1af7a3d92e4d2481339e355fac"
ensure_npm "dsh-loader-smoke" "0.1.6-alpha.2" "6090e12c50b9ff1d7104ea17ea8c0216644504664ea5698693387857f77c349c"
ensure_npm "dsh-lsp" "0.1.6-alpha.2" "f768827328b3c92024ffc828254ece0b20511b6aafc73546d6e5be2d000aba6e"
ensure_npm "dsh-lsp-stdio" "0.1.6-alpha.2" "1bf62fe3dff9809241878eeca8d05bcda29eca2891e5b1a0a30dd2dc54aa12f6"
ensure_npm "dsh-mcp-client" "0.1.6-alpha.2" "293766105bd332f5dd70089993becaf6a5c683ebb7c6b3ea66621feca4f66d07"
ensure_npm "dsh-mcp-resources" "0.1.6-alpha.2" "26636a94c3b9e7f53de13b1a9c8c1a1f2408396b5b0cb4e06242a87e3e65c082"
ensure_npm "dsh-message-feedback" "0.1.6-alpha.2" "1c83075243ae245439615d4a05e029b5251b077bf13a305e65f3c6f11b7dab6b"
ensure_npm "dsh-native-command" "0.1.6-alpha.2" "add999e43df2a7982b0674e301cd31f0fdb2c930ab4c1aca618594cf9b452ec7"
ensure_npm "dsh-office-to-pdf" "0.1.6-alpha.2" "3cf04ef0ff0184280e50a42972acbbde5d61218dd399a7930913474840a2d8ed"
ensure_npm "dsh-output-retention" "0.1.6-alpha.2" "3b17f0a403e952d4860a3ca7f1c43fd7f76fbb07c0fde30f250ac6a9a0afd19a"
ensure_npm "dsh-permission-presets" "0.1.6-alpha.2" "30fad79c610ff556720c2cf0b94fe0ba656661c2f785bf14e6784096191633d3"
ensure_npm "dsh-persona" "0.1.6-alpha.2" "48be2c580c9aa989d790afa422029eb8f40cfc64fde4a4cc1f540b8bca507c0f"
ensure_npm "dsh-plan-mode" "0.1.6-alpha.2" "2c43489e2b479782a72e08ce07c6b5bb4eba62e82a43732e1ee8b6fbfab35daa"
ensure_npm "dsh-plugin-manager" "0.1.6-alpha.2" "b7ba2861980f461fe6d861c19b9e6127548c43e5f72ea08c29ba86d7b13307cd"
ensure_npm "dsh-plugin-package-inventory-deepseek" "0.1.6-alpha.2" "9838fb5a05a31315559c7ddffb9552606e5129ca86702132ec8b5407c6290d94"
ensure_npm "dsh-ptc-runtime" "0.1.6-alpha.2" "65d23d91654da14008b4872d8b7c113044f18175d0eb5baafc1f72e66c34472f"
ensure_npm "dsh-ptc-runtime-node" "0.1.6-alpha.2" "b33b9effe6d63e276540de84afe742517a3ebb4bd218c79048664d8152076205"
ensure_npm "dsh-pwsh-local" "0.1.6-alpha.2" "db793ce5ea04875b52c6862ecee51e057abd68da63f7144f06e5f0a366f38755"
ensure_npm "dsh-remote-mock" "0.1.6-alpha.2" "46239a8064512e55922333b543cf41f6dc397000815cf82d8eb0f5dd6503ecc3"
ensure_npm "dsh-repeat-tool-reminder" "0.1.6-alpha.2" "934d093874ea187140171729e1b5a42c28d6fbaa91a89378edf2162a1f967b53"
ensure_npm "dsh-sandbox-local" "0.1.6-alpha.2" "4fdc05c256d9dacce23ac5a8bfbd033a95ae6a5e09c91e8531897b28069755d8"
ensure_npm "dsh-sandbox-policy" "0.1.6-alpha.2" "b0df10b1ad7087361dd1bc28a165891e7c81a6e982b800e3ce0f291d51dc4da3"
ensure_npm "dsh-sandbox-ssh" "0.1.6-alpha.2" "6ea02a1347428603de653db284583323455ccccbd6b7467ab3eaf89f5e24e23d"
ensure_npm "dsh-schedule" "0.1.6-alpha.2" "ddd5ac53fa6fa89d5d3269935022f5ee476a4b79c5f259b561692acbe8b3e953"
ensure_npm "dsh-sdk-client" "0.1.6-alpha.2" "fac9940ec737762861829e3cd180f256d7a189339b7654b9f3a58254845798eb"
ensure_npm "dsh-session-format" "0.1.6-alpha.2" "1f8583840d78b54b43d08c80bf31d5688ea0cd9f991e5823902ee3c83cb22f0d"
ensure_npm "dsh-session-format-catalog" "0.1.6-alpha.2" "2af27dd4b6d6cef35b7618264d762ea48a2b92c8a414a1e5e8d1acf665e3e340"
ensure_npm "dsh-session-format-v0-to-v1" "0.1.6-alpha.2" "f3d458503007a986ca7ba8510c92e30425fb3d56d282b937fc8c342e7aa13952"
ensure_npm "dsh-session-format-v1-to-v2" "0.1.6-alpha.2" "3ba7c561d637073b81fe1b2077fec19776a2e00abc191769b0bc008b85358a8e"
ensure_npm "dsh-session-log-deepseek" "0.1.6-alpha.2" "c818a721fcdbb9cf4a37e81cd43f26c4ec46941a7f279ab78cedf1d08bee34db"
ensure_npm "dsh-session-log-export" "0.1.6-alpha.2" "ecf868e66a0e88c4245edfddfa22638e4f3ede2ccba4e6d697e2f2504cecd7c1"
ensure_npm "dsh-session-persistence-jsonl" "0.1.6-alpha.2" "4acf76602ba7b031f1991ab6a518190c7d8ef5da4f217f25685881e37fdbcf89"
ensure_npm "dsh-session-projection-cache" "0.1.6-alpha.2" "a543d77a844d24e70b249cdad3ffec261bdf105272a1e1f2fc6207327cd81fe2"
ensure_npm "dsh-session-query" "0.1.6-alpha.2" "e9291150b6fca217cff3198584e3db5d06909f957c109e8f2042b3e38e1eaf9c"
ensure_npm "dsh-session-query-sqlite" "0.1.6-alpha.2" "390b9c3fc2c902970269f64dc301b0ccc720d56b4d83cf6c3cb53fe2cfbc2ec4"
ensure_npm "dsh-session-reference" "0.1.6-alpha.2" "528728f1e2cc4e51b0abbf11ce472c81896a7ed1cc5f3180d9c3a5cb6e6b6d8f"
ensure_npm "dsh-session-stats" "0.1.6-alpha.2" "18ad0e59badf5838f2fb42560f0bc35de9bf631b7cf144998d1aa02fc5fe365f"
ensure_npm "dsh-session-title" "0.1.6-alpha.2" "2676ae1cb72a7996c80cdbf78458958ca2b17a92cb186176e4f7a095069c03cd"
ensure_npm "dsh-session-title-all-prompts-llm" "0.1.6-alpha.2" "8c1705604f5f8ca4fc24d04f6333e790ff0246565f4aecf5d6a120d7005d6d74"
ensure_npm "dsh-session-title-first-prompt-llm" "0.1.6-alpha.2" "4172bb2b689508f833f52f739f5541d37fe56920bd548d835d296cbe8b81c7be"
ensure_npm "dsh-session-title-llm" "0.1.6-alpha.2" "2bb4a074693ca9fd1a372f654e5b12d3400dd82f7656d8211eae853f6ff00a50"
ensure_npm "dsh-session-turn-outline" "0.1.6-alpha.2" "d9167ffa78560ab5f1cdf9701e09842d9259b4c94ea0fe8c48bad7abd0c65dec"
ensure_npm "dsh-settings-file" "0.1.6-alpha.2" "54ce1623f96a9eadbd90b2d0857251030d9e452bb19f12900212ff83b05d21dc"
ensure_npm "dsh-shell" "0.1.6-alpha.2" "fd991527fa7e7b25701c56989b74c3760584c1ddd758af4c0f27999c8036db7a"
ensure_npm "dsh-shell-env" "0.1.6-alpha.2" "f7cbf0c5f90dac210c7978ba291ff9a08992808c2306d402d1a08a358ec45280"
ensure_npm "dsh-skill" "0.1.6-alpha.2" "d77b76cab60c18a6bfce07951b648f9a730aa29162a6add96ca0a4b48382bfc3"
ensure_npm "dsh-skill-badge" "0.1.6-alpha.2" "c8d185ca82332bb5a29232fff40355bce1b63f937cfdb718b3172c114c79a2b0"
ensure_npm "dsh-skill-filesystem" "0.1.6-alpha.2" "3d0f30be04ef7362d1cf3fe7b83e4469efb9a593d8929c5c6e4568878b84cc5a"
ensure_npm "dsh-skill-office" "0.1.6-alpha.2" "61305a73f56a59421c6ebec1ffbb47a02d6ffccd50b3aec41e90562d9d0337dc"
ensure_npm "dsh-spill" "0.1.6-alpha.2" "fc45df89e9752c69c5336739f078a30f735a9d161e2af8e3429d66271826984a"
ensure_npm "dsh-spill-local" "0.1.6-alpha.2" "db44acdd45e75a714763534ab40b663be31011c867a4cde32a9d73b8f05f2239"
ensure_npm "dsh-spill-policy" "0.1.6-alpha.2" "40aaa975c36eae06de9b0c36e0532cca7f1d1bdf8ddc2696ad63139a4e142396"
ensure_npm "dsh-ssh" "0.1.6-alpha.2" "43d66dac42b66276d04378c896144f81b10c111d4c83eb848bd78137bb3c3594"
ensure_npm "dsh-storage" "0.1.6-alpha.2" "a28672f6af961264dc383411003041e580a294c9b26d45abf5b4731ce6d318ac"
ensure_npm "dsh-storage-domain" "0.1.6-alpha.2" "a05c9a873af460f3607dfd80deddd0cf22ca1d2124c75880233ad1700d310568"
ensure_npm "dsh-storage-json" "0.1.6-alpha.2" "7e7a8a1919813bbe17abee505c572edd5844f974ab9db27fa909d7ba1536c243"
ensure_npm "dsh-subagent" "0.1.6-alpha.2" "d290a8dcc0a3b1407b469c43d1fc80d5ddac02692a662847a304f75ac04b512a"
ensure_npm "dsh-subagent-fork-in-process" "0.1.6-alpha.2" "2eef5d11deff1c2287b1080efa5a7fdc07f91ae15c3818a60ebc244d18a575c0"
ensure_npm "dsh-subagent-in-process-driver" "0.1.6-alpha.2" "d4d96c747cd9ba2eb04ac0c3bd19da0effbf13c6b1bc2a531b8ddb0bf0ebbe67"
ensure_npm "dsh-subagent-spawn-in-process" "0.1.6-alpha.2" "4a11637cdd818267188afc186ac411ccab1678f42bdfee38e6002c60a91938f3"
ensure_npm "dsh-subprocess" "0.1.6-alpha.2" "52df0b82f8dd7ca41b7958f92990cf3af8697c3427a44a2968bf08c2605a701f"
ensure_npm "dsh-subprocess-local" "0.1.6-alpha.2" "4d1ae1ac95542aca4c48a50e0d1ae0fc47d08370aeaaf2bb898bf7eb377f3ba1"
ensure_npm "dsh-subprocess-ssh" "0.1.6-alpha.2" "64e941ce1821df2b0921f3c3035cd8948460116bbe7a7788d5072da13e71e817"
ensure_npm "dsh-terminal" "0.1.6-alpha.2" "cb9b07571654bcfe6877f8ff860a3ebd17564fe17994a9e905aea0ef41b476a0"
ensure_npm "dsh-terminal-bash" "0.1.6-alpha.2" "37371188474cc7d061e81a3db122a54b6e35baba27b728d1ff40b0075de4638a"
ensure_npm "dsh-time-context" "0.1.6-alpha.2" "5e2252ae1d843f28447180d93ff44ff8ed1f3ebe79b7202f558acbf628759a59"
ensure_npm "dsh-tmux-context" "0.1.6-alpha.2" "42a1cbac081acd329a02f544dbb655e77872ef0305285b9b3e80210af780f7d5"
ensure_npm "dsh-token-meter" "0.1.6-alpha.2" "4a5d72a2fd904155c1b623bc2bad247b28e057e37507784b22a9786a049abc6f"
ensure_npm "dsh-tool-ask-user" "0.1.6-alpha.2" "891d48b5534c8e9f22d03ca524d3d29adabedeacac73bfd841e510f7febc2e13"
ensure_npm "dsh-tool-bash" "0.1.6-alpha.2" "6f170629f3762b895a079511aad1931953e3c1fd8c3e03ef6dc677ed9f2ac249"
ensure_npm "dsh-tool-bash-persistent" "0.1.6-alpha.2" "8e196363da4d01f7660ce6ae028466e92eff504bda3c50a2ed8444ab85264d58"
ensure_npm "dsh-tool-call-timeout-policy" "0.1.6-alpha.2" "cd1269aa72a50db04595467324734b358489c58d0be097fbcec7f174ccf074c5"
ensure_npm "dsh-tool-cordis" "0.1.6-alpha.2" "723d315daf20ebb639c7e6ce6a5331d9d9d1510408c2815e646c1049abb904fa"
ensure_npm "dsh-tool-fs-search" "0.1.6-alpha.2" "255901816e8dc73cf3d9d3d94f82332843bdac4c2c89784226e7696b3e37b0e4"
ensure_npm "dsh-tool-goal" "0.1.6-alpha.2" "a3d550065eccc273aabfb480951773f4c46d46ad1f8921f097b61668b3a28b80"
ensure_npm "dsh-tool-jobs" "0.1.6-alpha.2" "fc5726a83114c64232226bd3bf6c2de939019e18bf8e0fc1ef851a21f9553208"
ensure_npm "dsh-tool-lsp" "0.1.6-alpha.2" "7a564f94208b87c0fd18c3c8f1649ea6a1b71339af97559d3ddf91039c21f631"
ensure_npm "dsh-tool-pwsh" "0.1.6-alpha.2" "6647a1a0c8a7fdaa4d836e6dd9aca638df02c8434c8a03be0ddf73b9c5bc71df"
ensure_npm "dsh-tool-pwsh-persistent" "0.1.6-alpha.2" "66e4c59ef0497fa84e481c7ba2268152a3098b7f77ca5e5043f4769fa87d9a1e"
ensure_npm "dsh-tool-session-query" "0.1.6-alpha.2" "ffa4b4d319b8debda3826763e2adff003b86e5b862d761daab9ce14aed827bdb"
ensure_npm "dsh-tool-skill" "0.1.6-alpha.2" "7608d917b6196b5a92b4643203509c936e169e7fcfe89b7e2852c7b6d7e0d83b"
ensure_npm "dsh-tool-subagent" "0.1.6-alpha.2" "009326aae20a7fa7d8bc2a1d8644e4ae285e38f10bc1ec503508a9f5c49ffb76"
ensure_npm "dsh-tool-subagent-control" "0.1.6-alpha.2" "66bdf77b1bb13f457a87e53fc173497fdf9585c461908d041839d0cd9025d552"
ensure_npm "dsh-tool-terminal" "0.1.6-alpha.2" "9edf2a4b2883ea1486402feaf13a0ae2e1e621b14da9accdebc363b5d0bd3ab1"
ensure_npm "dsh-tool-web" "0.1.6-alpha.2" "96032606273af1d4179db1e675a4b07304b3f9deaa43fb68ab56d284fef99ab0"
ensure_npm "dsh-typert-loader" "0.1.6-alpha.2" "217f0de3c9adee1d87eaf40c2fff9122f31faf129ce3a0c3b69fd563e57d9f93"
ensure_npm "dsh-typert-registry" "0.1.6-alpha.2" "aed3fa84b8a07a48a2ca69cbe48b0c2edfe1950b4589daa0115f1c170ec0c11a"
ensure_npm "dsh-user-approval" "0.1.6-alpha.2" "d73feddbe3a5889822800600d527f7cd7d486dab79323e5ed3a823746664fc02"
ensure_npm "dsh-user-questions" "0.1.6-alpha.2" "0ba8afcc04dcd37b1ccb48f263190280e9139e3e11aa01b6da81a1d831dc6a56"
ensure_npm "dsh-util-time" "0.1.6-alpha.2" "29a25568d19db1475153a65d0600aadc523186ee4eb63bf5641a8e4980d82ff4"
ensure_npm "dsh-util-workspace-path" "0.1.6-alpha.2" "26aa04ded0fb2f247219cd5a91897dd891832444883141369b818d335779d1dc"
ensure_npm "dsh-web" "0.1.6-alpha.2" "a9caf68f424d3c622dc10327c7a39f28139dbf59cb9588355aa75628aeeeac79"
ensure_npm "dsh-web-fetch-http" "0.1.6-alpha.2" "deff3d3aed5063084a0d6320feb7f06cc3c8e22b2381a4d4f146333c39341b5d"
ensure_npm "dsh-web-search-deepseek" "0.1.6-alpha.2" "3ebba89b1d029c8fa632e540fd9056065507a8b33ec6a04cef0b691f2de8d2f5"
ensure_npm "dsh-web-search-exa" "0.1.6-alpha.2" "97265aa7f1dbae3d594b2bfb3224484c170caad30d328fc2da905f5760ca2197"
ensure_npm "dsh-web-search-perplexity" "0.1.6-alpha.2" "eb223e7f5f65db69852c1238be74196fa0154f1e27d17af4ecadea0407241785"
ensure_npm "dsh-win32-process" "0.1.6-alpha.2" "4c0831b02f4346bbba9549cb7c467c740e9fc807d2afecaf2199adce61c92e25"
ensure_npm "dsh-workflow" "0.1.6-alpha.2" "67f06a3509b1b1ec1c87674e46090a883975965108d8f6271c97468f3815b452"
ensure_npm "dsh-workflow-ptc" "0.1.6-alpha.2" "fd7f2e5c8ab0ee2d99c45508cc2d2ecd60f53ec2693aee27d079f07e90229f8e"
ensure_npm "dsh-workspace" "0.1.6-alpha.2" "16a10eea33ff09551cecdb039e56ed12cd37ac7bf4cad175048f2add2b5c0f83"
ensure_npm "dsh-workspace-changes" "0.1.6-alpha.2" "187830ec4f96e7f024263668729bd82427026c4e8dd60345bed380d804b3cbd5"
ensure_npm "lazy-require" "0.1.6-alpha.2" "2c77249d5b51df9453b0c2a9665a639d89f062fee4cec7c3b228531b8b3d36a1"
ensure_npm "session-format-v2-to-v3" "0.1.6-alpha.2" "b488cb16ecae0128f023f985bdc66423f17e6de285d15c60b44ce370d2ef83b6"

echo "vendor: upstream test assets ready"
