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
import { defineRenderSurfaceClient } from './render-surface-client.js';

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

export const createLynxSkin = ({ bundlePath = BUNDLE_PATH } = {}) => {
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

  return defineRenderSurfaceClient({
    async mount() {
      const artifact = verifyBundleArtifact(bundlePath);
      // The engine presence test is the bridge hook itself: an embedding
      // runtime installs globalThis.__dshRenderSurface before the bundle
      // evaluates. Node (no engine) does not have it — fail loud, name the
      // wall, keep the verification facts.
      const bridge = globalThis.__dshRenderSurface;
      if (bridge === undefined || typeof bridge.pushViewEvent !== 'function') {
        throw new Error(
          `fail loud: no Lynx engine in this runtime — the ReactLynx bundle is `
          + `built and verified (${artifact.path}, ${artifact.bytes} bytes, sha256 `
          + `${artifact.sha256.slice(0, 16)}…); pixel rendering needs `
          + `LynxExplorer or an on-device LynxView (pilot build round boundary, `
          + `see skin-lynx.js header)`,
        );
      }
      engine = bridge;
      bridge.setIntentTarget((intent) => {
        if (intentHandler === null) {
          throw new Error('fail loud: lynx skin has no intent handler (driver not mounted)');
        }
        intentHandler(intent);
      });
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
