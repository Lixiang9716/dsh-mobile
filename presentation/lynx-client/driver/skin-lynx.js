// dsh:logging-exempt (node-side driver)
/**
 * skin-lynx.js — the lynx RenderSurfaceClient: mounts the rspeedy-built
 * ReactLynx bundle (bundle/dist/main.lynx.bundle) into a Lynx engine.
 *
 * The engine bridge (bundle/src/bridge.ts mirrors the seam's names):
 *   host → bundle : globalThis.__dshRenderSurface.pushViewEvent(event)
 *   bundle → host : globalThis.__dshRenderSurface.setIntentTarget(handler)
 * On device, the embedding app installs that pair when the LynxView boots
 * (the NativeModules.DshRenderSurface formalization lands with the
 * on-device round); this module is the driver-side half.
 *
 * Honest boundary of the pilot build round: THIS MACHINE HAS NO LYNX
 * ENGINE. mount() without one throws, naming the wall — the artifact
 * itself is still verified (present, non-empty, sha256 recorded) and that
 * verification is what driver/run-lynx.mjs (lynx mode) exercises. Pixels
 * need LynxExplorer / a real device; nothing here pretends otherwise.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertViewEvent } from '../shared/view-events.js';
import { createSurfaceCore } from '../shared/surface-core.js';
import { defineRenderSurfaceClient } from './render-surface-client.js';
import { renderTranscript } from './skin-stub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = join(HERE, '../bundle/dist/main.lynx.bundle');

/** Verify the built artifact exists, is non-empty, and return its sha256. */
export const verifyBundleArtifact = (path = BUNDLE_PATH) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `fail loud: the ReactLynx bundle is missing at ${path} — run `
      + `"npm run build" in presentation/lynx-client/bundle (rspeedy build) first`,
    );
  }
  const bytes = readFileSync(path);
  if (bytes.length < 1024) {
    throw new Error(`fail loud: ${path} is ${bytes.length} bytes — not a real bundle`);
  }
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

/** The no-engine refusal: fail loud, name the wall, keep the verification
 * facts (the artifact bytes + sha travel with the error). */
const engineRefusal = (artifact) => new Error(
  `fail loud: no Lynx engine in this runtime — the ReactLynx bundle is `
  + `built and verified (${artifact.path}, ${artifact.bytes} bytes, sha256 `
  + `${artifact.sha256.slice(0, 16)}…); pixel rendering needs `
  + `LynxExplorer or an on-device LynxView (pilot build round boundary, `
  + `see skin-lynx.js header)`,
);

/** The lynx skin's CLI-HOST mode: the same RenderSurfaceClient contract over
 * the bundle's REAL seam core (shared/surface-core.js — the exact module
 * bridge.ts compiles into main.lynx.bundle) plus the artifact verification
 * the engine mode does. Plain Node drives the seam the artifact ships; the
 * pixels stay honestly engine-only. Exposes `.transcript` (the stub's
 * transcription over the core's fold state) so the E2E leg asserts the same
 * markers both faces produce, and `.artifact`/`.mountMode` so the leg's log
 * names its mechanism precisely — never a pretend render. */
const createLynxBridgeSkin = ({ bundlePath }) => {
  const core = createSurfaceCore();
  let artifact = null;
  let handler = null;
  return defineRenderSurfaceClient({
    async mount() {
      artifact = verifyBundleArtifact(bundlePath);
      core.setIntentTarget((intent) => {
        if (handler === null) {
          throw new Error(
            'fail loud: lynx bridge skin has no intent handler (driver not mounted)',
          );
        }
        handler(intent);
      });
    },
    pushViewEvent(event) {
      core.pushViewEvent(event);
    },
    onIntent(intentHandler) {
      handler = intentHandler;
    },
    async teardown() {
      handler = null;
    },
    /** Test affordance: a "tap" — the bundle raising an intent through the
     * seam core (validated there, forwarded to the driver's handler). */
    tap(intent) {
      core.emitIntent(intent);
    },
    get transcript() {
      return renderTranscript(core.snapshot());
    },
    get artifact() {
      return artifact;
    },
    get face() {
      return 'lynx';
    },
    get mountMode() {
      return 'cli: bundle seam core (shared/surface-core.js, the module compiled '
        + `into ${BUNDLE_PATH}) — artifact verified, pixels engine-only`;
    },
  });
};

export const createLynxSkin = ({ bundlePath = BUNDLE_PATH, host = 'engine' } = {}) => {
  if (host === 'cli') return createLynxBridgeSkin({ bundlePath });
  let engine = null;
  let intentHandler = null;

  const deliverToEngine = (event) => {
    if (engine === null) {
      throw new Error(
        'fail loud: lynx skin has no engine surface — mount() in a runtime '
        + 'with a Lynx engine (LynxExplorer / on-device LynxView) before pushing events',
      );
    }
    engine.pushViewEvent(assertViewEvent(event));
  };

  const installIntentTarget = (bridge) => {
    bridge.setIntentTarget((intent) => {
      if (intentHandler === null) {
        throw new Error('fail loud: lynx skin has no intent handler (driver not mounted)');
      }
      intentHandler(intent);
    });
  };

  return defineRenderSurfaceClient({
    async mount() {
      const artifact = verifyBundleArtifact(bundlePath);
      // The engine presence test is the bridge hook itself: an embedding
      // runtime installs globalThis.__dshRenderSurface before the bundle
      // evaluates. Node (no engine) does not have it — fail loud, name the
      // wall, keep the verification facts.
      const bridge = globalThis.__dshRenderSurface;
      if (bridge === undefined || typeof bridge.pushViewEvent !== 'function') {
        throw engineRefusal(artifact);
      }
      engine = bridge;
      installIntentTarget(bridge);
    },
    pushViewEvent(event) {
      deliverToEngine(event);
    },
    onIntent(handler) {
      intentHandler = handler;
    },
    async teardown() {
      engine = null;
      intentHandler = null;
    },
  });
};
