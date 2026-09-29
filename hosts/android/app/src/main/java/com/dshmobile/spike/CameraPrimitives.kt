package com.dshmobile.spike

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * The system capability plane's camera family (proposal v1.10.0) — Kotlin
 * sibling of hosts/ios Gateway/CameraPrimitives.swift. The capture BURST
 * (`cameraCapture`) is the v1 implementation face: frames land in the app's
 * capture scope (the v1.5.0 media-picks read-through posture — scope "app",
 * path "media-picks/<name>", bytes ordinary files fsRead reads back) and the
 * whole burst is one call, one audit record (count, total bytes, flash,
 * duration). The recording rows (`cameraRecordStart`/`Stop`) are registered
 * to answer `unavailable` — their shape is contract, their implementation is
 * phased. Two consent layers, gateway first: the manifest's `camera` family
 * grant reaches this handler only after the gateway's own check; the OS
 * runtime prompt is the second layer, and an OS refusal resolves null —
 * never a silent substitute. A device with no camera rejects `unavailable`.
 */
class CameraPrimitives(
    private val activity: Activity,
    @Suppress("unused") private val fs: FsPrimitives,
) {

    private lateinit var core: GatewayCore

    companion object {
        const val REQUEST_CAMERA = 4101
        /** Host-declared burst range (the proposal's "host clamps to a
         * declared range"); the audit carries requested and honored counts. */
        const val MAX_BURST = 8
        private val FLASH_MODES = setOf("off", "auto", "on")
    }

    fun register(on: GatewayCore) {
        core = on
        on.register("cameraCapture") { call, done -> capture(call, done) }
        on.register("cameraRecordStart") { _, done -> phased("cameraRecordStart", done) }
        on.register("cameraRecordStop") { _, done -> phased("cameraRecordStop", done) }
    }

    /** The permission resume (MainActivity routes it here). */
    fun onPermissionResult(granted: Boolean) {
        val pending = synchronized(stateLock) { pendingPermission }
        if (pending == null) return
        synchronized(stateLock) { pendingPermission = null }
        if (granted) startBurst(pending) else pending.settleRefusal()
    }

    // ---- cameraCapture -------------------------------------------------------

    private val stateLock = Any()
    private var pendingPermission: Burst? = null

    private fun capture(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val requested = if (call.args.has("count") && !call.args.isNull("count")) call.args.getInt("count") else 1
        val count = requested.coerceIn(1, MAX_BURST)
        val flash = call.string("flash") ?: "auto"
        if (flash !in FLASH_MODES) {
            return done.settle(
                null,
                GatewayCore.GatewayError("invalid", "cameraCapture", "flash must be off | auto | on: $flash"),
            )
        }
        val maxBytes = if (call.args.has("maxBytes") && !call.args.isNull("maxBytes")) call.args.getInt("maxBytes") else null
        val manager = activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = pickCamera(manager)
            ?: return done.settle(
                null,
                GatewayCore.GatewayError("unavailable", "cameraCapture", "no camera on this device"),
            )
        val burst = Burst(count, flash, maxBytes, requested, done)
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            burst.manager = manager
            burst.cameraId = cameraId
            startBurst(burst)
        } else {
            synchronized(stateLock) { pendingPermission = burst }
            GatewayCore.uiMarker("camera-permission", "wait")
            activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    /** The first back-facing camera, else the first of any facing (the
     * emulator's virtual cameras pass FEATURE_CAMERA_ANY either way). */
    private fun pickCamera(manager: CameraManager): String? {
        val all = manager.cameraIdList
        for (id in all) {
            val facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)
            if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                return id
            }
        }
        return all.firstOrNull()
    }

    @SuppressLint("MissingPermission") // every caller holds the grant
    private fun startBurst(burst: Burst) {
        val manager = burst.manager ?: activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = burst.cameraId ?: pickCamera(manager) ?: return burst.failUnavailable()
        val characteristics = manager.getCameraCharacteristics(cameraId)
        val size = pickSize(characteristics)
        if (size == null) return burst.failUnavailable()
        val thread = HandlerThread("dsh-camera").apply { start() }
        val handler = Handler(thread.looper)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        burst.attach(thread)
        reader.setOnImageAvailableListener({ reader -> onFrame(reader, burst) }, handler)
        try {
            manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) = burst.onOpened(camera, reader, size, handler)
                override fun onDisconnected(camera: CameraDevice) { camera.close(); burst.failUnavailable() }
                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close(); burst.failUnavailable()
                }
            }, handler)
        } catch (e: SecurityException) {
            burst.failUnavailable()
        } catch (e: IllegalArgumentException) {
            burst.failUnavailable()
        }
    }

    /** The largest JPEG output at or under FullHD — a deterministic, bounded
     * choice; the frames' real dimensions ride each CapturedPhoto. */
    private fun pickSize(characteristics: CameraCharacteristics): Size? {
        val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val fullHd = 1920 * 1080
        return map.getOutputSizes(ImageFormat.JPEG)
            ?.sortedByDescending { it.width * it.height }
            ?.firstOrNull { it.width * it.height <= fullHd }
    }

    private fun onFrame(reader: ImageReader, burst: Burst) {
        val shot: Image = reader.acquireLatestImage() ?: return
        val plane: Image.Plane = shot.planes[0]
        val buf: java.nio.ByteBuffer = plane.buffer
        val data = ByteArray(buf.remaining())
        buf.get(data)
        val width: Int = shot.width
        val height: Int = shot.height
        shot.close()
        burst.onFrame(data, width, height)
    }

    // ---- the burst accumulator -------------------------------------------------

    /** One burst's state: the frames, the audit facts, the settle. */
    private inner class Burst(
        private val count: Int,
        private val flash: String,
        private val maxBytes: Int?,
        private val requested: Int,
        private val done: GatewayCore.Done,
    ) {
        var manager: CameraManager? = null
        var cameraId: String? = null
        private val photos = JSONArray()
        private var totalBytes = 0
        private var dropped = 0
        private var remaining = count
        private val startedAt = System.currentTimeMillis()
        private var device: CameraDevice? = null
        private var reader: ImageReader? = null
        private var thread: HandlerThread? = null
        private var settled = false

        fun attach(thread: HandlerThread) { this.thread = thread }

        fun onOpened(camera: CameraDevice, reader: ImageReader, size: Size, handler: Handler) {
            device = camera
            this.reader = reader
            try {
                val session = camera.createCaptureSession(listOf(reader.surface),
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            shootAll(s, size, handler)
                        }
                        override fun onConfigureFailed(s: CameraCaptureSession) = failUnavailable()
                    }, handler)
            } catch (e: Exception) {
                failUnavailable()
            }
        }

        /** The still-capture request repeated `count` times; the flash mode
         * is honored where the AE table supports it, clamped honestly where
         * it does not (the audit names the decision). A FAILED capture is a
         * dropped frame, never a hang — the callback resumes the countdown. */
        private fun shootAll(session: CameraCaptureSession, size: Size, handler: Handler) {
            val device = this.device ?: return failUnavailable()
            val aeFlash = when (flash) {
                "on" -> CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH
                "auto" -> CaptureRequest.CONTROL_AE_MODE_ON_AUTO_FLASH
                else -> CaptureRequest.CONTROL_AE_MODE_ON
            }
            val failureCallback = object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureFailed(
                    session: CameraCaptureSession,
                    request: CaptureRequest,
                    failure: android.hardware.camera2.CaptureFailure,
                ) {
                    burstOnFailedFrame()
                }
            }
            for (i in 0 until count) {
                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                    .apply {
                        addTarget(reader!!.surface)
                        set(CaptureRequest.CONTROL_AE_MODE, aeFlash)
                    }
                session.capture(request.build(), failureCallback, handler)
            }
        }

        fun onFrame(bytes: ByteArray, width: Int, height: Int) {
            synchronized(this) {
                if (settled || remaining <= 0) return
                if (maxBytes != null && bytes.size > maxBytes) {
                    dropped += 1 // an over-cap frame is dropped, never truncated
                } else {
                    photos.put(landFrame(bytes, width, height))
                    totalBytes += bytes.size
                }
                remaining -= 1
                if (remaining > 0) return
                settled = true
            }
            finishBurst()
        }

        /** The capture-failure resume: a dropped frame advances the countdown
         * (the reader's onImageAvailable never fires for a failed capture). */
        fun burstOnFailedFrame() {
            synchronized(this) {
                if (settled || remaining <= 0) return
                dropped += 1
                remaining -= 1
                if (remaining > 0) return
                settled = true
            }
            finishBurst()
        }

        private fun finishBurst() {
            teardown()
            val elapsed = (System.currentTimeMillis() - startedAt).toInt()
            core.stageAuditDetail(
                JSONObject()
                    .put("count", photos.length())
                    .put("requested", requested)
                    .put("totalBytes", totalBytes)
                    .put("dropped", dropped)
                    .put("flash", flash)
                    .put("durationMs", elapsed),
            )
            done.settle(JSONObject().put("photos", photos), null)
        }

        /** One frame's CapturedPhoto: written into the capture scope (the
         * media-picks directory), read back through the granted "app" scope. */
        private fun landFrame(bytes: ByteArray, width: Int, height: Int): JSONObject {
            val dir = File(activity.filesDir, "profiles/default/media-picks").apply { mkdirs() }
            val name = "capture-%s.jpg".format(UUID.randomUUID().toString().substring(0, 8))
            File(dir, name).writeBytes(bytes)
            return JSONObject()
                .put("scope", "app")
                .put("path", "media-picks/$name")
                .put("bytes", bytes.size)
                .put("width", width)
                .put("height", height)
                .put("format", "jpeg")
                .put("capturedAt", isoNow())
        }

        fun settleRefusal() {
            core.stageAuditDetail(JSONObject().put("count", 0).put("refused", "os"))
            done.settle(null, null) // OS-layer refusal is a value (resolves null)
        }

        fun failUnavailable() {
            synchronized(this) {
                if (settled) return
                settled = true
            }
            teardown()
            done.settle(
                null,
                GatewayCore.GatewayError("unavailable", "cameraCapture", "camera capture unavailable"),
            )
        }

        private fun teardown() {
            try { device?.close() } catch (_: Exception) {}
            try { reader?.close() } catch (_: Exception) {}
            thread?.quitSafely()
        }
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    // ---- the phased recording rows -------------------------------------------

    /** Shape now, implementation phased (proposal §3): the honest
     * `unavailable`, never a pretend recording. */
    private fun phased(name: String, done: GatewayCore.Done) {
        core.stageAuditDetail(JSONObject().put("phased", true))
        done.settle(
            null,
            GatewayCore.GatewayError(
                "unavailable", name,
                "phased — the capture burst is the v1 implementation face",
            ),
        )
    }
}
