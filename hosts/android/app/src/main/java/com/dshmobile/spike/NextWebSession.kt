package com.dshmobile.spike

import android.app.Activity
import android.os.Handler
import android.util.Log
import android.webkit.WebView
import org.json.JSONObject

    /** Drives `android.nextweb.mount` (the Android sibling of hosts/ios
     * NextWebRuntime): the SELF-HOSTED web client (assets copy of
     * presentation/web-client-next) on the SAME SessionServe seat the
     * user-facing launch runs — selected by client id, served with zero
     * injection rows, speaking the same /api + remote.mux surface. The
     * probe drives OUR page like a user (new session → type → send → stop →
     * create) through REAL agent-loop turns whose model boundary is the
     * carrier's scripted SSE endpoint (the SLOW_TURN drip and the CREATE_TURN
     * write+present round ride MockLlmRoute); the journal streams live and
     * the page's own timeline fold renders it. One implementation of the
     * serving path, verified by this manifest and run by users — the seat's
     * hook block (no-op defaults) is the seam, the iOS drive's shape
     * mirrored. JS runs ONLY on SpikeRuntime's HandlerThread. */
class NextWebSession private constructor(private val activity: Activity) {

    companion object {
        const val SCENARIO = "android.nextweb.mount"
        // Bound, not pacing: the drive's legs carry their own deadlines; the
        // three scripted turns + creation round fit well inside the runner's
        // phase window (the write-live drive's 270s budget, same seat class).
        const val WATCHDOG_SECONDS = 270

        private const val TAG = "dsh.spike"
        private const val RESULT_TAG = "dsh.spike.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"

        @Volatile private var instance: NextWebSession? = null

        /** Creates and starts the drive; [onFinished] gets the verdict text. */
        fun start(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): NextWebSession {
            val session = NextWebSession(activity)
            session.webView = webView
            instance = session
            session.start(onFinished)
            return session
        }

        /** The WebView finished a document load (UI thread, from the client). */
        fun dispatchPageFinished() = instance?.pageDidFinish()

        /** The probe's async leg result (JavaBridge thread, from the interface). */
        fun dispatchProbeResult(json: String) = instance?.onProbeResult(json)
    }

    private val eventLog = CarrierEventLog(SCENARIO)

    /** The interactive creation seat this drive verifies: credential null on
     * purpose (the scripted route answers, E2E determinism — the iOS
     * drive's rule), the creation row + commands + skills ride interactive. */
    private lateinit var serve: SessionServe

    private var onFinished: ((String) -> Unit)? = null
    private var finished = false
    private var webView: WebView? = null

    // once-guards for the seat's serving facts (the manifest pins each
    // exactly once, in this order).
    private var assetLogged = false
    private var upgradeLogged = false
    private var attachLogged = false
    private var frameLogged = false
    private val rpcLogged = HashSet<String>()

    private fun start(onFinished: (String) -> Unit) {
        this.onFinished = onFinished
        Handler(activity.mainLooper).postDelayed(
            {
                if (!finished) {
                    fail("nextweb watchdog: drive did not complete in $WATCHDOG_SECONDS s")
                }
            },
            WATCHDOG_SECONDS * 1000L,
        )
        // First record in the manifest: the launch configuration selected
        // the self-hosted client.
        eventLog.emit(
            "client.selected",
            JSONObject().put("client", SessionServe.NEXT_CLIENT_ID).put("source", "launch"),
        )
        serve = SessionServe.start(
            activity, webView,
            credential = null,
            interactive = true,
            clientID = SessionServe.NEXT_CLIENT_ID,
        )
        wireEvidence()
    }

    /** The seat's serving facts → the canonical records the manifest pins. */
    private fun wireEvidence() {
        serve.onIndexRendered = { rows, bytes ->
            eventLog.emit("index.rendered", JSONObject().put("rows", rows).put("bytes", bytes))
        }
        serve.onIndexServed = {
            eventLog.emit("index.served", JSONObject().put("path", "/").put("status", 200))
        }
        serve.onAssetServed = { path ->
            if (!assetLogged && path == "/js/main.js") {
                assetLogged = true
                eventLog.emit("asset.served", JSONObject().put("path", path))
            }
        }
        serve.onUpgradeAccepted = { path ->
            if (!upgradeLogged) {
                upgradeLogged = true
                eventLog.emit("upgrade.accepted", JSONObject().put("path", path))
            }
        }
        serve.onAPICall = { endpoint, answered -> observeRPC(endpoint, answered) }
        serve.onMuxFrame = { direction, kind -> observeMuxFrame(direction, kind) }
        serve.onRuntimeFailure = { message -> fail(message) }
    }

