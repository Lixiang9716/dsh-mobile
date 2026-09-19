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
- v1 (future): the official `dsh-web-frontend` React UI as the default Web
  Client, then the mobile-ui plugin (slot-registered mobile surfaces:
  approval cards / bottom toolbar / session list)

Which Web Client is active is host configuration (`-dsh-web-client <id>`
launch argument on the iOS spike; default `dsh-web-client`).
