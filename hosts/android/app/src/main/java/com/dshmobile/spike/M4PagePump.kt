package com.dshmobile.spike

import android.app.Activity
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The M4 host's `/ws` page pump, extracted from SpikeHostM4 to keep both
 * under the file-size gate: the projection replay buffer (fed by the
 * runtime's ws.send bus posts) with its token-delta evidence, the page's
 * hello/slot.ack protocol, the ws.connected / slot.registered / host.info
 * readiness chain, and the one origin load. Pure plumbing over the shared
 * carrier — the records still ride the owning drive's scenario id through
 * [log] (the owner's carrierLog) and the runtime events through [onEvent].
 */
internal class M4PagePump(
    private val activity: Activity,
    private val carrier: CarrierServer,
    /** One canonical record (the owner's carrierLog, scenario id included). */
    private val log: (String, JSONObject) -> Unit,
    /** One runtime gateway event (host.info) — hops onto the runtime thread. */
    private val onEvent: (String) -> Unit,
    /** The runtime handle exists and the port is bound (the host.info gate). */
    private val runtimeReady: () -> Boolean,
) {

    private val projection = ArrayList<String>()
    private var firstDeltaSeen = false
    private var connectedLogged = false
    private var slotAcked = false
    private var hostInfoDelivered = false
    private var webView: WebView? = null

    /** The drive's WebView (set before the origin can load). */
    fun attach(view: WebView?) {
        webView = view
    }

    /** UI thread: mount the Web Client (Presentation surface). */
    fun loadOrigin(port: Int) {
        webView?.loadUrl("http://127.0.0.1:$port/")
    }

    /** Runtime thread: one projection line the runtime pushed (ws.send) —
     * buffered for replay, observed for the token-delta evidence. */
    fun record(text: String) {
        val payload = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        synchronized(projection) { projection.add(text) }
        when (payload.optString("kind")) {
            "token-delta" -> if (!firstDeltaSeen) {
                firstDeltaSeen = true
                log(
                    "ws.token-delta",
                    JSONObject().put("first", true).put("index", payload.optInt("index")),
                )
            }
            "complete" -> {
                log("ws.token-delta", JSONObject()
                    .put("first", false)
                    .put("last", true)
                    .put("index", payload.optInt("deltas", 1) - 1))
                log("ws.session-complete", JSONObject().put("status", payload.optString("status", "pass")))
            }
        }
    }

    /** Carrier thread; hops onto the runtime thread. */
    fun ingest(text: String) {
        val payload = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        SpikeRuntime.post {
            when (payload.optString("type")) {
                "hello" -> pageHello(payload.optString("protocol"))
                "slot.ack" -> slotAck(payload)
            }
        }
    }

    /** Runtime thread: greet the page, replay the projection, mark connected. */
    private fun pageHello(protocol: String) {
        carrier.send(
            JSONObject()
                .put("type", "ws.hello")
                .put("protocol", protocol)
                .put("served", JSONArray(carrier.servedList()))
                .toString(),
        )
        carrier.send(replayLine())
        if (connectedLogged) return
        connectedLogged = true
        log("ws.connected", JSONObject().put("protocol", protocol))
        deliverHostInfo()
    }

    /** The replay payload for a (re)connecting page: every projection line
     * pushed so far, parsed back as JSON values. */
    private fun replayLine(): String = JSONObject()
        .put("type", "replay")
        .put("events", JSONArray(replayEvents()))
        .toString()

    private fun replayEvents(): List<JSONObject> = synchronized(projection) {
        projection.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
    }

    /** Runtime thread: rendered-state evidence + host.info half-gate. */
    private fun slotAck(payload: JSONObject) {
        if (slotAcked) return
        slotAcked = true
        log(
            "slot.registered",
            JSONObject()
                .put("id", payload.optString("id"))
                .put("label", payload.optString("label"))
                .put("by", payload.optString("by")),
        )
        deliverHostInfo()
    }

    /** Runtime thread: fires once the page is connected AND acked the slot. */
    private fun deliverHostInfo() {
        if (hostInfoDelivered || !runtimeReady() ||
            !connectedLogged || !slotAcked
        ) {
            return
        }
        hostInfoDelivered = true
        onEvent(
            JSONObject().put("event", "host.info").put("port", carrier.port).toString(),
        )
    }
}
