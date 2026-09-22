package com.dshmobile.spike

import android.util.Base64
import org.json.JSONObject
import java.io.File

/**
 * The `agentPresets.seed` bus delivery for the write seat: the staged presets
 * tree plus one node_modules resolution marker per staged dsh package — the
 * same rule the iOS drive's `agentPresetsSeedDelivery` and
 * `runtime/spike/ci/gen-presets-seed.py` follow (one seed rule, three
 * runtimes; T-0035). A preset row naming a package that is NOT staged stays
 * honestly `broken` (no speculative markers); a row naming a staged package
 * resolves through its marker onto the bare map's vendored tree. Null when
 * the staged tree is absent — the caller skips the delivery (the roster then
 * answers honestly from an empty tree rather than a fake one).
 */
object AgentPresetsSeed {

    private const val PRESETS_PKG = "agent-presets@0.1.6-alpha.2"
    private const val VFS_BASE = "/vendor/dsh/$PRESETS_PKG"
    private const val MARKER_SPIKE = "resolution marker (the bare map vendors this package)"

    fun build(spikeRoot: File): JSONObject? {
        val vendorRoot = File(spikeRoot, "vendor/dsh")
        val presetsRoot = File(vendorRoot, "$PRESETS_PKG/presets")
        if (!presetsRoot.isDirectory) return null
        // The web-boot consumer reads msg.files as a PATH-KEYED map
        // ({path: {b64, mtimeMs}}) — the same shape the iOS drive posts.
        val files = JSONObject()

        fun add(vfsPath: String, bytes: ByteArray) {
            files.put(
                vfsPath,
                JSONObject()
                    .put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    .put("mtimeMs", 0),
            )
        }

        // 1. The presets tree itself.
        presetsRoot.walkTopDown().filter { it.isFile }.forEach {
            val rel = it.relativeTo(presetsRoot).path.replace(File.separatorChar, '/')
            add("$VFS_BASE/presets/$rel", it.readBytes())
        }

        // 2. Resolution markers: one per staged dsh package, name+version read
        //    from the package's own staged package.json.
        val dirs = vendorRoot.listFiles { f -> f.isDirectory && f.name.contains('@') }
        dirs?.sortedBy { it.name }?.forEach { dir ->
            val manifest = File(dir, "package.json")
            if (!manifest.isFile) return@forEach
            val fields = runCatching { JSONObject(manifest.readText()) }.getOrNull() ?: return@forEach
            val name = fields.optString("name")
            val version = fields.optString("version")
            if (name.isEmpty() || version.isEmpty()) return@forEach
            val marker = JSONObject()
                .put("name", name)
                .put("version", version)
                .put("_spike", MARKER_SPIKE)
            add("$VFS_BASE/node_modules/$name/package.json", marker.toString().toByteArray())
        }

        return if (files.length() == 0) null
        else JSONObject().put("type", "agentPresets.seed").put("files", files)
    }
}
