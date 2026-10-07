// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * android-officialweb-web-live.js — the ON-DEVICE web-boot producer behind
 * android.officialweb.mount (decision D9, W-DROID leg; the Android
 * sibling of officialweb-web-live.js — same composition, Android carrier id).
 *
 * The drive embeds the web-boot closure ONLY (upstream/web-boot.js +
 * shims + the vendored cordis / cosmokit / schemastery /
 * @deepseek-ai/dsh-client-modules libs — NOT the full agent spine), so the
 * scenario composes the OFFICIAL boot wire without runtime services:
 *
 *   host → runtime : the `web.plugins` bus delivery (staged files the Kotlin
 *                    drive reads from filesDir/web-plugins)
 *   runtime → host : `web.boot` (facade queue row, blocking bootstrap batch,
 *                    `__DSH_BOOT__` graph, recovery defaults, plugin revs)
 *
 * The carrier swaps the delivered rows into the index render pipeline and
 * serves the staged client-modules bundle at the graph's combo URL, so the
 * official page's facade `create()` materializes the REAL upstream browser
 * bundle and boots the real client module system in the WebView. With no
 * runtime services mounted, nothing is claimed: /api and the mux stay
 * carrier-unimplemented (structured, loud) — the honest next named gap
 * after the boot progression.
 *
 * The scenario completes once `web.boot` is posted; the WebView load is
 * gated on the drive receiving it.
 */
import { createLogger } from 'logger.js';
import { Context } from '@deepseek-ai/cordis';
import { createWebBootRuntime } from 'upstream/web-boot.js';

const SCENARIO = 'android.officialweb.mount';
const log = createLogger('android.web');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });

const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('runtime.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};

/** Deliveries may arrive before the runtime half exists (the drive injects
 * right after eval), so the subscription is module-scope, buffers, and wakes
 * the awaiting main() — main() runs synchronously during eval, before the
 * drive's delivery call, so it must WAIT for the arrival, never poll. */
const busDeliveries = [];
let deliveryArrived = null;
const deliveryPromise = new Promise((resolve) => { deliveryArrived = resolve; });
let busHandler = null;
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  if (busHandler === null) {
    busDeliveries.push(msg);
    deliveryArrived?.();
  } else busHandler(msg);
};

const post = (msg) => globalThis.__dshBusPost?.(JSON.stringify(msg));

const main = async () => {
  log.debug('main begin', {});
  const ctx = new Context();
  const runtime = createWebBootRuntime({ ctx, post });
  busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'unknown') {
      throw new Error(`web-boot: unknown bus delivery type '${outcome.type}'`);
    }
    if (outcome.kind === 'booted') {
      // entryCount, not the 58-id list: logcat's ~4KB line budget truncates
      // the full array mid-JSON and the E2E capture loses the record (the
      // iOS sibling logs the full list — no such transport cap there).
      emit('runtime.booted', {
        entryCount: outcome.entries.length,
        source: 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
    }
  };
  if (busDeliveries.length === 0) await deliveryPromise;
  for (const msg of busDeliveries.splice(0)) busHandler(msg);
  log.debug('web.boot posted; scenario completes', {});
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
