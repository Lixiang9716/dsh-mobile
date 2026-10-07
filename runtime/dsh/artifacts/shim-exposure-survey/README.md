# shim-exposure-survey — the exposure map's committed evidence (T-0078, 2026-09-30)

The DSH_MODULE_MANIFEST mechanism's standing in-repo proof, beside the
per-run proof in `../macos-cli-shim-exposure-probe/manifest.txt` (the probe
leg's own switch-on manifest). This directory carries the SURVEY halves:

- `baseline.txt` — the harness-baseline leg's manifest: one upstream-suite
  leg run with a nonexistent spec (`upstream-tests/definitely-missing.spec.mjs`),
  so the loader records exactly the shims every leg pays before any spec
  body runs. 67 lines, every one `upstream/shims/…`.
- `exposure-table.md` — tools/shim-exposure.mjs's aggregate over the full
  sweep (648 spec manifests + this baseline): 86 shims, 85 exposed,
  zero-exposure exactly `dsh-session-persistence.js`; the per-shim counts
  and the sharp/ CJS-channel paths are in the table.

The sweep manifests themselves stay untracked (gitignored `tmp/` — 648
files of per-spec rows); these two files are the digest a reader can check
the map against. Regenerate from a clean tree:

```sh
test/upstream-suite/transpile.mjs                       # or use the pinned manifest
runtime/dsh/ci/run-shim-exposure-sweep.sh --paral 8   # ~8 min at paral 8
node tools/shim-exposure.mjs tmp/shim-manifests \
    --baseline tmp/shim-manifests/__baseline__.txt      # the table
```

Sample honestly stated: the local transpile regenerated 648 specs against
the committed 681 pin (esbuild resolution drift); 618/648 legs reached a
suite/summary — import-time loads are recorded even where a leg failed, so
exposure undercounts only specs whose imports themselves died early.
A manifest line is a module LOAD, not a behavior press: the map locates
the blind tail, `scenario/shim-exposure-probe.js` presses the behavior.
