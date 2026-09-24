---
name: vendor-package
description: Use when introducing, pinning, or refreshing a vendored npm or @deepseek-ai package into the runtime closure — 引入包/接入包/vendor a package/add a pinned dependency — covering the pin tables, the per-host embed lists (iOS TREES, harmony CLOSURE/BUNDLE_FILES, android assets), preset roster rows, and the commit ordering the closures gate demands.
---

# Vendor a package

The embed lists are hand-edited and the gates exist because they lag. This
skill is the judgment layer; `runtime/spike/vendor/add-package.sh` is the
mechanical layer (fetch / rows / regen / verify). Run the skill's decisions
through the script's mechanics — never hand-place files into vendor trees (a
tree without a pin+stamp is invisible to ensure and silently diverges).

1. **Pick the pin table (= the face the package rides).** Registry tarball
   with a sane `files` field → `NPM_PACKAGES` (materializes at
   `vendor/npm/<name>@<ver>`); monorepo workspace tree served by the mirror
   build → `DSH_PACKAGES` (`vendor/dsh/<name>@<ver>`). When unsure, look at
   where a sibling package lives and why.

2. **Fetch, pin, mirror.** `add-package.sh fetch <name>@<version>` downloads
   from the registry, sha256s it, drops the tarball into the tracked mirror
   (`runtime/spike/vendor/dsh-tarballs/`) and prints the pin row. Paste the
   row into `ensure-dsh.sh`, `git add` the tarball, run
   `runtime/spike/vendor/ensure-dsh.sh`. The fetched bytes must hash to the
   pin — if they don't, the version was re-cut upstream; stop and say so.

3. **Decide where it embeds.** `add-package.sh rows <name>@<version>` prints
   per-host rows for the face you pinned; paste what matches the judgment:
   - **iOS TREES**: a package riding the agent preset stages at
     `vendor/dsh/<workspace-name>@<ver>` (no `dsh-` prefix) with npm-face
     bytes — `WebBootRuntimeDrive.agentPresetsSeedDelivery` writes
     preset-health node_modules markers ONLY for `vendor/dsh/` dirs. A
     service boot.js imports directly stages in place (the dsh-goal
     pattern). A missing source dir fails the generator loud since the
     2026-09-24 guard — never silence it.
   - **harmony**: dsh-face → add the name to `SPINE_PKG_DSH`; npm-face lib →
     explicit CLOSURE rows; npm-face PRESET package → needs the rel→src copy
     mapping in vendor-official.sh that does not exist yet (**T-0048**) —
     either implement it or leave harmony honestly behind and say so in the
     PR. BUNDLE_FILES must list every staged path both directions.
   - **android**: the stager is wholesale — verify with
     `hosts/android/ci/stage-spine-closure.sh --check`, no rows needed.
   - **preset roster** (`presets-mobile/mobile/agent.cordis.yml`): rows ONLY
     for model-facing tools/plugins, and only AFTER the embed exists —
     preset health hard-fails a roster row it cannot resolve, which breaks
     every session joining the preset.
   - **boot wiring** (options.* mounts, dynamic imports) and gateway claims
     are judgment: claim only what a real handler answers.

4. **Regenerate and commit in the gate-legal order.**
   `add-package.sh regen` re-stages all three hosts. The closures gate diffs
   worktree-vs-index and RESTORES on drift — regenerated bundles
   (SpikeBundle.c, rawfile, assets) must be COMMITTED before any gate runs.
   The house shape is two commits (runtime closure + list rows, then the
   regenerated embeds); never text-merge a generated file.

5. **Verify.** `add-package.sh verify` runs the fast closure subset. If the
   embed moved, prove determinism before pushing: scratch clone
   (`git clone file://$PWD /tmp/x`), run ensure.sh + ensure-dsh.sh +
   `gen_bundle_header.py` there, `cmp` the two bundles. Then the full
   `gov run`, an Agent Note, and the normal PR flow.

6. **Traps that already burned PRs** (#184, #196, #206): embed-list lag is
   the DEFAULT failure (every host's list is hand-edited); copy-never-prunes
   (a dev vendor tree can carry stale faces a fresh fetch won't produce —
   regenerate from a cold materialization when in doubt); npm faces go
   stale in place (wholesale refresh on re-pin); the merge-ref effect means
   CI runs gates a branch's own gates.json may not have.

Version bumps and re-pins of existing packages reuse this exact flow —
fetch, swap the pin, wholesale-refresh the face, regen, verify.
