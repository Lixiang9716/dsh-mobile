package com.dshmobile.host

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONObject

/**
 * CardSurface — the NATIVE half of the plugin card contract on Android
 * (Kotlin sibling of hosts/ios CardPlayerSurface.swift, #452's PiP shape):
 * a plugin speaks bus lines (`card.present` / `card.state` / `card.dismiss`
 * / `card.complete`) and this surface renders them as a floating card over
 * the app's own chrome — the plugin manifests in the app, not as a web page.
 *
 * PiP posture (#452's UX fix): the card anchors TOP-END under the status
 * bar — never over the bottom-docked composer — and is DRAGGABLE anywhere
 * within the overlay and LOCALLY closable (the ✕). Dismissal authority
 * stays the plugin's per the contract: a locally closed card ignores later
 * card.state/complete records and the next card.present re-shows it. No
 * contract change.
 *
 * Timer cards tick locally between authoritative card.state patches (a
 * 250 ms handler re-renders the countdown from the anchor). Main-thread
 * only for [handle]; [snapshot] is thread-safe (it reads a volatile face
 * record) so the /api/state seam can call it from a connection thread.
 */
class CardSurface private constructor(activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    /** The overlay the card floats in (the activity's content, above the WebView). */
    private val overlay = FrameLayout(activity)
    /** The presented card's projected face — volatile: read cross-thread. */
    @Volatile private var face = JSONObject().put(
        "card", JSONObject().put("attached", true).put("visible", false),
    )

    companion object {
        /** Attaches the overlay above everything in the activity's content. */
        fun attach(activity: Activity): CardSurface {
            val surface = CardSurface(activity)
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            content.addView(
                surface.overlay,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            return surface
        }
    }

    // ---- the four contract events (main thread) -----------------------------

    /** One bus card.* record, already hopped onto the main thread. */
    fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "card.present" -> present(msg)
            "card.state" -> state(msg)
            "card.complete" -> complete(msg)
            "card.dismiss" -> dismiss()
        }
    }

    /** The projected face for the GET /api/state seam (any thread). */
    fun snapshot(): JSONObject = JSONObject(face.toString())

    // ---- the contract events, rendered ---------------------------------------

    private var cardBox: FrameLayout? = null
    private lateinit var titleView: TextView
    private lateinit var timeView: TextView
    private lateinit var subtitleView: TextView
    private lateinit var progress: ProgressBar
    private var card = JSONObject()
    private var remainingMs = 0.0
    private var anchorAt = 0L
    private var ticking = false
    /** The drag's start point: raw touch + the translation at ACTION_DOWN. */
    private var dragStart: FloatArray? = null

    private fun present(msg: JSONObject) {
        val record = msg.optJSONObject("card") ?: return
        val id = record.optString("id")
        if (id.isEmpty()) return
        card = record
        remainingMs = record.optDouble("durationMs", 0.0)
        anchorAt = System.currentTimeMillis()
        showCard(
            id = id,
            title = record.optString("title", id),
            subtitle = record.optString("subtitle", ""),
            kind = record.optString("kind", "info"),
        )
        projectFace()
        GatewayCore.uiMarker("card-present", "wait")
    }

    private fun state(msg: JSONObject) {
        if (cardBox == null) return
        val patch = msg.optJSONObject("state") ?: return
        val remaining = patch.optDouble("remainingMs", Double.NaN)
        if (!remaining.isNaN()) {
            remainingMs = remaining
            anchorAt = System.currentTimeMillis()
        }
        val label = patch.optString("label", "")
        if (label.isNotEmpty()) subtitleView.text = label
        render()
        projectFace()
    }

    private fun complete(msg: JSONObject) {
        if (cardBox == null) return
        remainingMs = 0.0
        subtitleView.text = msg.optString("message", "完成")
        render()
        GatewayCore.uiMarker("card-present", "done")
        main.postDelayed({ dismiss() }, 2_500)
    }

    private fun dismiss() {
        stopTick()
        cardBox?.let { overlay.removeView(it) }
        cardBox = null
        projectFace()
    }

    // ---- rendering ------------------------------------------------------------

    private fun showCard(id: String, title: String, subtitle: String, kind: String) {
        dismiss()
        val activity = overlay.context as Activity
        val density = activity.resources.displayMetrics.density

        fun cardText(size: Float, bold: Boolean = false) = TextView(activity).apply {
            textSize = size
            gravity = Gravity.CENTER
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

        buildViews(activity, kind, subtitle)
        val close = buildClose(activity)
        val content = buildContent(activity)

        val box = FrameLayout(activity).apply {
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#F2F1F0"))
                cornerRadius = 18f * density
            }
            elevation = 10f * density
            addView(content, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(close, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = Gravity.TOP or Gravity.END })
            setOnTouchListener(touchDrag)
        }

        overlay.addView(box, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            topMargin = (40 * density).toInt()
            marginEnd = (12 * density).toInt()
        })
        cardBox = box
        startTick()
        render()
    }

    /** Builds the card's views (title/time/progress/subtitle) per kind. */
    private fun buildViews(activity: Activity, kind: String, subtitle: String) {
        fun cardText(size: Float, bold: Boolean = false) = TextView(activity).apply {
            textSize = size
            gravity = Gravity.CENTER
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

        titleView = cardText(15f, bold = true)
        timeView = cardText(if (kind == "timer") 34f else 18f, bold = true)
        subtitleView = cardText(12f).apply {
            text = subtitle
            setTextColor(Color.parseColor("#6B6B6B"))
        }
        progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 10_000
            if (kind != "timer") alpha = 0f
        }
    }

    /** The ✕ close control. */
    private fun buildClose(activity: Activity): TextView = TextView(activity).apply {
        text = "✕"
        textSize = 15f
        val d = activity.resources.displayMetrics.density
        setPadding((6 * d).toInt(), (2 * d).toInt(), (6 * d).toInt(), (2 * d).toInt())
        setOnClickListener { dismiss() }
    }

    /** The card's content column (title/time/progress/subtitle). */
    private fun buildContent(activity: Activity): LinearLayout {
        val pad = fun(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
        return LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad(16), pad(14), pad(16), pad(12))
            for (sub in listOf(titleView, timeView, progress, subtitleView)) {
                addView(sub, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT))
            }
        }
    }

    /** The touch drag: reposition the floating card within the overlay. */
    private val touchDrag = View.OnTouchListener { view, event ->
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragStart = floatArrayOf(event.rawX, event.rawY,
                    view.translationX, view.translationY)
                true
            }
            MotionEvent.ACTION_MOVE -> {
                val start = dragStart ?: return@OnTouchListener false
                view.translationX = start[2] + (event.rawX - start[0])
                view.translationY = start[3] + (event.rawY - start[1])
                true
            }
            else -> false
        }
    }

    private fun startTick() {
        if (ticking) return
        ticking = true
        main.post(object : Runnable {
            override fun run() {
                if (!ticking) return
                render()
                main.postDelayed(this, 250)
            }
        })
    }

    private fun stopTick() {
        ticking = false
    }

    private fun render() {
        val view = cardBox ?: return
        if (card.optString("kind") != "timer") {
            timeView.text = card.optString("label", subtitleView.text.toString())
            return
        }
        val elapsed = System.currentTimeMillis() - anchorAt
        val current = (remainingMs - elapsed).coerceAtLeast(0.0)
        val seconds = (current / 1000).toInt()
        timeView.text = String.format("%02d:%02d", seconds / 60, seconds % 60)
        val total = card.optDouble("durationMs", 0.0)
        if (total > 0) {
            progress.progress = ((1 - current / total) * 10_000).toInt().coerceIn(0, 10_000)
        }
        view.tag = seconds
    }

    /** Projects the face the /api/state seam reads (volatile, cross-thread). */
    private fun projectFace() {
        val cardFace = JSONObject()
            .put("attached", true)
            .put("visible", cardBox != null)
        if (cardBox != null) {
            cardFace.put("id", card.optString("id"))
            cardFace.put("title", card.optString("title"))
            cardFace.put("kind", card.optString("kind", "info"))
        }
        face = JSONObject().put("card", cardFace)
    }
}