    /** rpc.observed: the FIRST call of each distinct endpoint. */
    private fun observeRPC(endpoint: String, answered: String) {
        if (rpcLogged.contains(endpoint)) return
        rpcLogged.add(endpoint)
        eventLog.emit(
            "rpc.observed",
            JSONObject().put("endpoint", endpoint).put("answered", answered),
        )
    }

    /** session.attached: the page's journal stream opened (our page follows
     * exactly one session); journal.frame.forwarded: the next tx item. */
    private fun observeMuxFrame(direction: String, kind: String) {
        if (direction != "tx" || kind != "item") return
        if (!attachLogged) {
            attachLogged = true
            eventLog.emit("session.attached", JSONObject().put("stream", "session/follow"))
            return
        }
        if (!frameLogged) {
            frameLogged = true
            eventLog.emit(
                "journal.frame.forwarded",
                JSONObject().put("direction", "tx").put("first", true),
            )
        }
    }

    // ---- the page drive --------------------------------------------------------

    /** The document finished loading: ONE drive chain per launch (the token
     * bounce can fire the client more than once; the first call wins, the
     * asset-wait inside re-syncs it to the real document). */
    private var probeStarted = false

    private fun pageDidFinish() {
        if (finished || probeStarted) return
        probeStarted = true
        Thread({
            // rule 8: poll the arrival condition with a deadline, fail loud
            val deadline = System.currentTimeMillis() + 30_000
            while (!assetLogged && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            if (!assetLogged) {
                fail("nextweb: the entry module never arrived")
                return@Thread
            }
            val view = webView ?: return@Thread fail("nextweb: no WebView attached")
            NextWebProbe.evaluate(view, NextWebProbe.probeScript())
            NextWebProbe.evaluate(view, "window.__next.open()")
        }, "dsh-next-probe").start()
    }

    /** JavaBridge thread: one probe leg's JSON result → its collector. */
    private fun onProbeResult(json: String) {
        if (finished) return
        val leg = try {
            JSONObject(json).optString("leg")
        } catch (_: Exception) {
            ""
        }
        val probe = NextWebProbe.parse(json, leg)
        if (probe == null) {
            fail("nextweb probe leg '$leg' returned no parseable result: ${json.take(200)}")
            return
        }
        when (leg) {
            "open" -> onOpened(probe)
            "type" -> onTyped(probe)
            "sent" -> onSent(probe)
            "reply" -> onReply(probe)
            "cancel" -> onCancel(probe)
            "card" -> onCard(probe)
            "viewer" -> onViewer(probe)
            else -> fail("nextweb probe: unknown leg '$leg'")
        }
    }

    /** The open leg's verdict: the chat view must be live. */
    private fun onOpened(probe: JSONObject) {
        if (probe.optBoolean("chatVisible") != true) {
            fail("the chat view never appeared through the new-session card")
            return
        }
        eventLog.emit("client.opened", JSONObject().put("chatVisible", true))
        evaluate("window.__next.type('${NextWebProbe.MESSAGE_TEXT}')")
    }

    /** The type leg's verdict: the composer carries the text and its send
     * button is enabled (the composer's own listener owns that). */
    private fun onTyped(probe: JSONObject) {
        if (probe.optBoolean("found") != true || probe.optBoolean("sendEnabled") != true) {
            fail("the composer never took the message (found: ${probe.optBoolean("found")}, " +
                "sendEnabled: ${probe.optBoolean("sendEnabled")})")
            return
        }
        eventLog.emit(
            "composer.typed",
            JSONObject()
                .put("found", true)
                .put("sendEnabled", true)
                .put("text", NextWebProbe.MESSAGE_TEXT),
        )
        evaluate("window.__next.send()")
    }

    private fun onSent(probe: JSONObject) {
        if (probe.optBoolean("pressed") != true) {
            fail("probe send never fired")
            return
        }
        evaluate("window.__next.reply('${NextWebProbe.EXPECTED_REPLY}')")
    }

    /** The reply leg's verdict: the user bubble rendered AND the scripted
     * assistant reply promoted (the streaming tail gone). */
    private fun onReply(probe: JSONObject) {
        if (probe.optBoolean("settled") != true) {
            fail("the first turn never settled (user: ${probe.optBoolean("userShown")}, " +
                "assistant: ${probe.optString("assistant").take(60)})")
            return
        }
        eventLog.emit(
            "page.rendered",
            JSONObject()
                .put("items", probe.optInt("items"))
                .put("reply", NextWebProbe.EXPECTED_REPLY)
                .put("userText", NextWebProbe.MESSAGE_TEXT)
                .put("title", probe.optString("title")),
        )
        evaluate("window.__next.cancel('${NextWebProbe.CANCEL_MESSAGE_TEXT}')")
    }

    /** The cancel leg's verdict: the stop affordance was shown mid-drip,
     * pressed, and the composer's toast confirms the runtime accepted it
     * (已请求停止 shows only on ok:true — never a faked success). */
    private fun onCancel(probe: JSONObject) {
        val toast = probe.optString("toast")
        if (probe.optString("fail").isNotEmpty()) {
            fail(probe.optString("fail"))
            return
        }
        if (probe.optBoolean("stopShown") != true || probe.optBoolean("stopPressed") != true) {
            fail("the stop affordance never appeared mid-drip (stopShown: " +
                "${probe.optBoolean("stopShown")})")
            return
        }
        eventLog.emit(
            "cancel.stop.pressed",
            JSONObject().put("stopShown", true).put("stopPressed", true),
        )
        if (toast != "已请求停止") {
            fail("the cancel never settled (toast: '$toast')")
            return
        }
        eventLog.emit("cancel.settled", JSONObject().put("accepted", true))
        evaluate("window.__next.card('${NextWebProbe.CREATE_MESSAGE_TEXT}')")
    }

    /** The card leg's verdict: the creation card rendered with the whale
     * deliverable's description as its title. */
    private fun onCard(probe: JSONObject) {
        if (probe.optString("fail").isNotEmpty()) {
            fail("${probe.optString("fail")} (dump: ${probe.optString("dump").take(400)})")
            return
        }
        if (probe.optBoolean("creationCard") != true) {
            fail("the creation card never rendered (dump: ${probe.optString("dump").take(500)})")
            return
        }
        eventLog.emit(
            "creation.card.rendered",
            JSONObject().put("title", NextWebProbe.CARD_TITLE).put("items", probe.optInt("items", 0)),
        )
        evaluate("window.__next.viewer()")
    }

    /** The viewer leg's verdict: the fullscreen viewer opened and the frame
     * carries the file's own content (the staged canary proves the
     * workspaceFiles/read fetch served the created file). */
    private fun onViewer(probe: JSONObject) {
        val srcdoc = probe.optString("srcdoc")
        if (probe.optBoolean("open") != true || !srcdoc.contains(NextWebProbe.CANARY)) {
            fail("the creation viewer never carried the file (open: " +
                "${probe.optBoolean("open")}, srcdoc: ${srcdoc.take(60)})")
            return
        }
        eventLog.emit("creation.opened", JSONObject().put("srcdocContains", NextWebProbe.CANARY))
        finish(true, "")
    }

    /** Evaluates one probe call on the page (UI thread hop inside). */
    private fun evaluate(script: String) {
        val view = webView ?: return fail("nextweb: no WebView attached")
        NextWebProbe.evaluate(view, script)
    }

    // ---- settling ---------------------------------------------------------------

    private fun fail(message: String) {
        Log.i(TAG, "nextweb FAIL $message")
        finish(false, message)
    }

    private fun finish(passed: Boolean, error: String) {
        if (finished) return
        finished = true
        val line = "$SCENARIO ${if (passed) "PASS" else "FAIL"} | $ENGINE_LABEL" +
            (if (error.isEmpty()) "" else " | error: $error")
        Log.i(RESULT_TAG, line)
        Log.i(RESULT_TAG, "ALL ${if (passed) "PASS" else "FAIL"}")
        serve.stop()
        instance = null
        val verdict = line
        activity.runOnUiThread { onFinished?.invoke(verdict) }
    }
}
