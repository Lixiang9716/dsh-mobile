package com.dshmobile.host

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.DocumentsContract
import java.io.File
import org.json.JSONObject

/**
 * The v1.5.0 device-plane primitives that need no user-consent surface —
 * Kotlin sibling of hosts/ios Gateway/DevicePlanePrimitives.swift:
 * deviceInfo (read-only facts), haptic (one cue per call), keepAwake (the
 * boolean screen latch) and presentShare (the system share sheet — the
 * sheet IS the per-call consent; the host learns only that it completed,
 * never the destination). clipboardRead/Write live in ClipboardPrimitives.
 * Audit detail carries only the closed-vocabulary facts the §6 table names
 * (pattern / hold / share kind) — never payload contents.
 */
class DevicePlanePrimitives(
    private val activity: Activity,
    private val fs: FsPrimitives,
) {

    private lateinit var core: GatewayCore

    companion object {
        const val REQUEST_SHARE = 4004
        private val HAPTIC_PATTERNS =
            setOf("light", "medium", "heavy", "rigid", "soft", "selection", "success", "warning", "error")
    }

    fun register(on: GatewayCore) {
        core = on
        on.register("deviceInfo") { call, done -> deviceInfo(call, done) }
        on.register("haptic") { call, done -> haptic(call, done) }
        on.register("keepAwake") { call, done -> keepAwake(call, done) }
        on.register("presentShare") { call, done -> share(call, done) }
    }

    // ---- deviceInfo ----------------------------------------------------------

    private fun deviceInfo(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val versionName = try {
            activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
        val battery = batteryInfo()
        val info = JSONObject()
            .put("platform", "android")
            .put("model", Build.MODEL)
            .put("osVersion", Build.VERSION.RELEASE)
            .put("appVersion", versionName)
            .put(
                "screen",
                JSONObject()
                    .put("width", activity.resources.displayMetrics.widthPixels.toDouble())
                    .put("height", activity.resources.displayMetrics.heightPixels.toDouble())
                    .put("scale", activity.resources.displayMetrics.density.toDouble()),
            )
            .put("lowPowerMode", powerManager().isPowerSaveMode)
            .put("locale", activity.resources.configuration.locales[0].toLanguageTag())
            .put("timezone", java.util.TimeZone.getDefault().id)
        if (battery != null) info.put("battery", battery)
        core.stageAuditDetail(JSONObject().put("platform", "android"))
        done.settle(info, null)
    }

    /** The battery dict, or null where the OS hides it (unknown capacity —
     * the one field a host may omit, contract §4 device plane). */
    private fun batteryInfo(): JSONObject? {
        val manager = activity.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            ?: return null
        val level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        if (level !in 0..100) return null
        val sticky = activity.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val state = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "unplugged"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
            else -> "unknown"
        }
        return JSONObject().put("level", level / 100.0).put("state", state)
    }

    private fun powerManager() =
        activity.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager

    // ---- haptic --------------------------------------------------------------

    private fun haptic(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val pattern = call.string("pattern")
            ?: return done.settle(null, GatewayCore.GatewayError("invalid", "haptic", "pattern missing"))
        if (pattern !in HAPTIC_PATTERNS) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "unavailable", "haptic", "pattern not expressible on this platform: $pattern",
                ),
            )
        }
        val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (vibrator == null || !vibrator.hasVibrator()) {
            return done.settle(
                null,
                GatewayCore.GatewayError("unavailable", "haptic", "no vibrator on this device"),
            )
        }
        vibrator.vibrate(effect(pattern))
        core.stageAuditDetail(JSONObject().put("pattern", pattern))
        done.settle(null, null)
    }

    /** Maps the closed vocabulary onto one-shot / waveform compositions —
     * API-26-safe primitives only (createOneShot / createWaveform). */
    private fun effect(pattern: String): VibrationEffect = when (pattern) {
        "light" -> VibrationEffect.createOneShot(20, 64)
        "medium" -> VibrationEffect.createOneShot(35, 128)
        "heavy" -> VibrationEffect.createOneShot(50, 255)
        "rigid" -> VibrationEffect.createOneShot(30, 255)
        "soft" -> VibrationEffect.createOneShot(40, 96)
        "selection" -> VibrationEffect.createOneShot(15, 48)
        "success" -> VibrationEffect.createWaveform(longArrayOf(0, 40, 60, 40), -1)
        "warning" -> VibrationEffect.createWaveform(longArrayOf(0, 30, 50, 30, 50, 30), -1)
        else -> VibrationEffect.createWaveform(longArrayOf(0, 60, 80, 60, 80, 60), -1)
    }

    // ---- keepAwake -----------------------------------------------------------

    private fun keepAwake(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val hold = call.args.optBoolean("hold", false)
        activity.runOnUiThread {
            if (hold) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        core.stageAuditDetail(JSONObject().put("hold", hold))
        done.settle(null, null)
    }

    // ---- presentShare --------------------------------------------------------

    /** The share sheet is the OS's own trust boundary: the payload leaves and
     * only the completion comes back. Files resolve through the fs scope
     * discipline — each path is "<scopeHandle>:<scope-relative path>" (the
     * same (scope, path) pair fsRead takes, joined with a colon); anything
     * outside a granted scope is denied before the sheet appears. */
    private fun share(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val kind = call.string("kind") ?: ""
        val intent: Intent = when (kind) {
            "text" -> textIntent(call.string("text") ?: "")
            "url" -> textIntent(call.string("url") ?: "")
            "files" -> filesIntent(call, done) ?: return
            else -> return done.settle(null, invalidKind())
        }
        core.stageAuditDetail(JSONObject().put("kind", kind))
        GatewayCore.uiMarker("share", "wait")
        activity.startActivityForResult(Intent.createChooser(intent, "Share via"), REQUEST_SHARE)
        shareDone = done
    }

    /** The pending share settle — the sheet completes on the activity result. */
    private var shareDone: GatewayCore.Done? = null

    private fun badPath(path: String) = GatewayCore.GatewayError(
        "invalid", "presentShare", "path must be \"<scope>:<relative path>\": $path",
    )

    private fun outsideScope(path: String) = GatewayCore.GatewayError(
        "denied", "presentShare", "path outside a granted scope: $path",
    )

    private fun invalidKind() = GatewayCore.GatewayError(
        "invalid", "presentShare", "share payload kind must be text | url | files",
    )

    private fun textIntent(text: String): Intent =
        Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)

    /** Resolves the files payload against the granted scopes; settles and
     * returns null on any malformed or ungranted path. */
    private fun filesIntent(call: GatewayCore.GatewayCall, done: GatewayCore.Done): Intent? {
        val paths = call.args.optJSONArray("paths")?.let { array ->
            (0 until array.length()).map { array.optString(it) }
        }
        if (paths.isNullOrEmpty()) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "presentShare", "files payload expects a non-empty paths array"))
            return null
        }
        val uris = ArrayList<Uri>()
        for (path in paths) {
            val (scope, rel) = splitScopePath(path) ?: run {
                done.settle(null, badPath(path))
                return null
            }
            val uri = shareUri(scope, rel) ?: run {
                done.settle(null, outsideScope(path))
                return null
            }
            uris.add(uri)
        }
        val send = Intent(Intent.ACTION_SEND_MULTIPLE)
            .setType("application/octet-stream")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return send
    }

    /** App-scope files stage through ShareFilesProvider (a bare framework
     * ContentProvider — no androidx); SAF user-scope documents share their
     * own content:// URI. A plain file:// would crash the share target. */
    private fun shareUri(scope: String, rel: String): Uri? {
        if (scope == "app") {
            val index = ShareFilesProvider.stage(File(activity.filesDir, "profiles/default/$rel"))
            return Uri.parse("content://$ShareFilesProvider.AUTHORITY/$index")
        }
        val tree = fs.userScopeTree(scope) ?: return null
        return DocumentsContract.buildDocumentUriUsingTree(tree, documentId(tree, rel) ?: return null)
    }

    /** Walks the SAF tree's relative path to the leaf document id. */
    private fun documentId(tree: Uri, rel: String): String? {
        var parent = DocumentsContract.getTreeDocumentId(tree)
        for (segment in rel.split('/').filter { it.isNotEmpty() }) {
            parent = childId(tree, parent, segment) ?: return null
        }
        return parent
    }

    private fun childId(tree: Uri, parent: String, segment: String): String? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        val projection = arrayOf(
            android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        )
        val cursor = activity.contentResolver.query(children, projection, null, null, null)
            ?: return null
        cursor.use {
            while (it.moveToNext()) {
                if (it.getString(1) == segment) return it.getString(0)
            }
        }
        return null
    }

    /** Splits "<scope>:<relative path>" into the fsRead argument pair. */
    private fun splitScopePath(path: String): Pair<String, String>? {
        val at = path.indexOf(':')
        if (at <= 0) return null
        val scope = path.substring(0, at)
        val rel = FsPrimitives.safeRelative(path.substring(at + 1)) ?: return null
        return scope to rel
    }

    /** The share sheet's activity result: completed vs. the user walking
     * away — a value either way, never an error. */
    fun onShareResult(resultCode: Int) {
        val done = shareDone
        shareDone = null
        ShareFilesProvider.clear()
        GatewayCore.uiMarker("share", "done")
        done?.settle(JSONObject().put("shared", resultCode == Activity.RESULT_OK), null)
    }
}
