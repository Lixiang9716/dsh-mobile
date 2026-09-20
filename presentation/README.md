# presentation/

Web Client plugins (shared across platforms) — "the UI is swappable" is an
architecture acceptance criterion, so the host mounts exactly one ACTIVE
Web Client from plugin configuration and hardcodes no UI:

- `web-client/` — v0 official Web Client (`dsh-web-client`, type=web-client,
  `web/` assets): a static page that knows ONLY the loopback HTTP + WS
  protocol and renders the session projection (`session-projection@0`:
  session/agent/token-delta/tool/complete events appending into a live
  transcript). Zero host awareness. Mounted by the iOS carrier in session
  mode; the scenario replay keeps late-connecting pages consistent.
- `web-client-mini/` — v0 config-selected variant (`dsh-web-client-mini`),
  the M3 pluggability proof (same vocabulary, amber monospace transcript).
- `official-web/` — v1 (D9): the OFFICIAL upstream web UI dist
  (`@deepseek-ai/dsh-web-frontend`), vendored verbatim from
  deepseek-ai/deepseek-harness at the dsh-desktop-recorded pin, with
  PROVENANCE + sha256 manifest + a reproducible build script. NOT yet
  mounted: the carrier-side `ctx.webServer` implementation it requires is
  specified in `docs/webserver-contract.md` and lands in the Phase-B
  carrier PR. After that, the mobile-ui plugin (slot-registered mobile
  surfaces) follows.

Which Web Client is active is host configuration (`-dsh-web-client <id>`
launch argument on the iOS spike; default `dsh-web-client`).
