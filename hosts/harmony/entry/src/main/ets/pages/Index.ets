// dsh:logging-exempt — ArkTS UI logs natively via hilog; the JS
// createLogger contract does not reach this layer (#343).
/*
 * Index — the D9 host page. THREE phases on ONE launch:
 *
 * 1. Regression (synchronous): materializes the bundled rt (byte-identical
 *    rawfile copies of the runtime/dsh originals + the Web Client plugin)
 *    into the app cache dir preserving layout, then calls startSpike ONCE on
 *    the UI thread — boot.verification, gateway.bridge-smoke, session.mock-llm on the ONE
 *    serial JS thread (ARCHITECTURE.md §6). The returned summary is the human
 *    verdict; the E2E verdict is the checker over the captured
 *    `dsh.runtime.log:` lines (never this Text, never a screenshot).
 *
 * 2. Binding phase (event-driven): the loopback carrier serves the materialized
 *    Web Client, ArkWeb mounts it, and HostPhase drives scenario
 *    harmony.capability-binding over the real dispatch bridge — approval dialog below,
 *    notification lifecycle, live token deltas rendered by the page.
 *
 * 3. Official-web phase (D9 W-HARMONY, event-driven): the m5 verdict chains
 *    into OfficialPhase — the canonical officialweb-web-live runtime composes the
 *    OFFICIAL boot wire, the carrier serves the vendored upstream dist from
 *    rawfile with the runtime's rows, and ArkWeb mounts the official app
 *    (harmony.officialweb.mount). The verdict chains through the
 *    httpFetch v2 proof leg against the live carrier
 *    (harmony.httpfetch-streaming) into the SESSION-LIVE leg
 *    (harmony.session.live-read, W-HARMONY3): a fresh runtime boots the FULL
 *    upstream spine and claims session.list + the mux journal from
 *    ctx.sessions — the official page then reads REAL session data.
 *
 * RELEASE builds take the SAME serving seat as phase 3 without any of the
 * drives (see model/OfficialServe.ets): a plain launch — no launch
 * parameter, nothing staged — mounts the official DSH Web UI over the same
 * carrier and the same web-boot runtime, and emits no record at all. A
 * release launch that asks for an E2E leg is refused LOUD by name (rule 5):
 * a user-facing binary has no drives.
 */
import { startSpike } from 'libdruntime.so';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { CarrierServer } from '../model/CarrierServer';
import { installE2EStreams, installLegacyRoutes } from '../model/CarrierRoutes';
import { E2eLeg } from '../model/E2eLeg';
import { HostPhase, WHALE_WEB_DIR } from '../model/HostPhase';
import { LlmConfigStaging } from '../model/LlmConfigStaging';
import { OfficialPhase } from '../model/OfficialPhase';
import { OfficialServe, NEXT_CLIENT_ROOT } from '../model/OfficialServe';
import { V2WebPhase } from '../model/V2WebPhase';
import { ParityMockRoute, PARITY_MOCK_KEY } from '../model/ParityMockRoute';
import { CardPlayerRoute } from '../model/CardPlayer';
import { PickerPrimitives } from '../model/PickerPrimitives';
import { BuildFlavor } from '../model/BuildFlavor';
import { display } from '@kit.ArkUI';
import { SurfaceDims, SurfaceFrame } from '../model/SurfacePrimitives';

const TAG: string = 'dsh.app';
const CARRIER_BASE_PORT: number = 17877;
/** The launch parameter EntryAbility parks in E2eLeg — `--ps dsh.e2e.leg`. */
const LEG_LLM: string = 'llm.live-stream';
const LEG_WHALE: string = 'compact.mount';
const LEG_V2WEB: string = 'v2web.mount';
const LEG_DEVICE_PLANE: string = 'device.plane';
/** The capability plane's camera leg (`--ps dsh.e2e.leg camera.plane`). */
const LEG_CAMERA_PLANE: string = 'camera.plane';
const LEG_PARITY: string = 'upstream.parity';
const LEG_BLE: string = 'ble.plane';
const LEG_MIC_PLANE: string = 'mic.plane';
/** The windows-test-plan T4/T5 leg (`--ps dsh.e2e.leg real.agent.loop`):
 * the spine + tools on the STAGED real backend, the probes in-scenario. */
const LEG_REAL_AGENT: string = 'real.agent.loop';
/** The upstream-suite leg (`--ps dsh.e2e.leg upstream.suite` + `--ps
 * dsh.e2e.spec <file>`): ONE transpiled spec per launch, the QuickJS-shaped
 * harness runs it in the on-device runtime. */
const LEG_UPSTREAM_SUITE: string = 'upstream.suite';
/** The CREATE-mode live demo (`--ps dsh.e2e.leg real.create`): the compact
 * creation client on the STAGED real backend — one Pomodoro-clock creation
 * turn, streamed into the page. A demo: no one-to-one manifest. */
const LEG_REAL_CREATE: string = 'real.create';

