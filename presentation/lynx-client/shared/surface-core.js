// dsh:logging-exempt (pure data machinery: no I/O — the driver boundary owns logging)
/**
 * surface-core.js — the bundle's seam core, React-free. ONE file, three
 * consumers: bundle/src/bridge.ts wraps it for ReactLynx (this exact module
 * is compiled INTO main.lynx.bundle), the lynx skin's CLI-host mode drives
 * it in plain Node (driver/skin-lynx.js host:'cli'), and the vitest seam
 * contract tests import it directly. Because it is the same file everywhere,
 * the CLI leg exercises the seam the artifact ships — never a parallel copy.
 *
 * Owns: view-event validation, the fold, snapshot publication, the intent
 * target slot (fail loud when unset). Knows nothing about React, Lynx, or
 * the wire.
 */
import { createFold, snapshotState } from './fold.js';
import { assertIntent, assertViewEvent } from './view-events.js';

export const createSurfaceCore = () => {
  const fold = createFold();
  let current = snapshotState(fold.state);
  const listeners = new Set();
  let intentTarget;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    /** The driver → skin path: validate, fold, publish, notify. Throws on
     * anything outside the closed view-event set (no forward tolerance). */
    pushViewEvent(event) {
      assertViewEvent(event);
      fold.apply(event);
      current = snapshotState(fold.state);
      notify();
    },
    /** The host installs the intent receiver (the seam's onIntent,
     * engine-bridge side). */
    setIntentTarget(handler) {
      intentTarget = handler;
    },
    /** A user gesture that needs the wire: validated here, fail loud when
     * no target was installed (no silent no-ops). */
    emitIntent(intent) {
      assertIntent(intent);
      if (intentTarget === undefined) {
        throw new Error('fail loud: no intent target installed');
      }
      intentTarget(intent);
    },
    /** The published snapshot (plain data; Maps spread — React-safe). */
    state: () => current,
    /** A fresh snapshot straight from the fold (assertion helper). */
    snapshot: () => snapshotState(fold.state),
    /** Subscribe to publications; returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
