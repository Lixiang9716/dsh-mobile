// dsh:logging-exempt — ArkTS UI logs natively via hilog; the JS
// createLogger contract does not reach this layer (#343).
/*
 * Index — the D9 host page. THREE phases on ONE launch:
 *
 * 1. Regression (synchronous): materializes the bundled spike (byte-identical
 *    rawfile copies of the runtime/spike originals + the Web Client plugin)
 *    into the app cache dir preserving layout, then calls startSpike ONCE on
 *    the UI thread — boot.verification, gateway.bridge-smoke, session.mock-llm on the ONE
 *    serial JS thread (ARCHITECTURE.md §6). The returned summary is the human
 *    verdict; the E2E verdict is the checker over the captured
 *    `dsh.spike.log:` lines (never this Text, never a screenshot).
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
import { startSpike } from 'libspike.so';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { CarrierServer } from '../model/CarrierServer';
import { installE2EStreams, installLegacyRoutes } from '../model/CarrierRoutes';
import { E2eLeg } from '../model/E2eLeg';
import { HostPhase } from '../model/HostPhase';
import { LlmConfigStaging } from '../model/LlmConfigStaging';
import { OfficialPhase } from '../model/OfficialPhase';
import { OfficialServe } from '../model/OfficialServe';
import { PickerPrimitives } from '../model/PickerPrimitives';
import { BuildFlavor } from '../model/BuildFlavor';

const TAG: string = 'dsh.app';
const CARRIER_BASE_PORT: number = 17877;
/** The launch parameter EntryAbility parks in E2eLeg — `--ps dsh.e2e.leg`. */
const LEG_LLM: string = 'llm.live-stream';