// bundle-root-relative files shipped under resources/rawfile/dsh/ —
// logger.js must sit at <bundle>/logger.js, gateway.js at <bundle>/gateway.js,
// the scenarios at <bundle>/scenario/..., the vendored package under
// <bundle>/vendor/... (the rt host's ESM loader resolves these paths).
// webclient/... is the ACTIVE Web Client plugin the m5 carrier serves;
// upstream/... + the vendor/npm libs are the D9 web-boot closure the
// official-web phase runs, and the W-SESS spine closure below it is the
// full upstream agent spine the session-live leg boots (byte-identical to
// the runtime/dsh canonicals — ci/vendor-official.sh cmp-verifies every
// copy; ci/check-bundle-files.mjs pins this list == the tracked rawfile
// tree). EXTEND whenever the closure grows.
const BUNDLE_FILES: string[] = [
  'canonical-json.js',
  'credential-stage.js',
  'ed25519.js',
  'fixtures/dsh-notes-source.js',
  'fixtures/dsh-notes.js',
  'gateway.js',
  'install-fetch.js',
  'install-pipeline.js',
  'llm.js',
  'logger.js',
  'manifest.json',
  'marketplace-resolver.js',
  'plugin-mount.js',
  'surface.js',
  'receipt-journal.js',
  'registry.js',
  'scenario/agent-presets-probe-seed.js',
  'scenario/ble-plane.js',
  'scenario/boot-verification.js',
  'scenario/camera-plane.js',
  'scenario/device-plane.js',
  'scenario/gateway-bridge-smoke.js',
  'scenario/harmony-capability-binding.js',
  'scenario/llm-live-stream.js',
  'scenario/mic-plane.js',
  'scenario/parity-projector.js',
  'scenario/real-agent-loop.js',
  'scenario/real-create.js',
  'scenario/session-mock-llm.js',
  'scenario/surface-pomodoro.js',
  'scenario/upstream-fake-timers.js',
  'scenario/upstream-harness-matchers.js',
  'scenario/upstream-harness-vi.js',
  'scenario/upstream-parity.js',
  'scenario/upstream-suite-flatmap.js',
  'scenario/upstream-suite-leg.js',
  'scenario/upstream-suite-type-world.js',
  'scenario/upstream-test-harness.js',
  'sha256.js',
  'system-plugins/dsh-ble/index.js',
  'system-plugins/dsh-ble/manifest.json',
  'system-plugins/dsh-device-plane/index.js',
  'system-plugins/dsh-device-plane/manifest.json',
  'system-plugins/dsh-fs/index.js',
  'system-plugins/dsh-fs/manifest.json',
  'system-plugins/dsh-office/excel-core.js',
  'system-plugins/dsh-office/excel.js',
  'system-plugins/dsh-office/fschannel.js',
  'system-plugins/dsh-office/index.js',
  'system-plugins/dsh-office/manifest.json',
  'system-plugins/dsh-office/ppt-create.js',
  'system-plugins/dsh-office/ppt-read.js',
  'system-plugins/dsh-office/ppt-write.js',
  'system-plugins/dsh-office/shared.js',
  'system-plugins/dsh-office/word.js',
  'system-plugins/dsh-office/zip.js',
  'system-plugins/dsh-open-design/index.js',
  'system-plugins/dsh-open-design/manifest.json',
  'system-plugins/dsh-plugin-manager-tools/index.js',
  'system-plugins/dsh-plugin-manager-tools/manifest.json',
  'system-plugins/dsh-shell-ish/index.js',
  'system-plugins/dsh-shell-ish/manifest.json',
  'system-plugins/dsh-shell-wasm/index.js',
  'system-plugins/dsh-shell-wasm/manifest.json',
  'system-plugins/dsh-shell-wasm/programs.js',
  'system-plugins/dsh-subprocess-quickjs/index.js',
  'system-plugins/dsh-subprocess-quickjs/manifest.json',
  'system-plugins/dsh-ui/index.js',
  'system-plugins/dsh-ui/manifest.json',
  'tar-mini.js',
  'transport-tokens.mjs',
  'workspace-registry.js',
  'upstream/boot-coverage-rows.js',
  'upstream/boot.js',
  'upstream/llm-route.js',
  'upstream/llm-transport.js',
  'upstream/llm-read-idle.js',
  'upstream/llm-retry-pacing.js',
  'upstream/model-selection-holder.js',
  'upstream/model-selection-projection.js',
  'upstream/preset-mobile-rows.js',
  'upstream/settings-memory.js',
  'upstream/shims/async-hooks.js',
  'upstream/shims/boot-tail-loopback-globals.js',
  'upstream/shims/boot-tail-url-mutators.js',
  'upstream/shims/buffer-codecs.js',
  'upstream/shims/buffer.js',
  'upstream/shims/cjs-loader.js',
  'upstream/shims/crypto.js',
  'upstream/shims/describe-each.js',
  'upstream/shims/dsh-session-persistence.js',
  'upstream/shims/events.js',
  'upstream/shims/expect-async-chain.js',
  'upstream/shims/expect-poll.js',
  'upstream/shims/fs-paths.js',
  'upstream/shims/fs-promises-fh.js',
  'upstream/shims/fs-promises.js',
  'upstream/shims/fs-readdir.js',
  'upstream/shims/fs-seam-gate.js',
  'upstream/shims/fs-seeded.js',
  'upstream/shims/fs-stat.js',
  'upstream/shims/fs-workspace-rename.js',
  'upstream/shims/fs-workspace-write.js',
  'upstream/shims/fs-workspace.js',
  'upstream/shims/fs-write-stream.js',
  'upstream/shims/fs-writes.js',
  'upstream/shims/fs.js',
  'upstream/shims/globals.js',
  'upstream/shims/loader-faces-fs-watch.js',
  'upstream/shims/node-addon-system-flock.js',
  'upstream/shims/node-child-process-exec.js',
  'upstream/shims/node-child-process.js',
  'upstream/shims/cordis-loader-failure-face.js',
  'upstream/shims/dsh-client-ui-renderer-client.js',
  'upstream/shims/node-addon-system-landlock-run.js',
  'upstream/shims/node-sqlite.js',
  'upstream/shims/openai-client.js',
  'upstream/shims/partial-json.js',
  'upstream/shims/slot-registry.js',
  'upstream/shims/source-bootstrap-loader-smoke.js',
  'upstream/shims/string-decoder.js',
  'upstream/shims/node-child-process-pump.js',
  'upstream/shims/node-child-process-tables.js',
  'upstream/shims/node-http-loopback-client.js',
  'upstream/shims/node-http-loopback-dispatch.js',
  'upstream/shims/node-http-loopback-net.js',
  'upstream/shims/node-http-loopback.js',
  'upstream/shims/node-module.js',
  'upstream/shims/node-perf-hooks.js',
  'upstream/shims/node-pty.js',
  'upstream/shims/node-socket-tcp.js',
  'upstream/shims/node-stream-duplex.js',
  'upstream/shims/node-stream-writable.js',
  'upstream/shims/node-stream.js',
  'upstream/shims/node-worker-threads.js',
  'upstream/shims/node-zlib-stream.js',
  'upstream/shims/node-zlib-xxh64.js',
  'upstream/shims/node-zlib.js',
  'upstream/shims/npm-bridges-b.js',
  'upstream/shims/npm-bridges-c.js',
  'upstream/shims/npm-bridges-c2.js',
  'upstream/shims/npm-bridges-pi-ai-all.js',
  'upstream/shims/npm-bridges-pi-ai.js',
  'upstream/shims/npm-bridges.js',
  'upstream/shims/os.js',
  'upstream/shims/path.js',
  'upstream/shims/process.js',
  'upstream/shims/runtime-modules.js',
  'upstream/shims/source-bootstrap-ipc.js',
  'upstream/shims/source-bootstrap-tsx-stage.js',
  'upstream/shims/source-bootstrap-tsx.js',
  'upstream/shims/timers-promises.js',
  'upstream/shims/timers.js',
  'upstream/shims/undici.js',
  'upstream/shims/url-file.js',
  'upstream/shims/url.js',
  'upstream/shims/util-errors.js',
  'upstream/shims/util-parse-args.js',
  'upstream/shims/util-types.js',
  'upstream/shims/util.js',
  'upstream/shims/vi-wait.js',
  'upstream/shims/web-dom-parser.js',
  'upstream/shims/web-dom.js',
  'upstream/shims/web-event.js',
  'upstream/shims/web-fetch-forms.js',
  'upstream/shims/web-fetch-values.js',
  'upstream/shims/web-multipart.js',
  'upstream/shims/web-storage.js',
  'upstream/shims/web-streams.js',
  'upstream/tool-deadline.js',
  'upstream/tool-path-anchor.js',
  'upstream/tool-present.js',
  'upstream/turn-recovery.js',
  'upstream/retry-telemetry.js',
  'upstream/turn-watchdog.js',
  'upstream/web-boot.js',
  'upstream/web-search-keyless.js',
  'upstream/web-shims.js',
  'upstream/web-write-catalog.js',
  'upstream/web-write-cordis.js',
  'upstream/web-write-coverage.js',
  'upstream/web-write-files.js',
  'upstream/web-write-inventory.js',
  'upstream/web-write-llm.js',
  'upstream/web-write-marketplace.js',
  'upstream/web-write-onboarding.js',
  'upstream/web-write-picker.js',
  'upstream/web-write-plugin-manager.js',
  'upstream/web-write-session.js',
  'upstream/web-write-presets.js',
  'upstream/boot-subagent-rows.js',
  'upstream/web-write-subagents.js',
  'upstream/web-write-settings.js',
  'upstream/web-write-streams.js',
  'upstream/web-write-workspace.js',
  'upstream/web-write.js',
  'upstream/wire-logger.js',
  'vendor/dsh/agent-instructions@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/agent-instructions@0.1.6-alpha.2/package.json',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/package.json',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/authoring.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/composition-inventory.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/discovery.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/display.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/metadata.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/mount.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/preset.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/session.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/specifier.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/package.json',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/preset.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/minimal/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/minimal/preset.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile/preset.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/preset.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/preset.yml',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/consumed-work.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/dispatch.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/model-selection.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/projection.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/runtime-types.js',
  'vendor/dsh/agent@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/agent@0.1.6-alpha.2/package.json',
  'vendor/dsh/atomic-write@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/atomic-write@0.1.6-alpha.2/package.json',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/admission.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/error.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/request-projection.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/attachment@0.1.6-alpha.2/package.json',
  'vendor/dsh/brand@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/brand@0.1.6-alpha.2/package.json',
  'vendor/dsh/chunked-list@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/chunked-list@0.1.6-alpha.2/package.json',
  'vendor/dsh/command-compact@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/command-compact@0.1.6-alpha.2/package.json',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/command-feedback@0.1.6-alpha.2/package.json',
  'vendor/dsh/command-goal@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/command-goal@0.1.6-alpha.2/package.json',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/commands@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/commands@0.1.6-alpha.2/package.json',
  'vendor/dsh/compaction-basic@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/compaction-basic@0.1.6-alpha.2/package.json',
  'vendor/dsh/compaction-tool-result-pruner@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/compaction-tool-result-pruner@0.1.6-alpha.2/package.json',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/checkpoint.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/tool-pairing.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/compaction@0.1.6-alpha.2/package.json',
  'vendor/dsh/credentials@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/credentials@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/credentials@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/credentials@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/credentials@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/credentials@0.1.6-alpha.2/package.json',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/build-approval.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/failure.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/install-failure.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/install-spec.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/operations.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/patch.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/tools.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/dsh-plugin-manager@0.1.6-alpha.2/package.json',
  'vendor/dsh/dsh-web@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/dsh-web@0.1.6-alpha.2/package.json',
  'vendor/dsh/fs-local@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/fs-local@0.1.6-alpha.2/package.json',
  'vendor/dsh/fs@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/fs@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/fs@0.1.6-alpha.2/package.json',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/domain.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/fold.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/runtime.js',
  'vendor/dsh/goal@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/goal@0.1.6-alpha.2/package.json',
  'vendor/dsh/home-paths@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/home-paths@0.1.6-alpha.2/package.json',
  'vendor/dsh/http-proxy@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/http-proxy@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/http-proxy@0.1.6-alpha.2/package.json',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/jobs@0.1.6-alpha.2/package.json',
  'vendor/dsh/jobs-local@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/jobs-local@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/jobs-local@0.1.6-alpha.2/package.json',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/adapter-failure.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/api-key.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/assembler.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/assistant-stream.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/attribution.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/call-config.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/content.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/error.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/message.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/retry-policy.js',
  'vendor/dsh/llm@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/llm@0.1.6-alpha.2/package.json',
  'vendor/dsh/output-retention@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/output-retention@0.1.6-alpha.2/package.json',
  'vendor/dsh/persona@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/persona@0.1.6-alpha.2/package.json',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/plan-mode@0.1.6-alpha.2/package.json',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/build-approval.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/failure.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/install-failure.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/install-spec.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/operations.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/patch.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/tools.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/plugin-manager@0.1.6-alpha.2/package.json',
  'vendor/dsh/sandbox@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/sandbox@0.1.6-alpha.2/package.json',
  'vendor/dsh/scope@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/scope@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/scope@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-persistence@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-persistence@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/package.json',
  'vendor/dsh/session@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/known-event-types.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/preparation.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/repair.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/request-header.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/seq-ranges.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/surface.js',
  'vendor/dsh/session@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/session@0.1.6-alpha.2/package.json',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/redact.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/settings@0.1.6-alpha.2/package.json',
  'vendor/dsh/skill-filesystem@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/skill-filesystem@0.1.6-alpha.2/package.json',
  'vendor/dsh/skill@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/skill@0.1.6-alpha.2/package.json',
  'vendor/dsh/shell-env@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/shell-env@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/shell-env@0.1.6-alpha.2/package.json',
  'vendor/dsh/shell@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/shell@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/shell@0.1.6-alpha.2/package.json',
  'vendor/dsh/subprocess@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/subprocess@0.1.6-alpha.2/lib/control.js',
  'vendor/dsh/subprocess@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/subprocess@0.1.6-alpha.2/package.json',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/assistant-output.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/catalog.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/child-agent.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/continuation-activation.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/continuation-messages.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/continuation.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/control-types.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/control.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/depth.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/descriptor.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/error.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/inbox.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/internal.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/lifecycle.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/list-children.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/out-of-process.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/projection-types.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/projection.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/run-settlement.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/subagent@0.1.6-alpha.2/package.json',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/package.json',
  'vendor/dsh/terminal@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/terminal@0.1.6-alpha.2/package.json',
  'vendor/dsh/timeout@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/timeout@0.1.6-alpha.2/package.json',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/breakdown-projection.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/estimate.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/projection.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/route-pricing.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/surface-fold.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/surface-projection.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/turn-usage.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/lib/types/usage-projection.js',
  'vendor/dsh/token-meter@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-ask-user@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-ask-user@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-bash@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-bash@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-fs@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-fs@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-goal@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-goal@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-jobs@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-jobs@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-query@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/session-title@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/session-title@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/types/normalize.js',
  'vendor/dsh/session-title@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/lib/types/current.js',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/lib/types/generated.js',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/session-format-catalog@0.1.6-alpha.2/lib/types/message-projections.js',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/package.json',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/lib/types/image-offload.js',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/lib/types/project-message.js',
  'vendor/dsh/compaction-image-offload@0.1.6-alpha.2/lib/types/projection.js',
  'vendor/dsh/session-query@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-query@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-present@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-present@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/tool-present@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/tool-present@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-pwsh@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-pwsh@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-ralph@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-ralph@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-skill@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-skill@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-str-replace-editor@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-str-replace-editor@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-subagent-control@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-subagent-control@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/tool-subagent-control@0.1.6-alpha.2/lib/types/list-agents.js',
  'vendor/dsh/tool-subagent-control@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-subagent@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-subagent@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/tool-subagent@0.1.6-alpha.2/lib/model-selection-settings.js',
  'vendor/dsh/tool-subagent@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/client.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/tool-todo@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-web@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/tool-web@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-web@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/tool-workflow@0.1.6-alpha.2/package.json',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/json-schema.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/presentation.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/ptc.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/py-types.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/schema.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/testing.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/ts-types.js',
  'vendor/dsh/tools@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/tools@0.1.6-alpha.2/package.json',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/owned-value.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/remote-error.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/package.json',
  'vendor/dsh/user-questions@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/user-questions@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/user-questions@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/user-questions@0.1.6-alpha.2/package.json',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.i18n.yaml',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.md',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.zh.md',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/package.json',
  'vendor/dsh/util-time@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/util-time@0.1.6-alpha.2/package.json',
  'vendor/dsh/util-values@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/util-values@0.1.6-alpha.2/package.json',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/types/runtime-types.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/workflow@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js',
  'vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/client.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2/lib/types/index.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2/lib/types/search.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2/lib/types/grammar.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2/lib/types/index.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2/lib/types/types.js',
  'vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/invariant.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/types/brand.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/types/history.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/types/index.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2/lib/types/types.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/invariant.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/typert.host.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/typert.remote-client.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/client.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/domain.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/fold.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/index.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/runtime.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/lib/types/types.js',
  'vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2/package.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/anthropic-messages.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/anthropic-messages.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/azure-openai-responses.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/azure-openai-responses.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/bedrock-converse-stream.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/bedrock-converse-stream.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/cloudflare-ai-binding.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/cloudflare.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/constrained-sampling.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/github-copilot-headers.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/google-generative-ai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/google-generative-ai.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/google-shared.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/google-vertex.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/google-vertex.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/mistral-conversations.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/mistral-conversations.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-codex-responses.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-codex-responses.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-completions.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-completions.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-prompt-cache.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-responses-shared.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-responses.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openai-responses.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openrouter-images.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/openrouter-images.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/pi-messages.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/pi-messages.lazy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/simple-options.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/api/transform-messages.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/context.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/credential-store.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/helpers.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/anthropic.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/device-code.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/github-copilot.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/kimi-coding.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/load.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/oauth-page.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/openai-codex.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/openrouter.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/pkce.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/radius.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/oauth/xai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/resolve.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/auth/types.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/bedrock-provider.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/bun-oauth.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/cli.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/compat.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/compat/extension-oauth-types.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/env-api-keys.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/image-models.generated.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/image-models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/images-api-registry.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/images-models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/images.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/legacy-api-aliases.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/model-catalog.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/models-store.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/models.generated.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/oauth.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/all.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/amazon-bedrock.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/amazon-bedrock.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/ant-ling.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/ant-ling.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/anthropic.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/anthropic.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/azure-openai-responses.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/azure-openai-responses.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/baseten.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/baseten.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cerebras.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cerebras.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-ai-gateway.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-ai-gateway.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-auth.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-stream.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-workers-ai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/cloudflare-workers-ai.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/amazon-bedrock.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/ant-ling.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/anthropic.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/azure-openai-responses.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/baseten.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/cerebras.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/cloudflare-ai-gateway.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/cloudflare-workers-ai.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/deepseek.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/fireworks.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/github-copilot.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/google-vertex.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/google.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/groq.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/huggingface.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/kimi-coding.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/manifest.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/minimax-cn.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/minimax.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/mistral.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/moonshotai-cn.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/moonshotai.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/nvidia.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/openai-codex.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/openai.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/opencode-go.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/opencode.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/openrouter.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/qwen-token-plan-cn.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/qwen-token-plan-individual.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/qwen-token-plan.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/together.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/vercel-ai-gateway.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/xai.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/xiaomi-token-plan-ams.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/xiaomi-token-plan-cn.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/xiaomi-token-plan-sgp.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/xiaomi.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/zai-coding-cn.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/data/zai.json',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/deepseek.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/deepseek.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/faux.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/fireworks.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/fireworks.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/github-copilot.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/github-copilot.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/google-vertex.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/google-vertex.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/google.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/google.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/groq.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/groq.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/huggingface.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/huggingface.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/images/register-builtins.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/kimi-coding.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/kimi-coding.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/minimax-cn.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/minimax-cn.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/minimax.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/minimax.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/mistral.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/mistral.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/moonshotai-cn.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/moonshotai-cn.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/moonshotai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/moonshotai.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/nvidia.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/nvidia.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openai-codex.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openai-codex.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openai.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/opencode-go.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/opencode-go.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/opencode.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/opencode.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openrouter-images.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openrouter.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/openrouter.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan-cn.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan-cn.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan-individual.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan-individual.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/qwen-token-plan.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/radius-config.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/radius.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/together.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/together.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/vercel-ai-gateway.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/vercel-ai-gateway.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xai.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-ams.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-ams.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-cn.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-cn.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-sgp.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi-token-plan-sgp.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/xiaomi.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/zai-coding-cn.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/zai-coding-cn.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/zai.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/providers/zai.models.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/session-resources.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/types.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/abort-signals.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/abort.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/assistant-message-frame.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/deferred-tools.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/diagnostics.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/error-body.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/estimate.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/event-stream.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/hash.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/headers.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/json-parse.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/node-http-proxy.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/overflow.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/pi-user-agent.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/provider-env.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/provider-retry.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/retry.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/sanitize-unicode.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/sleep.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/text.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/typebox-helpers.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/uuid.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/utils/validation.js',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/package.json',
  'vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib/turndown-plugin-gfm.cjs.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/CSSStyleDeclaration.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/CharacterData.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/ChildNode.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Comment.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/ContainerNode.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/CustomEvent.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/DOMException.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/DOMImplementation.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/DOMTokenList.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Document.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/DocumentFragment.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/DocumentType.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Element.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Event.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/EventTarget.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/FilteredElementList.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/HTMLParser.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Leaf.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/LinkedList.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Location.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/MouseEvent.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/MutationConstants.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NamedNodeMap.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NavigatorID.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Node.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeFilter.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeIterator.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeList.es5.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeList.es6.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeList.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeTraversal.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NodeUtils.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/NonDocumentTypeChildNode.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/ProcessingInstruction.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Text.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/TreeWalker.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/UIEvent.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/URL.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/URLUtils.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/Window.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/WindowTimers.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/attributes.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/config.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/defineElement.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/events.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/htmlelts.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/impl.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/index.d.ts',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/index.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/select.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/style_parser.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/svg.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/utils.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/lib/xmlnames.js',
  'vendor/npm/@mixmark-io/domino@2.2.0/package.json',
  'vendor/npm/@noble/hashes@2.3.0/_blake.js',
  'vendor/npm/@noble/hashes@2.3.0/_md.js',
  'vendor/npm/@noble/hashes@2.3.0/_u64.js',
  'vendor/npm/@noble/hashes@2.3.0/argon2.js',
  'vendor/npm/@noble/hashes@2.3.0/blake1.js',
  'vendor/npm/@noble/hashes@2.3.0/blake2.js',
  'vendor/npm/@noble/hashes@2.3.0/blake3.js',
  'vendor/npm/@noble/hashes@2.3.0/eskdf.js',
  'vendor/npm/@noble/hashes@2.3.0/hkdf.js',
  'vendor/npm/@noble/hashes@2.3.0/hmac.js',
  'vendor/npm/@noble/hashes@2.3.0/index.js',
  'vendor/npm/@noble/hashes@2.3.0/legacy.js',
  'vendor/npm/@noble/hashes@2.3.0/pbkdf2.js',
  'vendor/npm/@noble/hashes@2.3.0/scrypt.js',
  'vendor/npm/@noble/hashes@2.3.0/sha2.js',
  'vendor/npm/@noble/hashes@2.3.0/sha3-addons.js',
  'vendor/npm/@noble/hashes@2.3.0/sha3.js',
  'vendor/npm/@noble/hashes@2.3.0/utils.js',
  'vendor/npm/@noble/hashes@2.3.0/webcrypto.js',
  'vendor/npm/cordis@4.0.2/lib/index.js',
  'vendor/npm/cordis@4.0.2/package.json',
  'vendor/npm/cosmokit@1.8.3/lib/index.js',
  'vendor/npm/cosmokit@1.8.3/package.json',
  'vendor/npm/diff@9.0.0/libesm/convert/dmp.js',
  'vendor/npm/diff@9.0.0/libesm/convert/xml.js',
  'vendor/npm/diff@9.0.0/libesm/diff/array.js',
  'vendor/npm/diff@9.0.0/libesm/diff/base.js',
  'vendor/npm/diff@9.0.0/libesm/diff/character.js',
  'vendor/npm/diff@9.0.0/libesm/diff/css.js',
  'vendor/npm/diff@9.0.0/libesm/diff/json.js',
  'vendor/npm/diff@9.0.0/libesm/diff/line.js',
  'vendor/npm/diff@9.0.0/libesm/diff/sentence.js',
  'vendor/npm/diff@9.0.0/libesm/diff/word.js',
  'vendor/npm/diff@9.0.0/libesm/index.js',
  'vendor/npm/diff@9.0.0/libesm/package.json',
  'vendor/npm/diff@9.0.0/libesm/patch/apply.js',
  'vendor/npm/diff@9.0.0/libesm/patch/create.js',
  'vendor/npm/diff@9.0.0/libesm/patch/line-endings.js',
  'vendor/npm/diff@9.0.0/libesm/patch/parse.js',
  'vendor/npm/diff@9.0.0/libesm/patch/reverse.js',
  'vendor/npm/diff@9.0.0/libesm/types.js',
  'vendor/npm/diff@9.0.0/libesm/util/array.js',
  'vendor/npm/diff@9.0.0/libesm/util/distance-iterator.js',
  'vendor/npm/diff@9.0.0/libesm/util/params.js',
  'vendor/npm/diff@9.0.0/libesm/util/string.js',
  'vendor/npm/fflate@0.8.2/esm/browser.js',
  'vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs',
  'vendor/npm/schemastery@3.18.2/lib/index.mjs',
  'vendor/npm/schemastery@3.18.2/package.json',
  'vendor/npm/turndown@7.2.4/lib/turndown.es.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/compose-collection.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/compose-doc.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/compose-node.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/compose-scalar.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/composer.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-map.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-scalar.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-block-seq.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-end.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-flow-collection.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-flow-scalar.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/resolve-props.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/util-contains-newline.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/util-empty-scalar-position.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/util-flow-indent-check.js',
  'vendor/npm/yaml@2.9.0/browser/dist/compose/util-map-includes.js',
  'vendor/npm/yaml@2.9.0/browser/dist/doc/Document.js',
  'vendor/npm/yaml@2.9.0/browser/dist/doc/anchors.js',
  'vendor/npm/yaml@2.9.0/browser/dist/doc/applyReviver.js',
  'vendor/npm/yaml@2.9.0/browser/dist/doc/createNode.js',
  'vendor/npm/yaml@2.9.0/browser/dist/doc/directives.js',
  'vendor/npm/yaml@2.9.0/browser/dist/errors.js',
  'vendor/npm/yaml@2.9.0/browser/dist/index.js',
  'vendor/npm/yaml@2.9.0/browser/dist/log.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/Alias.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/Collection.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/Node.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/Pair.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/Scalar.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/YAMLMap.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/YAMLSeq.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/addPairToJSMap.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/identity.js',
  'vendor/npm/yaml@2.9.0/browser/dist/nodes/toJS.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/cst-scalar.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/cst-stringify.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/cst-visit.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/cst.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/lexer.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/line-counter.js',
  'vendor/npm/yaml@2.9.0/browser/dist/parse/parser.js',
  'vendor/npm/yaml@2.9.0/browser/dist/public-api.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/Schema.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/common/map.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/common/null.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/common/seq.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/common/string.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/core/bool.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/core/float.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/core/int.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/core/schema.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/json/schema.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/tags.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/binary.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/bool.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/float.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/int.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/merge.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/omap.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/pairs.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/schema.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/set.js',
  'vendor/npm/yaml@2.9.0/browser/dist/schema/yaml-1.1/timestamp.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/foldFlowLines.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringify.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyCollection.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyComment.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyDocument.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyNumber.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyPair.js',
  'vendor/npm/yaml@2.9.0/browser/dist/stringify/stringifyString.js',
  'vendor/npm/yaml@2.9.0/browser/dist/util.js',
  'vendor/npm/yaml@2.9.0/browser/dist/visit.js',
  'vendor/npm/yaml@2.9.0/browser/index.js',
  'vendor/npm/yaml@2.9.0/browser/package.json',
  'vendor/npm/zod@4.4.3/index.js',
  'vendor/npm/zod@4.4.3/v4/classic/checks.js',
  'vendor/npm/zod@4.4.3/v4/classic/coerce.js',
  'vendor/npm/zod@4.4.3/v4/classic/compat.js',
  'vendor/npm/zod@4.4.3/v4/classic/errors.js',
  'vendor/npm/zod@4.4.3/v4/classic/external.js',
  'vendor/npm/zod@4.4.3/v4/classic/from-json-schema.js',
  'vendor/npm/zod@4.4.3/v4/classic/iso.js',
  'vendor/npm/zod@4.4.3/v4/classic/parse.js',
  'vendor/npm/zod@4.4.3/v4/classic/schemas.js',
  'vendor/npm/zod@4.4.3/v4/core/api.js',
  'vendor/npm/zod@4.4.3/v4/core/checks.js',
  'vendor/npm/zod@4.4.3/v4/core/core.js',
  'vendor/npm/zod@4.4.3/v4/core/doc.js',
  'vendor/npm/zod@4.4.3/v4/core/errors.js',
  'vendor/npm/zod@4.4.3/v4/core/index.js',
  'vendor/npm/zod@4.4.3/v4/core/json-schema-generator.js',
  'vendor/npm/zod@4.4.3/v4/core/json-schema-processors.js',
  'vendor/npm/zod@4.4.3/v4/core/json-schema.js',
  'vendor/npm/zod@4.4.3/v4/core/parse.js',
  'vendor/npm/zod@4.4.3/v4/core/regexes.js',
  'vendor/npm/zod@4.4.3/v4/core/registries.js',
  'vendor/npm/zod@4.4.3/v4/core/schemas.js',
  'vendor/npm/zod@4.4.3/v4/core/to-json-schema.js',
  'vendor/npm/zod@4.4.3/v4/core/util.js',
  'vendor/npm/zod@4.4.3/v4/core/versions.js',
  'vendor/npm/zod@4.4.3/v4/locales/ar.js',
  'vendor/npm/zod@4.4.3/v4/locales/az.js',
  'vendor/npm/zod@4.4.3/v4/locales/be.js',
  'vendor/npm/zod@4.4.3/v4/locales/bg.js',
  'vendor/npm/zod@4.4.3/v4/locales/ca.js',
  'vendor/npm/zod@4.4.3/v4/locales/cs.js',
  'vendor/npm/zod@4.4.3/v4/locales/da.js',
  'vendor/npm/zod@4.4.3/v4/locales/de.js',
  'vendor/npm/zod@4.4.3/v4/locales/el.js',
  'vendor/npm/zod@4.4.3/v4/locales/en.js',
  'vendor/npm/zod@4.4.3/v4/locales/eo.js',
  'vendor/npm/zod@4.4.3/v4/locales/es.js',
  'vendor/npm/zod@4.4.3/v4/locales/fa.js',
  'vendor/npm/zod@4.4.3/v4/locales/fi.js',
  'vendor/npm/zod@4.4.3/v4/locales/fr-CA.js',
  'vendor/npm/zod@4.4.3/v4/locales/fr.js',
  'vendor/npm/zod@4.4.3/v4/locales/he.js',
  'vendor/npm/zod@4.4.3/v4/locales/hr.js',
  'vendor/npm/zod@4.4.3/v4/locales/hu.js',
  'vendor/npm/zod@4.4.3/v4/locales/hy.js',
  'vendor/npm/zod@4.4.3/v4/locales/id.js',
  'vendor/npm/zod@4.4.3/v4/locales/index.js',
  'vendor/npm/zod@4.4.3/v4/locales/is.js',
  'vendor/npm/zod@4.4.3/v4/locales/it.js',
  'vendor/npm/zod@4.4.3/v4/locales/ja.js',
  'vendor/npm/zod@4.4.3/v4/locales/ka.js',
  'vendor/npm/zod@4.4.3/v4/locales/kh.js',
  'vendor/npm/zod@4.4.3/v4/locales/km.js',
  'vendor/npm/zod@4.4.3/v4/locales/ko.js',
  'vendor/npm/zod@4.4.3/v4/locales/lt.js',
  'vendor/npm/zod@4.4.3/v4/locales/mk.js',
  'vendor/npm/zod@4.4.3/v4/locales/ms.js',
  'vendor/npm/zod@4.4.3/v4/locales/nl.js',
  'vendor/npm/zod@4.4.3/v4/locales/no.js',
  'vendor/npm/zod@4.4.3/v4/locales/ota.js',
  'vendor/npm/zod@4.4.3/v4/locales/pl.js',
  'vendor/npm/zod@4.4.3/v4/locales/ps.js',
  'vendor/npm/zod@4.4.3/v4/locales/pt.js',
  'vendor/npm/zod@4.4.3/v4/locales/ro.js',
  'vendor/npm/zod@4.4.3/v4/locales/ru.js',
  'vendor/npm/zod@4.4.3/v4/locales/sl.js',
  'vendor/npm/zod@4.4.3/v4/locales/sv.js',
  'vendor/npm/zod@4.4.3/v4/locales/ta.js',
  'vendor/npm/zod@4.4.3/v4/locales/th.js',
  'vendor/npm/zod@4.4.3/v4/locales/tr.js',
  'vendor/npm/zod@4.4.3/v4/locales/ua.js',
  'vendor/npm/zod@4.4.3/v4/locales/uk.js',
  'vendor/npm/zod@4.4.3/v4/locales/ur.js',
  'vendor/npm/zod@4.4.3/v4/locales/uz.js',
  'vendor/npm/zod@4.4.3/v4/locales/vi.js',
  'vendor/npm/zod@4.4.3/v4/locales/yo.js',
  'vendor/npm/zod@4.4.3/v4/locales/zh-CN.js',
  'vendor/npm/zod@4.4.3/v4/locales/zh-TW.js',
  'web-live/api-handler-respond.js',
  'web-live/boot-options.js',
  'web-live/pomodoro-plugin-template.js',
  'web-live/plugin-live-mount.js',
  'web-live/composer-bus.js',
  'web-live/composer-web-live.js',
  'web-live/harmony-composer-live-write.js',
  'web-live/harmony-httpfetch-streaming.js',
  'web-live/harmony-session-live-read.js',
  'web-live/manager-legs-probe.js',
  'web-live/officialweb-web-live.js',
  'web-live/probe-respond-await.js',
  'web-live/scenario-verdict.js',
  'web-live/turn-failure.js',
  'web-live/write-surface-options.js',
  'webclient/dsh-web-client-v2/manifest.json',
  'webclient/dsh-web-client-v2/web/css/app.css',
  'webclient/dsh-web-client-v2/web/css/theme.css',
  'webclient/dsh-web-client-v2/web/index.html',
  'webclient/dsh-web-client-v2/web/js/api.js',
  'webclient/dsh-web-client-v2/web/js/composer.js',
  'webclient/dsh-web-client-v2/web/js/main.js',
  'webclient/dsh-web-client-v2/web/js/markdown.js',
  'webclient/dsh-web-client-v2/web/js/marketplace-core.js',
  'webclient/dsh-web-client-v2/web/js/marketplace.js',
  'webclient/dsh-web-client-v2/web/js/mux.js',
  'webclient/dsh-web-client-v2/web/js/onboarding-core.js',
  'webclient/dsh-web-client-v2/web/js/onboarding.js',
  'webclient/dsh-web-client-v2/web/js/render-chat.js',
  'webclient/dsh-web-client-v2/web/js/render-home.js',
  'webclient/dsh-web-client-v2/web/js/timeline.js',
  'webclient/dsh-web-client-compact/manifest.json',
  'webclient/dsh-web-client-compact/web/index.html',
  'webclient/dsh-web-client-compact/web/main.js',
  'webclient/dsh-web-client-compact/web/compact.css',
  'webclient/dsh-web-client/manifest.json',
  'webclient/dsh-web-client/web/index.html',
  'webclient/dsh-web-client/web/main.js',

];

