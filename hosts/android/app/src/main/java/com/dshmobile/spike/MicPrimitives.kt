package com.dshmobile.spike

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import org.json.JSONObject

/**
 * The capability plane's microphone face (v1.10.0 candidate; grant family
 * `microphone`) — Kotlin sibling of hosts/ios Gateway/MicPrimitives.swift:
 * micStart/micStop control + the mic.frame channel over the bridge event
 * plumbing. Two consent layers, gateway first — the manifest's family grant
 * reached here means the caller is approved at the gateway layer, so the OS
 * prompt (RECORD_AUDIO, a runtime request) is the second and last one; an
 * OS refusal resolves `null` (a value, the clipboard-decline posture), and
 * the audit's detail names the refusing layer. Frames are pcm-s16le mono
 * chunks delivered as bridge events (`mic.frame` / `mic.end`, payload bytes
 * base64 — the frozen bridge convention). Pressure discipline (D8): the
 * reader thread enqueues into a bounded ring with seq minted per captured
 * chunk — a chunk dropped by a full ring leaves an honest seq gap, never a
 * growing queue — and one coalesced drain forwards the ring FIFO onto the
 * runtime queue ([SpikeRuntime.post]; the emitFn hop lands there). The end
 * event publishes exactly once, after the last forwarded frame.
 */
class MicPrimitives(private val activity: android.app.Activity) {

    companion object {
        const val REQUEST_RECORD = 4100
        private const val RING_CAP = 16
        private const val SAMPLE_RATE_RANGE_FIRST = 8000.0
        private const val SAMPLE_RATE_RANGE_LAST = 48000.0
        private const val FRAME_MS_RANGE_FIRST = 10.0
        private const val FRAME_MS_RANGE_LAST = 200.0
    }

    private lateinit var core: GatewayCore

    /** Wired by the host session: delivers one bridge event (the runtime hop). */
    var emitFn: ((json: String) -> Unit)? = null

    private val lock = Object()
    private var stream: MicStream? = null

    private class MicStream(val id: String) {
        var record: AudioRecord? = null
        var thread: Thread? = null
        val startedAt: Long = android.os.SystemClock.elapsedRealtime()
        var seq = 0
        var bytes = 0
        var pending = ArrayDeque<Pair<Int, ByteArray>>()
        var draining = false
        var stopped = false
        var endPublished = false
    }

    fun register(on: GatewayCore) {
        core = on
        on.register("micStart") { call, done -> start(call, done) }
        on.register("micStop") { call, done -> stop(call, done) }
    }

    // ---- micStart (armed, not flowing — the timerSchedule posture) -----------