// bundle-root-relative files shipped under resources/rawfile/spike/ —
// logger.js must sit at <bundle>/logger.js, gateway.js at <bundle>/gateway.js,
// the scenarios at <bundle>/scenario/..., the vendored package under
// <bundle>/vendor/... (the spike host's ESM loader resolves these paths).
// webclient/... is the ACTIVE Web Client plugin the m5 carrier serves;
// upstream/... + the vendor/npm libs are the D9 web-boot closure the
// official-web phase runs, and the W-SESS spine closure below it is the
// full upstream agent spine the session-live leg boots (byte-identical to
// the runtime/spike canonicals — ci/vendor-official.sh cmp-verifies every
// copy; ci/check-bundle-files.mjs pins this list == the tracked rawfile
// tree). EXTEND whenever the closure grows.
const BUNDLE_FILES: string[] = [
  'e2e-stage.js',
  'gateway.js',
  'install-pipeline.js',
  'llm.js',
  'logger.js',
  'registry.js',
  'sha256.js',
  'tar-mini.js',
  'fixtures/dsh-notes-source.js',
  'fixtures/dsh-notes.js',
  'scenario/officialweb-web-live.js',
  'scenario/harmony-httpfetch-streaming.js',
  'scenario/harmony-session-live-read.js',
  'scenario/harmony-composer-live-write.js',
  'scenario/boot-verification.js',
  'scenario/gateway-bridge-smoke.js',
  'scenario/llm-live-stream.js',
  'scenario/upstream-parity.js',
  'scenario/parity-projector.js',
  'scenario/upstream-suite-leg.js',
  'scenario/upstream-test-harness.js',
  'scenario/session-mock-llm.js',
  'scenario/harmony-capability-binding.js',
  'scenario/upstream-parity.js',
  'scenario/parity-projector.js',
  'scenario/upstream-suite-leg.js',
  'scenario/upstream-test-harness.js',
  'system-plugins/dsh-fs/index.js',
  'system-plugins/dsh-fs/manifest.json',
  'system-plugins/dsh-subprocess-quickjs/index.js',
  'system-plugins/dsh-subprocess-quickjs/manifest.json',
  'system-plugins/dsh-ui/index.js',
  'system-plugins/dsh-ui/manifest.json',
  'upstream/boot.js',
  'upstream/llm-transport.js',
  'upstream/settings-memory.js',
  'upstream/web-boot.js',
  'upstream/web-shims.js',
  'upstream/web-write-settings.js',
  'upstream/web-write-streams.js',
  'upstream/web-write.js',
  'upstream/shims/async-hooks.js',
  'upstream/shims/buffer.js',
  'upstream/shims/crypto.js',
  'upstream/shims/dsh-session-persistence.js',
  'upstream/shims/fs.js',
  'upstream/shims/fs-workspace.js',
  'upstream/shims/node-module.js',
  'upstream/shims/os.js',
  'upstream/shims/path.js',
  'upstream/shims/process.js',
  'upstream/shims/url.js',
  'upstream/shims/util-types.js',
  'upstream/shims/util.js',
  'upstream/shims/timers-promises.js',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/package.json',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/agent-loop@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/agent@0.1.6-alpha.2/package.json',
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
  'vendor/dsh/brand@0.1.6-alpha.2/package.json',
  'vendor/dsh/brand@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/llm@0.1.6-alpha.2/package.json',
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
  'vendor/dsh/sandbox@0.1.6-alpha.2/package.json',
  'vendor/dsh/sandbox@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/scope@0.1.6-alpha.2/package.json',
  'vendor/dsh/scope@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/scope@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/package.json',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/session-projection@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/session@0.1.6-alpha.2/package.json',
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
  'vendor/dsh/settings@0.1.6-alpha.2/package.json',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/invariant.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/redact.js',
  'vendor/dsh/settings@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/package.json',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/system-prompt@0.1.6-alpha.2/lib/invariant.js',
  'vendor/dsh/timeout@0.1.6-alpha.2/package.json',
  'vendor/dsh/timeout@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tools@0.1.6-alpha.2/package.json',
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
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/package.json',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/index.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/owned-value.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/remote-error.js',
  'vendor/dsh/typert-protocol@0.1.6-alpha.2/lib/types/types.js',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/LICENSE',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/PROVENANCE.md',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.i18n.yaml',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.md',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/README.zh.md',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/package.json',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/util-values@0.1.6-alpha.2/package.json',
  'vendor/dsh/util-values@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/package.json',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/client.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/cordis@4.0.2/package.json',
  'vendor/npm/cordis@4.0.2/lib/index.js',
  'vendor/npm/cosmokit@1.8.3/package.json',
  'vendor/npm/cosmokit@1.8.3/lib/index.js',
  'vendor/npm/schemastery@3.18.2/package.json',
  'vendor/npm/schemastery@3.18.2/lib/index.mjs',
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
  'webclient/dsh-web-client/manifest.json',
  'webclient/dsh-web-client/web/index.html',
  'webclient/dsh-web-client/web/main.js',
  'scenario/harmony-composer-live-write.js',
  'upstream/shims/fs-promises.js',
  'upstream/shims/npm-bridges.js',
  'upstream/web-write-inventory.js',
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
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/ptc/preset.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/agent.cordis.yml',
  'vendor/dsh/agent-presets@0.1.6-alpha.2/presets/standard/preset.yml',
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
  'vendor/dsh/fs-local@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/fs-local@0.1.6-alpha.2/package.json',
  'vendor/dsh/home-paths@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/home-paths@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-fs@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-fs@0.1.6-alpha.2/package.json',
  'vendor/dsh/tool-str-replace-editor@0.1.6-alpha.2/lib/index.js',
  'vendor/dsh/tool-str-replace-editor@0.1.6-alpha.2/package.json',
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
    'vendor/dsh/fs@0.1.6-alpha.2/lib/index.js',
    'vendor/dsh/fs@0.1.6-alpha.2/lib/invariant.js',
    'vendor/dsh/fs@0.1.6-alpha.2/package.json',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/index.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/invariant.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/client.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/index.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/invariant.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/lib/types/types.js',
    'vendor/dsh/tool-todo@0.1.6-alpha.2/package.json',
    'system-plugins/dsh-shell-ish/index.js',
    'system-plugins/dsh-shell-ish/manifest.json',
    'system-plugins/dsh-shell-wasm/index.js',
    'system-plugins/dsh-shell-wasm/manifest.json',
    'vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js',
    'vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js',
    'vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs',
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
  @State verdict: string = 'spike: running...';
  @State webUrl: string = '';
  @State approvalTitle: string = '';
  private approvalResolve: ((approved: boolean) => void) | null = null;
  private approvalController: CustomDialogController | null = null;
  private carrier: CarrierServer = new CarrierServer();
  private webController: webview.WebviewController = new webview.WebviewController();
  /** The release boot's serving seat (null in the harness: OfficialPhase
   * owns the seat there). */
  private releaseServe: OfficialServe | null = null;

  aboutToAppear(): void {
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
      // initial "spike: running..." placeholder, which the harness shows
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
    this.carrier.stop();
  }

  /** The user-facing boot (release only): materialize the bundled web-boot
   * closure, then run the serving seat — carrier up, the web-boot runtime
   * composes the official boot wire from the vendored dist + client bundles
   * in rawfile, and the origin opens in ArkWeb. No leg, no probe, no record:
   * the serving seat's evidence hooks are left at their no-op defaults. */
  private startReleaseServe(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const serve = new OfficialServe();
    this.releaseServe = serve;
    serve.onOrigin = (url: string): void => {
      // The official origin becomes the Web's initial src (nothing is
      // mounted yet, so this is exactly one navigation).
      this.webUrl = url;
    };
    const fsRoot: string = ctx.filesDir + '/spike-fs';
    this.materializeBundle(ctx)
      .then((root: string): void => {
        serve.begin(ctx, root, ctx.cacheDir + '/dsh-official-serve.log', fsRoot);
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
      content = ctx.resourceManager.getRawFileContent('spike/' + rel);
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
    const root: string = ctx.cacheDir + '/spike';
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
      content = ctx.resourceManager.getRawFileContent('spike/' + manifestRel);
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
    const capturePath: string = ctx.cacheDir + '/dsh-spike-capture.log';
    const fsRoot: string = ctx.filesDir + '/spike-fs';
    this.materializeBundle(ctx)
      .then((root: string): string => startSpike(root, capturePath, fsRoot))
      .then((summary: string) => {
        this.verdict = summary;
        hilog.info(0x0000, TAG, 'spike verdict: %{public}s', summary);
        this.startBindingPhase(ctx, fsRoot);
      })
      .catch((err: BusinessError) => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'spike failed: %{public}s', err.message ?? 'unknown');
      });
  }

  /** The `llm.live-stream` leg (ONE launch; ci/run-live-llm.sh): the phase runtime
   * starts FIRST and evals the staging module, whose C-side app-scope
   * fsWrite creates the credential placeholder at the mode the hdc shell
   * user can open (see LlmConfigStaging's header — the sandbox refuses every
   * other path). Then the SAME carrier + HostPhase wiring the binding phase
   * uses, with the canonical llm-live-stream scenario as the entry. No user-store
   * seeding and no D9 chain: this leg is the whole run, so the default chain
   * never spends serve quota. The verdict is the C `dsh.spike.verdict:
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
    const fsRoot: string = ctx.filesDir + '/spike-fs';
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
    const fsRoot: string = ctx.filesDir + '/spike-fs';
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

  build() {
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
            OfficialPhase.getInstance().onPageFinished(event?.url ?? '',
              (script: string): Promise<string> =>
                this.webController.runJavaScript(script));
          })
      } else if (!BuildFlavor.isRelease()) {
        Text('carrier: starting...').fontSize(12).fontColor('#666666')
      }
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