// Custom approval dialog — presentApproval's native surface (contract §4:
// approval while pending may checkpoint; the E2E driver taps Approve).
@CustomDialog
struct ApprovalDialog {
  controller: CustomDialogController;
  title: string = 'Approval';
  onPick: (approved: boolean) => void = (approved: boolean): void => {};

  build() {
    Column({ space: 12 }) {
      Text(this.title).fontSize(18).fontWeight(FontWeight.Bold)
      Text('The scenario requests your approval.').fontSize(14)
      Row({ space: 12 }) {
        Button('Decline').onClick((): void => {
          this.onPick(false);
          this.controller.close();
        })
        Button('Approve').onClick((): void => {
          this.onPick(true);
          this.controller.close();
        })
      }
    }
    .padding(20)
  }
}

@Entry
@Component
struct Index {
  @State verdict: string = 'rt: running...';
  @State webUrl: string = '';
  private realCreatePort: number = CARRIER_BASE_PORT;
  @State approvalTitle: string = '';
  // The render surface overlay (contract v1.10.0): one fullscreen Canvas
  // above the seat, driven by the presenter registered into whichever
  // phase is live (HostPhase for the drives, OfficialServe for the
  // interactive/release seat).
  @State @Watch('onSurfaceOps') surfaceOpsJson: string = '[]';
  @State surfaceVisible: boolean = false;
  @State surfaceTitle: string = '';
  private surfaceDimsSink: ((dims: SurfaceDims | null) => void) | null = null;
  private surfaceInput: (kind: string, x: number, y: number) => void =
    (kind: string, x: number, y: number): void => {};
  private surfaceCtx: CanvasRenderingContext2D =
    new CanvasRenderingContext2D(new RenderingContextSettings(true));
  /** The live OfficialServe instance: the release seat Index constructed,
   * else the official drive phase's (whichever serves now). */
  private liveServe(): OfficialServe | null {
    if (this.releaseServe !== null) {
      return this.releaseServe;
    }
    return OfficialPhase.getInstance().getServe();
  }

