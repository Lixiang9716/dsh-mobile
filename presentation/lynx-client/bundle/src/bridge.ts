/**
 * bridge.ts — the in-bundle half of the RenderSurfaceClient seam. The
 * four seam names map onto the engine bridge the host installs:
 *
 *   host → bundle : globalThis.__dshRenderSurface.pushViewEvent(event)
 *                   (the seam's pushViewEvent, delivered by the embedding)
 *   bundle → host : globalThis.__dshRenderSurface.setIntentTarget(handler)
 *                   (the seam's onIntent, registered by the embedding)
 *
 * The fold runs HERE at module scope so a seed burst that lands before
 * React's first render is never lost — the first render already sees the
 * rebuilt thread (cold-start iron law, bundle side). Leaf components
 * never subscribe to anything: they render from the snapshot this module
 * serves (single subscription point, bundle side).
 */
import { useEffect, useState } from '@lynx-js/react';
import {
  createFold,
  snapshotState,
} from '../../shared/fold.js';
import { assertIntent, assertViewEvent } from '../../shared/view-events.js';

export type SurfaceState = ReturnType<typeof snapshotState>;

const fold = createFold();
let current = snapshotState(fold.state);
const listeners = new Set<() => void>();
let intentTarget: ((intent: unknown) => void) | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

/** Called once at App mount; installs the bridge the host delivers
 * events through. Throws loud if the host already installed one. */
export function installSurface(): void {
  const existing = (globalThis as { __dshRenderSurface?: unknown }).__dshRenderSurface;
  if (existing !== undefined) {
    throw new Error('fail loud: __dshRenderSurface already installed');
  }
  (globalThis as { __dshRenderSurface?: unknown }).__dshRenderSurface = {
    pushViewEvent: (event: unknown) => {
      assertViewEvent(event);
      fold.apply(event);
      current = snapshotState(fold.state);
      notify();
    },
    setIntentTarget: (handler: (intent: unknown) => void) => {
      intentTarget = handler;
    },
  };
}

/** The React face of the single subscription point: App reads the surface
 * through this hook; everything below renders from props. */
export function useSurface(): SurfaceState {
  const [state, setState] = useState<SurfaceState>(current);
  useEffect(() => {
    const listener = (): void => setState(snapshotState(fold.state));
    listeners.add(listener);
    listener(); // resync: events may have landed between render and effect
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

/** A user gesture that needs the wire. Validated here; fail loud when the
 * host never installed the intent target (no silent no-ops). */
export function emitIntent(intent: unknown): void {
  assertIntent(intent);
  if (intentTarget === undefined) {
    throw new Error(
      'fail loud: no intent target — the host embedding must install '
      + 'globalThis.__dshRenderSurface and register its handler via '
      + 'setIntentTarget before user interactions',
    );
  }
  intentTarget(intent);
}
