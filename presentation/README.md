# presentation/

Web Client plugins (shared across platforms) — "the UI is swappable" is an
architecture acceptance criterion, so the host mounts exactly one ACTIVE
Web Client from plugin configuration and hardcodes no UI:

- `web-client/` — v0 official Web Client (`dsh-web-client`, type=web-client,
  `web/` assets): a static page that knows ONLY the loopback HTTP + WS
  protocol and renders the session projection (`session-projection@0`:
  session/agent/token-delta/tool/complete events appending into a live
  transcript). Zero host awareness. Mounted by the iOS carrier in session
  mode (`webclient.mount` 7/7) and by the Android and HarmonyOS hosts
  in their binding phases — each embeds a byte-identical copy of `web/`;
  the scenario replay keeps late-connecting pages consistent.
- `web-client-mini/` — v0 config-selected variant (`dsh-web-client-mini`),
  the plugin-system pluggability proof (same vocabulary, amber monospace transcript).
- `official-web/` — v1 (D9): the OFFICIAL upstream web UI dist
  (`@deepseek-ai/dsh-web-frontend`), vendored verbatim from
  deepseek-ai/deepseek-harness at the dsh-desktop-recorded pin, with
  PROVENANCE + sha256 manifest + a reproducible build script, plus the
  58-package application tier under `client-bundles/` (ROSTER +
  PROVENANCE; bytes untracked like the dist, materialized by
  [tools/e2e/ensure-client-bundles.sh](../tools/e2e/ensure-client-bundles.sh)).
  MOUNTED on all three hosts: the carrier-side `ctx.webServer`
  implementation the dist requires — specified in
  `docs/webserver-contract.md`, landed as the Phase-B carrier — serves it
  (route table + upgrade seats + the fallback seat's injection-rendered
  dist index, `/plugins` bundles, the `POST /api` envelope bridge, the
  `WS /api/remote.mux` journal), so a plain release launch reaches the
  official UI with nothing staged from outside. Evidence:
  `officialweb.mount` 14/14 (iOS), `android.officialweb.mount`
  14/14 (Android), `harmony.officialweb.mount` 17/17 (HarmonyOS) in
  [docs/e2e-matrix.md](../docs/e2e-matrix.md).

- `web-client-next/` — v2 (2026-09-25): the SELF-HOSTED full client
  (`dsh-web-client-next`), our own UI in the clarklevis deep-ocean glass
  design language — home (session list + new session), a chat transcript
  with a dedicated streaming tail, collapsible reasoning/tool groups,
  cached-subset markdown, and a send/stop composer. It speaks the OFFICIAL
  plane (`POST /api` envelope + `WS /api/remote.mux` journal streams with
  `assistantStream: true`), not the v0 `/ws` projection — that is what
  makes it two-way (session/create, session/prompt) and live (baseline +
  change frames). Vanilla ES modules, no build step, every file under the
  code-size gate. Served by the SAME SessionServe seat as the official
  dist — the launch configuration selects it (`-dsh-web-client
  dsh-web-client-next` on iOS, `--es dsh.web.client dsh-web-client-next`
  on Android's release boot, `--ez dsh.next true` for Android's E2E drive)
  and the seat swaps the dist root and drops the injection rows (the page
  owns its whole boot); the vendored official dist stays byte-verbatim
  (D6). Iteration loop: `node tools/dev-web-carrier/dev-carrier.mjs
  --client next` (fixture dev-echo turn, desktop speed). Evidence:
  `nextweb.mount` on iOS and `android.nextweb.mount` 19/19 on Android
  ([docs/e2e-matrix.md](../docs/e2e-matrix.md)).

- `web-client-whale/` — the CREATION-MODE plugin (2026-09-26): a third
  self-hosted client (`dsh-web-client-whale`) whose page IS the product —
  a blue whale cruising a deep-ocean scene (pure CSS/SVG animation, zero
  dependencies) — while still speaking the full v0 contract
  (session-projection@0 over `/ws` + the toolbar slot ACK). The whale
  reacts to the session: token deltas spout bubbles, completion releases
  a pod. Selected by `-dsh-web-client dsh-web-client-whale` on iOS and
  `--ez dsh.whale true` on Android (both ride the hosts' session-mock-llm
  drive). Evidence: `whale.mount` 16/16 on iOS, `android.whale.mount` 7/7
  on Android ([docs/e2e-matrix.md](../docs/e2e-matrix.md)).

Which Web Client is active is host configuration (`-dsh-web-client <id>`
launch argument on the iOS spike; default `dsh-web-client`) — the device
evidence behind the swappable-UI claim being the config-selected client
swap (`ui.client-swap` 7/7) and a component-level slot registration (the
`dsh-notes` plugin's `notes.toolbar`, logged `slot.register` →
`slot.registered`):
[hosts/ios/artifacts/m3-pluginization](../hosts/ios/artifacts/m3-pluginization).