    private fun start(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val format = call.string("format") ?: "pcm-s16le"
        if (format != "pcm-s16le") {
            return done.settle(null, GatewayCore.GatewayError(
                "invalid", "micStart", "unsupported format $format (v0 carries pcm-s16le only)"))
        }
        val sampleRate = clamp(call.optLong("sampleRate")?.toDouble() ?: 16000.0,
            SAMPLE_RATE_RANGE_FIRST, SAMPLE_RATE_RANGE_LAST).toInt()
        val channels = (call.optLong("channels")?.toInt() ?: 1).coerceAtLeast(1)
        if (channels != 1) {
            return done.settle(null, GatewayCore.GatewayError(
                "invalid", "micStart", "channels $channels unsupported (v0 is mono)"))
        }
        val frameMs = clamp(call.optLong("frameMs")?.toDouble() ?: 100.0,
            FRAME_MS_RANGE_FIRST, FRAME_MS_RANGE_LAST)
        core.stageAuditDetail(JSONObject()
            .put("format", format)
            .put("sampleRate", sampleRate)
            .put("frameMs", frameMs.toInt())
            .put("tag", call.string("tag") ?: JSONObject.NULL))

        val granted = activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) {
            // The OS prompt (the second layer): the activity surfaces it; the
            // answer arrives in onPermissionResult. The driver pre-grants via
            // `adb pm grant` in automation, so this path is the on-device one.
            pendingStart = PendingStart(sampleRate, frameMs)
            pendingDone = done
            activity.runOnUiThread {
                activity.requestPermissions(
                    arrayOf(android.Manifest.permission.RECORD_AUDIO),
                    REQUEST_RECORD,
                )
            }
            return
        }
        arm(sampleRate, frameMs, done)
    }

    private class PendingStart(val sampleRate: Int, val frameMs: Double)
    private var pendingStart: PendingStart? = null
    private var pendingDone: GatewayCore.Done? = null

    /** MainActivity forwards the runtime permission answer here. */
    fun onPermissionResult(requestCode: Int, results: IntArray) {
        if (requestCode != REQUEST_RECORD) return
        val pend = pendingStart
        pendingStart = null
        val done = pendingDone
        pendingDone = null
        val granted = results.isNotEmpty() &&
            results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted && pend != null && done != null) {
            arm(pend.sampleRate, pend.frameMs, done)
        } else {
            // OS layer refused: a value, not an error; the audit's detail
            // names the refusing layer (rule 2).
            core.stageAuditDetail(JSONObject().put("refused", "os"))
            done?.settle(null, null)
        }
    }

    /** Opens the AudioRecord (s16le/mono at the clamped rate) and arms the
     * reader thread; resolves { streamId } once ARMED. */
    @SuppressLint("MissingPermission") // every arm() path is behind a grant check
    private fun arm(sampleRate: Int, frameMs: Double, done: GatewayCore.Done) {
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) {
            return done.settle(null, GatewayCore.GatewayError(
                "unavailable", "micStart", "no audio input on this device (minBufferSize $minBuf)"))
        }
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC, sampleRate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, sampleRate), // >= one second of headroom
            )
        } catch (e: Exception) {
            return done.settle(null, GatewayCore.GatewayError(
                "unavailable", "micStart", "AudioRecord refused: ${e.message ?: ""}"))
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return done.settle(null, GatewayCore.GatewayError(
                "unavailable", "micStart", "AudioRecord not initialized (mic service dead?)"))
        }
        val id = "mic:" + java.util.UUID.randomUUID().toString()
        val s = MicStream(id)
        s.record = record
        synchronized(lock) { stream = s }
        record.startRecording()
        val chunkBytes = (sampleRate * 2 * frameMs / 1000.0).toInt().coerceAtLeast(2)
        val reader = Thread {
            val buf = ByteArray(chunkBytes)
            while (true) {
                val n = synchronized(lock) { if (s.stopped) -1 else 0 }
                if (n < 0) break
                val read = record.read(buf, 0, buf.size)
                if (read <= 0) break
                capture(s, buf, read)
            }
        }
        s.thread = reader
        reader.start()
        done.settle(JSONObject().put("streamId", id), null)
    }

    /** One captured chunk -> one ring entry. A full ring drops the OLDEST —
     * its seq is gone from the delivered stream, the honest gap. */
    private fun capture(s: MicStream, buf: ByteArray, n: Int) {
        val data = buf.copyOf(n)
        var needDrain = false
        synchronized(lock) {
            if (s.stopped) return
            s.seq += 1
            s.pending.addLast(s.seq to data)
            while (s.pending.size > RING_CAP) s.pending.removeFirst()
            needDrain = !s.draining
            s.draining = true
        }
        if (needDrain) drain(s)
    }

    /** Forwards the ring FIFO until empty (one drain at a time; the reader
     * re-arms). Each forwarded chunk's bytes join the stop record's count. */
    private fun drain(s: MicStream) {
        while (true) {
            val item: Pair<Int, ByteArray>? = synchronized(lock) {
                if (s.stopped || s.pending.isEmpty()) {
                    s.draining = false
                    null
                } else {
                    s.pending.removeFirst()
                }
            }
            if (item == null) return
            s.bytes += item.second.size
            emitFn?.invoke(frameEvent(s.id, item.first, item.second))
        }
    }

    /** One mic.frame bridge event (payload bytes base64 — the frozen
     * bridge convention). */
    private fun frameEvent(streamId: String, seq: Int, bytes: ByteArray): String =
        JSONObject()
            .put("event", "mic.frame")
            .put("streamId", streamId)
            .put("seq", seq)
            .put("bytesB64", android.util.Base64.encodeToString(
                bytes, android.util.Base64.NO_WRAP))
            .toString()

    // ---- micStop (idempotent, the record that carries duration + bytes) ------

    private fun stop(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val id = call.string("streamId")
        if (id == null) {
            return done.settle(null, GatewayCore.GatewayError(
                "invalid", "micStop", "streamId missing"))
        }
        val s: MicStream? = synchronized(lock) {
            val cur = stream
            if (cur?.id == id) {
                stream = null
                cur
            } else {
                null
            }
        }
        if (s == null || s.stopped) {
            // unknown or already-stopped id: the timerCancel shape
            return done.settle(
                JSONObject().put("stopped", false).put("durationMs", 0).put("bytes", 0), null)
        }
        halt(s, "stopped")
        val durationMs = (android.os.SystemClock.elapsedRealtime() - s.startedAt).toInt()
        core.stageAuditDetail(
            JSONObject().put("durationMs", durationMs).put("bytes", s.bytes))
        done.settle(
            JSONObject().put("stopped", true).put("durationMs", durationMs)
                .put("bytes", s.bytes),
            null,
        )
    }

    /** Stops capture, drains what remains IN ORDER, then publishes the end
     * event exactly once. */
    private fun halt(s: MicStream, reason: String) {
        synchronized(lock) { s.stopped = true }
        try {
            s.record?.stop()
        } catch (_: Exception) {
        }
        s.record?.release()
        s.record = null
        drain(s) // synchronous: the reader thread's next capture observes stopped
        synchronized(lock) {
            if (s.endPublished) return
            s.endPublished = true
        }
        emitFn?.invoke(
            JSONObject()
                .put("event", "mic.end")
                .put("streamId", s.id)
                .put("reason", reason)
                .toString(),
        )
    }

    private fun clamp(v: Double, lo: Double, hi: Double): Double = v.coerceIn(lo, hi)
}
