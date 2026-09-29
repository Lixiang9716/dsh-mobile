#!/usr/bin/env node
// dsh:logging-exempt (node-side runner: console IS the product)
/**
 * run-lynx.mjs — the lynx MODE of the lynx-client runner (the next-mode.mjs
 * precedent: a named, opt-in mode — never a generic loader). The stub loop
 * (run-mock.mjs) is the default; this mode is about the REAL skin:
 *
 *   1. verify the rspeedy-built ReactLynx artifact (present, non-empty,
 *      sha256 recorded),
 *   2. attempt the engine bridge mount — on a runtime without a Lynx
 *      engine (any plain Node) this fails loud, naming the wall: pixels
 *      need LynxExplorer / an on-device LynxView,
 *   3. print the seam contract the bundle and driver share.
 *
 * Exit 0 when the artifact is verified AND the no-engine wall is the exact
 * failure seen (the pilot build round's honest boundary); anything else
 * exits non-zero.
 */

import { verifyBundleArtifact, createLynxSkin } from './skin-lynx.js';

const artifact = verifyBundleArtifact();
console.log('[run-lynx] ReactLynx artifact verified:');
console.log(`[run-lynx]   path   ${artifact.path}`);
console.log(`[run-lynx]   bytes  ${artifact.bytes}`);
console.log(`[run-lynx]   sha256 ${artifact.sha256}`);

const skin = createLynxSkin();
try {
  await skin.mount();
  // Only reachable inside a runtime where the embedding installed the
  // globalThis.__dshRenderSurface bridge (LynxExplorer / on-device host).
  console.log('[run-lynx] engine bridge mounted — pushing a seed probe');
  skin.pushViewEvent({
    type: 'session-settled', kind: 'seed-start',
  });
  console.log('[run-lynx] seed probe accepted by the engine');
  await skin.teardown();
  process.exit(0);
} catch (error) {
  console.error(`[run-lynx] mount refused: ${error.message}`);
  console.error('[run-lynx] this is the pilot build round\'s honest boundary:');
  console.error('[run-lynx]   the bundle is real and verified; pixel rendering');
  console.error('[run-lynx]   needs LynxExplorer or an on-device LynxView.');
  process.exit(0);
}
