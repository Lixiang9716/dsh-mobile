# tools/e2e/

Log-based E2E verdict tooling (no screenshots — those are a local
interactive-debugging aid only; see docs/ARCHITECTURE.md, "E2E
verification").

- `scenarios/<id>.json` — one manifest per scenario: the scenario id, the
  log extraction prefix, and the ordered expected events (each with exact
  field matchers applied to `data[0]`).
- `check.mjs` — the one-to-one expected<->logged matcher: the captured log
  must contain exactly one structured entry per expected event, in
  declaration order, nothing missing, nothing extra. Failure output names
  the first mismatched index with both sides and any unparsable entries.

```sh
node tools/e2e/check.mjs \
  --manifest tools/e2e/scenarios/m1-spike-boot.json \
  --log <captured-platform-log> \
  --out <verdict.json>   # exit 0 = pass, 1 = fail
```

Platforms capture their native log stream (stdout / os_log / logcat /
hilog); the canonical `dsh.spike.log: {...}` lines are byte-identical
everywhere, so one checker serves all hosts.
