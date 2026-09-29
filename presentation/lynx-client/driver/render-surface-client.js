// dsh:logging-exempt (node-side driver)
/**
 * render-surface-client.js — THE replaceable seam.
 *
 * A RenderSurfaceClient (a "skin") is everything the driver knows about
 * rendering. Two implementations ship in this package, one interface:
 *
 *   driver/skin-lynx.js — mounts the rspeedy-built ReactLynx bundle
 *                         (bundle/dist/main.lynx.bundle); pixels on-device
 *   driver/skin-stub.js — plain-text transcription; runs anywhere Node runs
 *
 * The contract (all four methods are REQUIRED — defineRenderSurfaceClient
 * validates at construction, fail loud on a half-implemented skin):
 *
 *   mount(): Promise<void>
 *     Boot the surface. The driver calls onIntent(handler) BEFORE mount,
 *     and begins pushViewEvent immediately after it resolves — a skin must
 *     be ready to fold events with zero user interaction (cold start is
 *     event-seeded; the mount is never blank).
 *
 *   pushViewEvent(event): void
 *     The ONLY driver→skin path. `event` belongs to the closed set in
 *     shared/view-events.js; skins validate via assertViewEvent and THROW
 *     on the unknown (same-package-same-version — no forward tolerance).
 *
 *   onIntent(handler): void
 *     Registers the skin→driver callback. The skin calls handler(intent)
 *     for user actions that need the wire (submit / cancel / select-session
 *     / new-session — the closed intent set); UI-local state (drawer
 *     open/close, card expand) never crosses the seam.
 *
 *   teardown(): Promise<void>
 *     Release the surface; the driver stops pushing after the promise.
 *
 * The bundle half of the lynx skin mirrors the same four names on the other
 * side of the engine bridge (bundle/src/bridge.ts): the host installs
 * globalThis.__dshRenderSurface = {pushViewEvent, setIntentTarget}, which is
 * the in-bundle pushViewEvent/onIntent. The seam is one vocabulary on both
 * sides of the glass.
 */

import { assertIntent } from '../shared/view-events.js';

export const defineRenderSurfaceClient = (client) => {
  for (const method of ['mount', 'pushViewEvent', 'onIntent', 'teardown']) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(
        `fail loud: skin is missing RenderSurfaceClient.${method}() — `
        + `the seam is mount/pushViewEvent/onIntent/teardown, got: ${
          Object.keys(client).join(', ') || '(empty)'}`,
      );
    }
  }
  return client;
};

/** The one place an intent crosses back; validated here so every skin gets
 * the same fail-loud edge. */
export const dispatchIntent = (handler, intent) => handler(assertIntent(intent));
