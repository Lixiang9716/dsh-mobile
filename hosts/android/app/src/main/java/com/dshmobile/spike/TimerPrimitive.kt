package com.dshmobile.spike

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * timer (contract/primitives.md §4 "timer", v1.4.0) — one host-owned wake-up
 * seam. `timerSchedule` arms ONE wake-up and settles when ARMED; the fire
 * itself is a `timer.fire` bridge event (the §5 channel), hopped onto the
 * serial runtime queue like every host event — a timer never runs JS on a
 * second thread (D2) and never blocks (D8).
 *
 * Scheduling rides the main-looper Handler (postDelayed, monotonic); the
 * callback does nothing but post the event delivery onto the runtime thread
 * (the same hop settleFn/eventFn use), so arm-settle is enqueued on the
 * runtime queue strictly before any fire of the same timer (the settle is
 * emitted synchronously at dispatch; the fire is wall-clock later).
 * `timerCancel` is idempotent — an unknown or already-fired id settles
 * `{cancelled: false}`; the fire/cancel race resolves one way (the map
 * removal decides), never both.
 */
class TimerPrimitive {

    companion object {
        /** The host-side clamp: tighter than dsh-timeout's own fuse cap and
         * named in the rejection — never a silent truncation (rule 5). */
        const val MAX_DELAY_MS = 2_147_483_647L
        private fun invalid(msg: String) =
            GatewayCore.GatewayError("invalid", "timerSchedule", msg)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val live = java.util.concurrent.ConcurrentHashMap<Int, Runnable>()
    private var nextId = 0

    /** Wired by the host session: delivers one bridge event — the host's
     * event() already hops onto the serial runtime queue, so the fire
     * callback (main looper) does nothing but hand it the payload. */
    var emitFn: ((json: String) -> Unit)? = null

    fun register(on: GatewayCore) {
        on.register("timerSchedule") { call, done -> schedule(call, done) }
        on.register("timerCancel") { call, done -> cancel(call, done) }
    }

    private fun schedule(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        if (!call.args.has("delayMs")) {
            return done.settle(null, invalid("missing delayMs"))
        }
        val delay = call.args.optLong("delayMs", -1L)
        if (delay < 0 || delay > MAX_DELAY_MS) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "invalid", "timerSchedule",
                    "delayMs must be an integer in [0, $MAX_DELAY_MS] (got $delay)",
                ),
            )
        }
        val tag = call.args.optString("tag", null)
        val id = synchronized(this) { ++nextId }
        val fire = Runnable {
            // The fire/cancel race resolves HERE and only here: removal from
            // `live` is the single decision point (a cancelled timer is
            // already absent; a fired one is removed by this very line), so
            // fire and cancel can never both report true.
            if (live.remove(id) == null) return@Runnable
            val payload = JSONObject()
                .put("event", "timer.fire")
                .put("timerId", id)
                .apply { if (tag != null) put("tag", tag) }
            emitFn?.invoke(payload.toString())
        }
        live[id] = fire
        handler.postDelayed(fire, delay)
        done.settle(JSONObject().put("timerId", id), null)
    }

    private fun cancel(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val id = call.args.optInt("timerId", -1)
        val fire = live.remove(id)
        if (fire != null) {
            handler.removeCallbacks(fire)
        }
        done.settle(JSONObject().put("cancelled", fire != null), null)
    }
}
