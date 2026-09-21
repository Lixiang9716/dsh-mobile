package com.dshmobile.spike

import android.util.Log
import java.util.HashSet
import org.json.JSONObject

/**
 * Canonical E2E emitter for carrier-only drives: the same envelope as the
 * runtimes' carrierEvent (`dsh.spike.log:` prefix, unified-logger shape),
 * with retention for the outcome's canonical lines. Synchronized: emission
 * order = call order across all caller threads. Kotlin sibling of hosts/ios
 * CarrierEventLog.
 */
class CarrierEventLog(private val scenario: String) {

    private val lock = Object()
    private val lines = ArrayList<String>()
    private val emittedEvents = HashSet<String>()

    /** All canonical lines so far (the outcome's evidence stream). */
    fun snapshot(): List<String> = synchronized(lock) { lines.toList() }

    fun emit(event: String, fields: JSONObject) {
        synchronized(lock) {
            val line = envelope(event, fields) ?: return
            if (!BuildFlavor.keeps(line)) return
            lines.add(line)
            Log.i(TAG, PREFIX + line)
        }
    }

    /** Single-emission variant: the FIRST occurrence wins (synchronized makes
     * the check-then-append atomic across caller threads) — the page's live
     * traffic fires the wire hooks repeatedly; the manifest pins firsts. */
    fun emitOnce(event: String, fields: JSONObject) {
        synchronized(lock) {
            if (!emittedEvents.add(event)) return
            val line = envelope(event, fields) ?: return
            if (!BuildFlavor.keeps(line)) return
            lines.add(line)
            Log.i(TAG, PREFIX + line)
        }
    }

    /** The unified-logger envelope for one E2E record. */
    private fun envelope(event: String, fields: JSONObject): String? = try {
        val payload = JSONObject().put("scenario", scenario).put("event", event)
        for (key in fields.keys()) payload.put(key, fields.get(key))
        JSONObject()
            .put("level", "info")
            .put("module", "dsh.carrier")
            .put("message", "e2e")
            .put("data", org.json.JSONArray().put(payload))
            .toString()
    } catch (_: Exception) {
        null
    }

    companion object {
        const val TAG = "dsh.spike"
        const val PREFIX = "dsh.spike.log: "
    }
}