  private surfaceOpen(title: string,
    onResult: (dims: SurfaceDims | null) => void): void {
    this.surfaceTitle = title;
    this.surfaceDimsSink = onResult;
    this.surfaceOpsJson = '[]';
    this.surfaceVisible = true;
  }

  private surfaceSubmit(frame: SurfaceFrame): void {
    this.surfaceOpsJson = frame.ops;
  }

  private surfaceClose(): void {
    this.surfaceVisible = false;
    this.surfaceDimsSink = null;
  }
  private approvalResolve: ((approved: boolean) => void) | null = null;
  private approvalController: CustomDialogController | null = null;
  private carrier: CarrierServer = new CarrierServer();
  private webController: webview.WebviewController = new webview.WebviewController();
  /** The release boot's serving seat (null in the harness: OfficialPhase
   * owns the seat there). */
  private releaseServe: OfficialServe | null = null;

  aboutToAppear(): void {
    // The render surface overlay + the official seat's approval dialog are
    // registered BEFORE any leg picks a phase: whichever phase goes live
    // (HostPhase for the drives, OfficialServe for the interactive seat)
    // finds its presenter in place (contract v1.10.0).
    HostPhase.getInstance().setSurfaceView(
      (title: string, onResult: (dims: SurfaceDims | null) => void): void => {
        this.surfaceOpen(title, onResult);
      },
      (frame: SurfaceFrame): void => {
        this.surfaceSubmit(frame);
      },
      (): void => {
        this.surfaceClose();
      });
    OfficialServe.setSurfaceView(
      (title: string, onResult: (dims: SurfaceDims | null) => void): void => {
        this.surfaceOpen(title, onResult);
      },
      (frame: SurfaceFrame): void => {
        this.surfaceSubmit(frame);
      },
      (): void => {
        this.surfaceClose();
      });
    OfficialServe.setApprovalPresenter(
      (title: string, resolve: (approved: boolean) => void): void => {
        this.showApproval(title, resolve);
      });
    this.surfaceInput = (kind: string, x: number, y: number): void => {
      HostPhase.getInstance().onSurfaceTouch(kind, x, y);
      const serve = this.liveServe();
      if (serve !== null) {
        serve.onSurfaceTouch(kind, x, y);
      }
    };
    // The launch parameter picks the leg (E2eLeg, set by EntryAbility.onCreate
    // from `--ps dsh.e2e.leg`); absent = the default chain. An unknown value
    // fails loud instead of silently running the default chain (rule 5).
    const leg: string = E2eLeg.get();
    if (BuildFlavor.isRelease()) {
      // The user-facing build SERVES the official Web UI — the same serving
      // seat the harness's D9 phase runs, with no drive attached (the E2E
      // machinery and the per-event log stream are compiled out: AGENTS.md
      // constraint 5, rules.md rule L4). A launch that asks for a leg must
      // refuse LOUD by name (rule 5): a user-facing binary has no drives, and
      // a silent default chain would look like a pass.
      if (leg !== '') {
        const detail = 'dsh.e2e.leg ' + leg + ' asks for a verification drive; a '
          + 'user-facing build runs none — use the harness variant '
          + '(dsh-harmony-harness) to drive E2E legs';
        this.verdict = 'DSH release build: refused — ' + detail;
        hilog.error(0x0000, TAG, 'release build: refusing: %{public}s', detail);
        return;
      }
      // The user-facing page carries NO verdict: the panel above (and the
      // initial "rt: running..." placeholder, which the harness shows
      // while the trio runs) belongs to the verification UI.
      this.verdict = '';
      this.startReleaseServe();
      return;
    }
    if (leg === '') {
      this.runSpike();
    } else if (leg === LEG_LLM) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runLlmLeg();
    } else if (leg === LEG_WHALE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runWhaleLeg();
    } else if (leg === LEG_V2WEB) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runV2WebLeg();
    } else if (leg === LEG_DEVICE_PLANE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runDevicePlaneLeg();
    } else if (leg === LEG_CAMERA_PLANE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runCameraPlaneLeg();
    } else if (leg === LEG_PARITY) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runParityLeg();
    } else if (leg === LEG_BLE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runBleLeg();
    } else if (leg === LEG_MIC_PLANE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runMicPlaneLeg();
    } else if (leg === LEG_REAL_AGENT) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runRealAgentLeg();
    } else if (leg === LEG_REAL_CREATE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch', leg);
      this.runRealCreateLeg();
    } else if (leg === LEG_UPSTREAM_SUITE) {
      hilog.info(0x0000, TAG, 'leg %{public}s selected at launch, spec %{public}s', leg, E2eLeg.getSpec());
      this.runSuiteLeg(E2eLeg.getSpec());
    } else {
      this.verdict = 'FAIL (unknown dsh.e2e.leg: ' + leg + ')';
      hilog.error(0x0000, TAG, 'unknown dsh.e2e.leg: %{public}s', leg);
    }
  }

  aboutToDisappear(): void {
    if (BuildFlavor.isRelease()) {
      if (this.releaseServe !== null) {
        this.releaseServe.destroy();
      }
      return;
    }
    HostPhase.getInstance().destroy();
    OfficialPhase.getInstance().destroy();
    V2WebPhase.destroyIfLive();
    this.carrier.stop();
  }

  /** The user-facing boot (release only): materialize the bundled web-boot
   * closure, then run the serving seat — INTERACTIVE (the full vendored DSH
   * spine: the commands registry + the skill plane mount, the write surface
   * and the mux streams are claimed, and the page's own composer admits real
   * upstream agent-loop turns; the model route is the staged credential file
   * when present, else the carrier's scripted endpoint). No leg, no probe,
   * no record: the serving seat's evidence hooks are left at their no-op
   * defaults. */
  private startReleaseServe(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const serve = new OfficialServe();
    this.releaseServe = serve;
    serve.onOrigin = (url: string): void => {
      // The official origin becomes the Web's initial src (nothing is
      // mounted yet, so this is exactly one navigation).
      this.webUrl = url;
    };
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const credential: string | null = OfficialServe.loadCredential(ctx);
    // The served client: the launch selection (`--ps dsh.web.client <id>`)
    // maps to its staged web dir; the default serves the official dist.
    // An UNKNOWN id fails loud (rule 5) — a mistyped selection must never
    // silently fall back to the official page.
    const selected: string = E2eLeg.getWebClient();
    let distRoot: string = 'officialweb/www';
    if (selected === 'dsh-web-client-v2') {
      distRoot = NEXT_CLIENT_ROOT;
    } else if (selected !== '') {
      this.verdict = 'FAIL (unknown dsh.web.client: ' + selected + ')';
      hilog.error(0x0000, TAG, 'unknown dsh.web.client: %{public}s', selected);
      return;
    }
    this.materializeBundle(ctx)
      .then((root: string): void => {
        serve.beginInteractive(ctx, root, ctx.cacheDir + '/dsh-official-serve.log',
          fsRoot, credential, distRoot);
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'release serve failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  private copyRawFile(ctx: common.Context, rel: string, dst: string): Promise<void> {
    // getRawFileContent is documented to throw for a missing/renamed rawfile
    // in addition to rejecting; the throw is turned into the SAME rejected
    // promise the materialization chain already reports by name, so a
    // mismatched bundle manifest fails the boot with the file that is absent
    // rather than escaping the promise chain.
    let content: Promise<Uint8Array>;
    try {
      content = ctx.resourceManager.getRawFileContent('dsh/' + rel);
    } catch (e) {
      const be = e as BusinessError;
      return Promise.reject(new Error(
        `copyRawFile ${rel}: rawfile read refused (${be.message ?? 'unknown'})`));
    }
    return content.then((data: Uint8Array) => {
      try {
        const dir: string = dst.substring(0, dst.lastIndexOf('/'));
        if (!fs.accessSync(dir)) {
          fs.mkdirSync(dir, true);
        }
        const file = fs.openSync(dst, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        fs.writeSync(file.fd, data.buffer as object as ArrayBuffer);
        fs.closeSync(file.fd);
      } catch (e) {
        throw new Error(`copyRawFile ${rel}: ${(e as BusinessError).message ?? 'unknown'}`);
      }
    });
  }

  private materializeBundle(ctx: common.Context): Promise<string> {
    const root: string = ctx.cacheDir + '/rt';
    const jobs: Promise<void>[] =
      BUNDLE_FILES.map((rel: string): Promise<void> => this.copyRawFile(ctx, rel, root + '/' + rel));
    return Promise.all(jobs).then((): string => root);
  }

  /** The suite leg's EXTRA materialization: the transpiled corpus and the
   * staged test closure ride the rawfile of the --suite-extras HAP but NOT
   * BUNDLE_FILES (generated per tag, never tracked). The extras stager
   * writes ONE fixed-name manifest — upstream-tests/__files.txt, one
   * bundle-relative path per line — and this copies each listed file beside
   * the pinned bundle through the same copyRawFile. A manifest that refuses
   * to read means a standard HAP: nothing extra to serve (the driver fails
   * loud naming the spec, which is the honest verdict for that build). */
  private materializeSuiteExtras(ctx: common.Context, root: string): Promise<void> {
    const manifestRel = 'upstream-tests/__files.txt';
    let content: Promise<Uint8Array>;
    try {
      content = ctx.resourceManager.getRawFileContent('dsh/' + manifestRel);
    } catch (e) {
      const be = e as BusinessError;
      hilog.warn(0x0000, TAG, 'suite extras: no manifest (%{public}s)', be.message ?? '');
      return Promise.resolve();
    }
    return content.then((data: Uint8Array): Promise<void> => {
      // Chunked decode: a manifest of thousands of paths exceeds the
      // spread-argument limit.
      let text = '';
      const CHUNK = 4096;
      for (let i = 0; i < data.length; i += CHUNK) {
        text += String.fromCharCode(...data.slice(i, i + CHUNK));
      }
      const jobs: Promise<void>[] = [];
      for (const rel of text.split('\n')) {
        const line = rel.trim();
        if (line === '' || line === 'upstream-tests/__files.txt') {
          continue;
        }
        jobs.push(this.copyRawFile(ctx, line, root + '/' + line));
      }
      hilog.info(0x0000, TAG, 'suite extras: %{public}d file(s)', jobs.length);
      return Promise.all(jobs).then((): void => {});
    });
  }

  private runSpike(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const capturePath: string = ctx.cacheDir + '/dsh-rt-capture.log';
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    this.materializeBundle(ctx)
      .then((root: string): string => startSpike(root, capturePath, fsRoot))
      .then((summary: string) => {
        this.verdict = summary;
        hilog.info(0x0000, TAG, 'rt verdict: %{public}s', summary);
        this.startBindingPhase(ctx, fsRoot);
      })
      .catch((err: BusinessError) => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'rt failed: %{public}s', err.message ?? 'unknown');
      });
  }

  /** The `real.agent.loop` leg (windows-test-plan T4/T5; ci/run-real-agent.sh):
   * the llm leg's credential choreography VERBATIM (same staged path, the
   * runtime's others-writable placeholder, the send over it, the import),
   * but headless — no page mounts, no carrier records; the scenario boots
   * the spine with tools on the staged REAL backend and runs the five probe
   * turns itself. The verdict is the scenario's own. */
  private runRealAgentLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const configPath: string = fsRoot + '/llm-live-stream/config.json';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' real.agent.loop (logs are the verdict)';
      LlmConfigStaging.cleanup(configPath);
    };
    this.materializeBundle(ctx)
      .then((bundleRoot: string): Promise<number> => {
        this.verdict = 'real-agent leg: staging credentials...';
        LlmConfigStaging.prepare(configPath);
        phase.beginRealAgent(ctx, bundleRoot, ctx.cacheDir + '/dsh-real-agent-capture.log', fsRoot);
        return LlmConfigStaging.awaitStaged(configPath);
      })
      .then((stagedBytes: number): void => {
        hilog.info(0x0000, TAG, 'real-agent leg: credentials staged (%{public}d bytes) — the probes are running',
          stagedBytes);
        this.verdict = 'real-agent leg: probes running';
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'real-agent leg failed: %{public}s',
          err.message ?? 'unknown');
        LlmConfigStaging.cleanup(configPath);
      });
  }

  /** The `real.create` leg (CREATE-mode live demo; ci/run-real-create.sh):
   * the compact leg's carrier + page shuttle + the llm leg's credential
   * choreography — the compact creation client mounts and ONE REAL turn
   * creates the Pomodoro clock, streamed into the page. Demo: no manifest;
   * the runner waits for the summary marker and screenshots. */
  private runRealCreateLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const configPath: string = fsRoot + '/llm-live-stream/config.json';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' real.create (demo leg)';
      LlmConfigStaging.cleanup(configPath);
      // The demo's final face: navigate the mounted web view to the card
      // player — the CREATED plugin renders and RUNS in the browser.
      if (passed) {
        this.webUrl = 'http://127.0.0.1:' + this.realCreatePort
          + '/card-player?plugin=real-create/pomodoro-clock';
      }
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'real-create leg: staging credentials...';
        // The container root rides a FILE, not the bus: the scenario reads it
        // through fs scope app with no delivery race (the bus delivery proved
        // racy against the runtime's boot on this leg).
        const rootDir: string = fsRoot + '/real-create';
        if (!fs.accessSync(rootDir)) {
          fs.mkdirSync(rootDir, true);
        }
        const rootFile: string = rootDir + '/root.json';
        const file = fs.openSync(rootFile, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        fs.writeSync(file.fd, '{"containerRoot":' + JSON.stringify(rootDir) + '}');
        fs.closeSync(file.fd);
        LlmConfigStaging.prepare(configPath);
        phase.beginRealCreate(ctx, root, ctx.cacheDir + '/dsh-real-create-capture.log', fsRoot);
        installLegacyRoutes(this.carrier, root + WHALE_WEB_DIR);
        installE2EStreams(this.carrier);
        return LlmConfigStaging.awaitStaged(configPath);
      })
      .then((stagedBytes: number): Promise<number> => {
        hilog.info(0x0000, TAG, 'real-create leg: credentials staged (%{public}d bytes)',
          stagedBytes);
        new CardPlayerRoute(this.carrier, fsRoot).register();
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          this.webUrl = 'http://127.0.0.1:' + port + '/';
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'real-create leg: creation turn running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'real-create leg failed: %{public}s',
          err.message ?? 'unknown');
        LlmConfigStaging.cleanup(configPath);
      });
  }

  /** The `llm.live-stream` leg (ONE launch; ci/run-live-llm.sh): the phase runtime
   * starts FIRST and evals the staging module, whose C-side app-scope
   * fsWrite creates the credential placeholder at the mode the hdc shell
   * user can open (see LlmConfigStaging's header — the sandbox refuses every
   * other path). Then the SAME carrier + HostPhase wiring the binding phase
   * uses, with the canonical llm-live-stream scenario as the entry. No user-store
   * seeding and no D9 chain: this leg is the whole run, so the default chain
   * never spends serve quota. The verdict is the C `dsh.runtime.verdict:
   * llm.live-stream` line, asserted record by record by the E2E checkers. */
  /** The upstream-suite leg: materialize the bundle (the --suite-extras
   * staged corpus + test closure ride the same copy), then hand the driver
   * the spec selection. */
  private runSuiteLeg(spec: string): void {
    if (spec === '') {
      this.verdict = 'FAIL (upstream.suite leg without dsh.e2e.spec)';
      hilog.error(0x0000, TAG, 'suite leg: no dsh.e2e.spec parameter');
      return;
    }
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' upstream.suite (per-test verdicts in the capture)';
    };
    this.materializeBundle(ctx)
      .then((bundleRoot: string): Promise<string> => {
        this.verdict = 'suite leg: materializing the corpus...';
        return this.materializeSuiteExtras(ctx, bundleRoot).then((): string => bundleRoot);
      })
      .then((bundleRoot: string): void => {
        this.verdict = 'suite leg: running ' + spec + '...';
        phase.beginSuite(ctx, bundleRoot, ctx.cacheDir + '/dsh-suite-capture.log', fsRoot, spec);
      })
      .catch((err: Error): void => {
        this.verdict = 'FAIL (suite leg bundle materialization: ' + err.message + ')';
        hilog.error(0x0000, TAG, 'suite leg materialize failed: %{public}s', err.message);
      });
  }

  private runLlmLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const configPath: string = fsRoot + '/llm-live-stream/config.json';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' llm.live-stream (logs are the verdict)';
      // One run is the credentials' whole on-disk life (see LlmConfigStaging
      // cleanup): removed on both the pass and the fail path.
      LlmConfigStaging.cleanup(configPath);
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    let root: string = '';
    this.materializeBundle(ctx)
      .then((bundleRoot: string): Promise<number> => {
        root = bundleRoot;
        this.verdict = 'llm leg: staging credentials...';
        LlmConfigStaging.prepare(configPath);
        phase.beginLlm(ctx, root, ctx.cacheDir + '/dsh-llm-live-stream-capture.log', fsRoot);
        return LlmConfigStaging.awaitStaged(configPath);
      })
      .then((stagedBytes: number): Promise<number> => {
        hilog.info(0x0000, TAG, 'llm leg: credentials staged (%{public}d bytes)',
          stagedBytes);
        installLegacyRoutes(this.carrier, root + '/webclient/dsh-web-client/web');
        installE2EStreams(this.carrier);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          this.webUrl = 'http://127.0.0.1:' + port + '/';
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'llm leg: running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'llm leg failed: %{public}s',
          err.message ?? 'unknown');
        LlmConfigStaging.cleanup(configPath);
      });
  }

  /** The compact creation-client mount leg (`harmony.compact.mount`, the iOS
   * session-mock-llm drive's --client compact leg mirrored): the llm leg's
   * carrier + page shuttle + dispatch wiring, but the session-mock scenario
   * (deterministic scripted turns — no credentials, no quota) and the staged
   * compact page as the carrier web root. */
  private runWhaleLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' harmony.compact.mount (logs are the verdict)';
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'compact leg: running the session-mock mount...';
        phase.beginWhale(ctx, root, ctx.cacheDir + '/dsh-compact-mount-capture.log', fsRoot);
        installLegacyRoutes(this.carrier, root + WHALE_WEB_DIR);
        installE2EStreams(this.carrier);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          this.webUrl = 'http://127.0.0.1:' + port + '/';
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'compact leg: running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'compact leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** The v2web.mount drive (`harmony.v2web.mount`): the SELF-HOSTED web
   * client on the OfficialServe seat the release boot runs — dist root
   * swapped, zero injection rows, the interactive config with the CREATION
   * row; the probe drives OUR page like a user through real scripted turns
   * (V2WebPhase holds the chain). */
  private runV2WebLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = V2WebPhase.getInstance();
    phase.openOrigin = (url: string): void => {
      // The fresh-Web remount trick (startOfficialPhase's): exactly one
      // navigation onto the next client's origin.
      this.webUrl = '';
      setTimeout((): void => {
        this.webUrl = url;
      }, 50);
    };
    this.materializeBundle(ctx)
      .then((root: string): void => {
        this.verdict = 'v2web leg: serving the self-hosted client...';
        phase.begin(ctx, root, ctx.cacheDir + '/dsh-v2web-capture.log', fsRoot);
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'v2web leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** The device.plane leg (`harmony.device-plane`, ONE launch): the binding
   * phase's carrier + HostPhase machinery with the device-plane scenario as
   * the entry — no web client mounts (the scenario drives primitives only),
   * and the page's approval dialog serves clipboardRead's gate. The verdict
   * is the C `dsh.runtime.verdict: harmony.device-plane` line. */
  /** The capability plane's microphone leg (v1.10.0 candidate): the
   * device-plane leg's shape — micStart/micStop + the mic.frame channel,
   * no web client mounts. The OS microphone prompt is driven by the
   * runner's drive script (the uitest allow-button tap; a pre-granted
   * install has no dialog). */
  private runMicPlaneLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' harmony.mic-plane (logs are the verdict)';
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'mic-plane leg: running...';
        phase.beginMicPlane(ctx, root, ctx.cacheDir + '/dsh-mic-plane-capture.log', fsRoot);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          phase.evalEntryDirect();
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'mic-plane leg: running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'mic-plane leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  private runDevicePlaneLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' harmony.device-plane (logs are the verdict)';
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'device-plane leg: running...';
        phase.beginDevicePlane(ctx, root, ctx.cacheDir + '/dsh-device-plane-capture.log', fsRoot);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          phase.evalEntryDirect();
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'device-plane leg: running on 127.0.0.1:' + port;
      })
    .catch((err: BusinessError): void => {
      this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
      hilog.error(0x0000, TAG, 'device-plane leg failed: %{public}s',
        err.message ?? 'unknown');
    });
  }

  /** The upstream-parity leg (`upstream.parity`, ONE launch; ci/
   * run-device-parity.sh): the leg's carrier carries ONLY the scripted
   * parity mock route (ParityMockRoute — no web client mounts, the
   * device-plane leg's shape); the canonical parity scenario boots the
   * vendored spine against it through the runtime.config handoff, and the
   * comparator diffs the projected session log against the committed
   * golden (the runner pulls the capture). */
  private runParityLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') +
        ' upstream.parity (the comparator reads the capture)';
    };
    let bundleRoot: string = '';
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        bundleRoot = root;
        this.verdict = 'parity leg: arming the scripted route...';
        new ParityMockRoute(this.carrier).register();
        // NO phase.onCarrierListening here: the mockLlmUrl needs the bound
        // port, so it would run BEFORE beginParity — and the carrier-side
        // record it emits needs the phase runtime, which does not exist yet
        // (the "binding phase is not active" death, measured 2026-09-30).
        // The parity leg carries no carrier-side records at all: its
        // evidence is the scenario's own stream, compared against the golden.
        return this.carrier.start(CARRIER_BASE_PORT);
      })
      .then((port: number): void => {
        this.verdict = 'parity leg: running the parity scenario...';
        // The profile container the runtime.config names — created HERE
        // (recursive) because bootUpstream only pins the paths, it never
        // mkdirs them. accessSync-gated: mkdirSync throws on an existing
        // dir even with recursion (a relaunch would die on its own
        // previous container — measured 2026-09-30).
        if (!fs.accessSync(fsRoot + '/parity')) {
          fs.mkdirSync(fsRoot + '/parity', true);
        }
        phase.beginParity(ctx, bundleRoot,
          ctx.cacheDir + '/dsh-parity-capture.log',
          fsRoot, ParityMockRoute.baseUrl(port), PARITY_MOCK_KEY);
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'parity leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** The camera.plane leg (`harmony.camera-plane`, ONE launch): the binding
   * phase's carrier + HostPhase machinery with the camera-plane scenario as
   * the entry — the capture burst against a real camera; a camera-less image
   * answers `unavailable` and the ladder walks the denial legs. The verdict
   * is the C `dsh.runtime.verdict: harmony.camera-plane` line. */
  private runCameraPlaneLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' harmony.camera-plane (logs are the verdict)';
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'camera-plane leg: running...';
        phase.beginCameraPlane(ctx, root, ctx.cacheDir + '/dsh-camera-plane-capture.log', fsRoot);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          phase.evalEntryDirect();
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'camera-plane leg: running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'camera-plane leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** The BLE face's leg (ONE launch): the binding machinery with the
   * ble.plane scenario as the entry — no page mounts, so the drive needs
   * no taps. The radio rides `--ps dsh.e2e.ble.mock` (E2eLeg.getBleMock). */
  private runBleLeg(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const fsRoot: string = ctx.filesDir + '/dsh-fs';
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.onPhaseComplete = (passed: boolean): void => {
      this.verdict = (passed ? 'PASS' : 'FAIL') + ' harmony.ble.plane (logs are the verdict)';
    };
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        this.verdict = 'ble leg: running...';
        phase.beginBle(ctx, root, ctx.cacheDir + '/dsh-ble-capture.log', fsRoot,
          E2eLeg.getBleMock());
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          phase.evalEntryDirect();
          return port;
        });
      })
      .then((port: number): void => {
        this.verdict = 'ble leg: running on 127.0.0.1:' + port;
      })
      .catch((err: BusinessError): void => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'ble leg failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** Phase 2: seed the user store (E2E bootstrap, see PickerPrimitives.
 * seedUserFile) → carrier up → page mounts → scenario runs (see HostPhase).
   * The seeding gates the phase start so the save dialog is done before the
   * scenario's own picker presentations open. The m5 verdict chains into the
   * D9 official-web phase on a later tick — the completion callback fires
   * from inside a mutator call, so the teardown (hostFree) must never run on
   * that stack (ARCHITECTURE.md §6). */
  private startBindingPhase(ctx: common.UIAbilityContext, fsRoot: string): void {
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    const capturePath: string = ctx.cacheDir + '/dsh-host-capture.log';
    const seeder = new PickerPrimitives(ctx);
    seeder.seedUserFile()
      .catch((err: BusinessError): string => {
        hilog.error(0x0000, TAG, 'picker seed errored: %{public}s',
          err.message ?? 'unknown');
        return '';
      })
      .then((seedName: string): Promise<string> => {
        phase.setSeedPath(seedName);
        hilog.info(0x0000, TAG, 'picker seed result: %{public}s', seedName);
        return this.materializeBundle(ctx);
      })
      .then((root: string): Promise<number> => {
        phase.onPhaseComplete = (passed: boolean): void => {
          hilog.info(0x0000, TAG, 'm5 phase complete (passed %{public}s)',
            String(passed));
          setTimeout((): void => {
            this.startOfficialPhase(ctx, fsRoot);
          }, 200);
        };
        phase.begin(ctx, root, capturePath, fsRoot);
        installLegacyRoutes(this.carrier, root + '/webclient/dsh-web-client/web');
        installE2EStreams(this.carrier);
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          this.webUrl = 'http://127.0.0.1:' + port + '/';
          return port;
        });
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'binding phase bootstrap failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** Phase 3: the D9 official-web mount (see OfficialPhase). */
  private startOfficialPhase(ctx: common.UIAbilityContext, fsRoot: string): void {
    HostPhase.getInstance().destroy();
    this.carrier.stop();
    const official = OfficialPhase.getInstance();
    official.openOrigin = (url: string): void => {
      // The official origin becomes a FRESH Web's initial src: a src state
      // change on the live m5 Web does not re-navigate, and an explicit
      // loadUrl (from the compose call stack or after the remount) either
      // is swallowed or double-loads. Unmount (webUrl '') and remount with
      // the official origin on a later tick — exactly one navigation.
      this.webUrl = '';
      setTimeout((): void => {
        this.webUrl = url;
      }, 50);
    };
    this.materializeBundle(ctx)
      .then((root: string): void => {
        official.begin(ctx, root, ctx.cacheDir + '/dsh-official-capture.log', fsRoot);
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'official phase bootstrap failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  private showApproval(title: string, resolve: (approved: boolean) => void): void {
    this.approvalResolve = resolve;
    this.approvalTitle = title;
    this.approvalController = new CustomDialogController({
      builder: ApprovalDialog({
        title: this.approvalTitle,
        onPick: (approved: boolean): void => {
          const resolve = this.approvalResolve;
          this.approvalResolve = null;
          if (resolve !== null) {
            resolve(approved);
          }
        }
      }),
      autoCancel: false,
      customStyle: true
    });
    this.approvalController.open();
  }

  /** The surface overlay's ops interpreter: surface.ops@1 onto the ArkTS
   * Canvas (real native rendering — never a WebView). */
  private renderSurfaceOps(): void {
    const ctx = this.surfaceCtx;
    let ops: Array<Record<string, Object>> = [];
    try {
      ops = JSON.parse(this.surfaceOpsJson) as Array<Record<string, Object>>;
    } catch (e) {
      return;
    }
    const w = ctx.width;
    const h = ctx.height;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const kind = op.op as string;
      if (kind === 'clear') {
        ctx.fillStyle = (op.color as string) ?? '#000000';
        ctx.fillRect(0, 0, w, h);
      } else if (kind === 'setStyle') {
        if (op.fill !== undefined) ctx.fillStyle = op.fill as string;
        if (op.stroke !== undefined) ctx.strokeStyle = op.stroke as string;
        if (op.lineWidth !== undefined) ctx.lineWidth = op.lineWidth as number;
        if (op.font !== undefined) ctx.font = op.font as string;
      } else if (kind === 'fillRect') {
        ctx.fillRect(op.x as number, op.y as number, op.w as number, op.h as number);
      } else if (kind === 'strokePath' || kind === 'fillPath') {
        ctx.beginPath();
        const d = op.d as Array<Record<string, Object>>;
        for (let j = 0; j < d.length; j++) {
          const seg = d[j];
          const c = seg.c as string;
          if (c === 'move') ctx.moveTo(seg.x as number, seg.y as number);
          else if (c === 'line') ctx.lineTo(seg.x as number, seg.y as number);
          else if (c === 'quad') {
            ctx.quadraticCurveTo(seg.cx as number, seg.cy as number,
              seg.x as number, seg.y as number);
          } else if (c === 'arc') {
            ctx.arc(seg.x as number, seg.y as number, seg.r as number,
              seg.start as number, seg.end as number, seg.ccw === true);
          } else if (c === 'close') ctx.closePath();
        }
        if (kind === 'strokePath') {
          ctx.stroke();
        } else {
          ctx.fill();
        }
      } else if (kind === 'text') {
        ctx.textBaseline = ((op.baseline as string) ?? 'top') as CanvasTextBaseline;
        ctx.fillText(op.text as string, op.x as number, op.y as number);
      }
      // drawImage never reaches the view: SurfacePrimitives rejects it loud
    }
  }

  onSurfaceOps(): void {
    if (this.surfaceVisible) {
      this.renderSurfaceOps();
    }
  }

  private onSurfaceCanvasReady(): void {
    const sink = this.surfaceDimsSink;
    if (sink !== null) {
      let scale = 2;
      try {
        scale = display.getDefaultDisplaySync().densityPixels;
      } catch (e) {
        scale = 2;
      }
      sink({
        width: this.surfaceCtx.width,
        height: this.surfaceCtx.height,
        scale,
      });
    }
    this.renderSurfaceOps();
  }

  private closeSurfaceByUser(): void {
    const sink = this.surfaceDimsSink;
    this.surfaceDimsSink = null;
    this.surfaceVisible = false;
    if (sink !== null) {
      sink(null); // dismissed while opening — "user dismissal is a value"
    } else {
      HostPhase.getInstance().onSurfaceUserClosed();
      const serve = this.liveServe();
      if (serve !== null) {
        serve.onSurfaceUserClosed();
      }
    }
  }

  @Builder
  SurfaceOverlay() {
    Column() {
      Row() {
        Text(this.surfaceTitle)
          .fontSize(16)
          .fontColor('#f4f4f6')
          .layoutWeight(1)
          .maxLines(1)
        Button('✕')
          .fontSize(14)
          .backgroundColor('#2c2c30')
          .fontColor('#f4f4f6')
          .onClick((): void => {
            this.closeSurfaceByUser();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 12, top: 8, bottom: 8 })
      Canvas(this.surfaceCtx)
        .width('100%')
        .layoutWeight(1)
        .onReady((): void => {
          this.onSurfaceCanvasReady();
        })
        .onTouch((event: TouchEvent): void => {
          const t = event.touches[0];
          if (t === undefined) {
            return;
          }
          const kind = event.type === TouchType.Down || event.type === TouchType.Move
            ? (event.type === TouchType.Down ? 'begin' : 'move')
            : 'end';
          this.surfaceInput(kind, t.x, t.y);
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#000000')
  }

  build() {
    Stack() {
    Column({ space: 8 }) {
      // The harness shows its verdict panel above the mounted page (the E2E
      // verdict is the checker over the captured records; the Text is the
      // human summary). The release build shows the official app and nothing
      // else — except a refusal, which must stay readable (rule 5).
      if (!BuildFlavor.isRelease()) {
        Text('DSH host — HarmonyOS')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
        Text(this.verdict)
          .fontSize(14)
          .fontColor(this.verdict.startsWith('PASS') ? '#0a7d32' : '#b3261e')
          .maxLines(3)
      } else if (this.verdict !== '') {
        Text(this.verdict)
          .fontSize(14)
          .fontColor('#b3261e')
          .maxLines(6)
      }
      if (this.webUrl !== '') {
        Web({ src: this.webUrl, controller: this.webController })
          .width('100%')
          .layoutWeight(1)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .onControllerAttached(() => {
            hilog.info(0x0000, TAG, 'arkweb: controller attached for %{public}s', this.webUrl);
          })
          .onPageEnd((event) => {
            hilog.info(0x0000, TAG, 'arkweb: page end %{public}s',
              event?.url ?? this.webUrl);
            if (BuildFlavor.isRelease()) {
              return; // a user-facing build runs no probe (no drives at all)
            }
            if (E2eLeg.get() === LEG_V2WEB) {
              V2WebPhase.getInstance().onPageFinished(
                (script: string): Promise<string> =>
                  this.webController.runJavaScript(script));
            } else {
              OfficialPhase.getInstance().onPageFinished(event?.url ?? '',
                (script: string): Promise<string> =>
                  this.webController.runJavaScript(script));
            }
          })
      } else if (!BuildFlavor.isRelease()) {
        Text('carrier: starting...').fontSize(12).fontColor('#666666')
      }
    }
    .width('100%')
    .height('100%')
    .padding(12)
    if (this.surfaceVisible) {
      this.SurfaceOverlay()
    }
    }
    .width('100%')
    .height('100%')
  }
}
