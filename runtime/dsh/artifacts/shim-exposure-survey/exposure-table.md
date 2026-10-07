# Shim exposure map (upstream suite → runtime/dsh/upstream/shims)

- spec manifests: 648 (dir tmp/shim-manifests)
- shims total: 86 — exposed: 85, zero-exposure: 1
- baseline (harness-fixed): tmp/shim-manifests/__baseline__.txt — 65 shims load before any spec body
- zero-exposure NOT even harness-fixed (真零曝光): 1
- harness-fixed only (从未被 spec 触达): 0
- sharp/ package files seen on any channel: 9

| shim | spec runs loading it | harness-fixed |
|---|---|---|
| async-hooks.js | 648 | yes |
| boot-tail-loopback-globals.js | 648 | yes |
| boot-tail-url-mutators.js | 648 | yes |
| buffer-codecs.js | 648 | yes |
| buffer.js | 648 | yes |
| cjs-loader.js | 648 | yes |
| cordis-loader-failure-face.js | 505 |  |
| crypto.js | 259 |  |
| describe-each.js | 648 | yes |
| dsh-client-ui-renderer-client.js | 5 |  |
| dsh-session-persistence.js | 0 |  |
| events.js | 648 | yes |
| expect-async-chain.js | 648 | yes |
| expect-poll.js | 648 | yes |
| fs-paths.js | 648 | yes |
| fs-promises-fh.js | 201 |  |
| fs-promises.js | 201 |  |
| fs-readdir.js | 648 | yes |
| fs-seeded.js | 648 | yes |
| fs-stat.js | 648 | yes |
| fs-workspace-rename.js | 648 | yes |
| fs-workspace-write.js | 648 | yes |
| fs-workspace.js | 648 | yes |
| fs-write-stream.js | 648 | yes |
| fs-writes.js | 648 | yes |
| fs.js | 648 | yes |
| globals.js | 648 | yes |
| loader-faces-fs-watch.js | 648 | yes |
| node-addon-system-flock.js | 42 |  |
| node-addon-system-landlock-run.js | 12 |  |
| node-child-process-exec.js | 648 | yes |
| node-child-process-pump.js | 648 | yes |
| node-child-process-tables.js | 648 | yes |
| node-child-process.js | 648 | yes |
| node-http-loopback-client.js | 648 | yes |
| node-http-loopback-dispatch.js | 648 | yes |
| node-http-loopback-net.js | 648 | yes |
| node-http-loopback.js | 648 | yes |
| node-module.js | 506 |  |
| node-perf-hooks.js | 43 |  |
| node-pty.js | 648 | yes |
| node-socket-tcp.js | 648 | yes |
| node-sqlite.js | 3 |  |
| node-stream-duplex.js | 648 | yes |
| node-stream-writable.js | 648 | yes |
| node-stream.js | 648 | yes |
| node-worker-threads.js | 51 |  |
| node-zlib-stream.js | 648 | yes |
| node-zlib-xxh64.js | 648 | yes |
| node-zlib.js | 648 | yes |
| npm-bridges-b.js | 648 | yes |
| npm-bridges-c.js | 648 | yes |
| npm-bridges-c2.js | 648 | yes |
| npm-bridges-pi-ai-all.js | 648 | yes |
| npm-bridges-pi-ai.js | 648 | yes |
| npm-bridges.js | 648 | yes |
| openai-client.js | 5 |  |
| os.js | 300 |  |
| partial-json.js | 5 |  |
| path.js | 404 |  |
| process.js | 648 | yes |
| runtime-modules.js | 648 | yes |
| slot-registry.js | 5 |  |
| source-bootstrap-ipc.js | 648 | yes |
| source-bootstrap-loader-smoke.js | 6 |  |
| source-bootstrap-tsx-stage.js | 648 | yes |
| source-bootstrap-tsx.js | 648 | yes |
| string-decoder.js | 7 |  |
| timers-promises.js | 132 |  |
| timers.js | 648 | yes |
| undici.js | 648 | yes |
| url-file.js | 648 | yes |
| url.js | 648 | yes |
| util-errors.js | 648 | yes |
| util-parse-args.js | 648 | yes |
| util-types.js | 126 |  |
| util.js | 648 | yes |
| vi-wait.js | 648 | yes |
| web-dom-parser.js | 648 | yes |
| web-dom.js | 648 | yes |
| web-event.js | 648 | yes |
| web-fetch-forms.js | 648 | yes |
| web-fetch-values.js | 648 | yes |
| web-multipart.js | 648 | yes |
| web-storage.js | 648 | yes |
| web-streams.js | 648 | yes |

## Zero-exposure shims (loaded by NO spec run)

- dsh-session-persistence.js

## sharp/ package files (CJS channel, not part of the 86)

- sharp/bytes.js
- sharp/gif-codec.js
- sharp/index.js
- sharp/jpeg-codec.js
- sharp/ops.js
- sharp/package.json
- sharp/png-codec.js
- sharp/svg-face.js
- sharp/webp-codec.js
