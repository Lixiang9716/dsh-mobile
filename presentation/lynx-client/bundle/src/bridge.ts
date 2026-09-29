// dsh:logging-exempt (ReactLynx bundle: pure presentation, zero logging surface — E2E evidence flows through the driver, as with the web clients)
/**
 * bridge.ts — the in-bundle half of the RenderSurfaceClient seam. The four
 * seam names map onto the engine bridge the host installs:
 *
 *   host → bundle : globalThis.__dshRenderSurface.pushViewEvent(event)
 *                   (the seam's pushViewEvent, delivered by the embedding)
 *   bundle → host : globalThis.__dshRenderSurface.setIntentTarget(handler)
 *                   (the seam's onIntent, registered by the embedding)
 *
 * The seam core lives in shared/surface-core.js — the SAME module the lynx
 * skin's CLI-host mode drives and the contract tests import, so the CLI leg
 * exercises the seam the artifact ships. This file adds only the React face:
 * the useSurface hook and the global bridge install.
 */
import { useEffect, useState } from '@lynx-js/react';
import { createSurfaceCore } from '../../shared/surface-core.js';

export type SurfaceState = ReturnType<ReturnType<typeof createSurfaceCore>['state']>;

const core = createSurfaceCore();

/** Called once at App mount; installs the bridge the host delivers events
 * through. Throws loud if the host already installed one. */
export function installSurface(): void {
  const existing = (globalThis as { __dshRenderSurface?: unknown }).__dshRenderSurface;
  if (existing !== undefined) {
    throw new Error('fail loud: __dshRenderSurface already installed');
  }
  (globalThis as { __dshRenderSurface?: unknown }).__dshRenderSurface = {
    pushViewEvent: core.pushViewEvent,
    setIntentTarget: core.setIntentTarget,
  };
}

/** The React face of the single subscription point: App reads the surface
 * through this hook; everything below renders from props. */
export function useSurface(): SurfaceState {
  const [state, setState] = useState<SurfaceState>(core.state());
  useEffect(() => {
    const listener = (): void => setState(core.state());
    const unsubscribe = core.subscribe(listener);
    listener(); // resync: events may have landed between render and effect
    return () => {
      unsubscribe();
    };
  }, []);
  return state;
}

/** A user gesture that needs the wire. Validated by the core; fail loud
 * when the host never installed the intent target (no silent no-ops). */
export function emitIntent(intent: unknown): void {
  core.emitIntent(intent);
}
