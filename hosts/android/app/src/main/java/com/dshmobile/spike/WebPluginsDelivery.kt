package com.dshmobile.spike

import android.util.Base64
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * The staged web-plugin delivery: every package directory under
 * `filesDir/web-plugins/npm/@deepseek-ai/` (the W-SHELL application tier,
 * 58 `dsh.client` packages), base64, with the fixed generation stamp
 * (`mtimeMs: 0` — the same stamp the CLI runner pins). Packages are listed
 * in SORTED name order: the registry's scan order (= the loader entry order)
 * is the module-graph tie-break, so the composed `__DSH_BOOT__` entry order
 * is deterministic across runs and devices. Kotlin sibling of the iOS
 * WebBootRuntimeDrive delivery extension. Staged files per package: the
 * manifest + the `./client` bundle (+ any staged package-local chunks); the
 * graph's revs come from the runtime.
 */
object WebPluginsDelivery {

    /** The delivery array, or null when the staging is missing (the runner
     * stages it; a fresh install without it cannot boot — fail loud). */
    fun build(webPluginsRoot: File): JSONArray? {
        val scope = File(webPluginsRoot, "npm/@deepseek-ai")
        val packageDirs = scope.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }
            ?: return null
        val plugins = JSONArray()
        for (pkg in packageDirs) {
            val at = pkg.name.lastIndexOf('@')
            if (at <= 0) continue
            val name = "@deepseek-ai/" + pkg.name.substring(0, at)
            val lib = File(pkg, "lib")
            val vfsRoot = "/web-plugins/npm/@deepseek-ai/${pkg.name}"
            val files = stagedFiles(pkg, lib, vfsRoot) ?: return null
            plugins.put(
                JSONObject()
                    .put("loaderName", name)
                    .put("pkgJsonPath", "$vfsRoot/package.json")
                    .put("entryPath", "$vfsRoot/lib/client.js")
                    .put("files", files),
            )
        }
        return if (plugins.length() == 0) null else plugins
    }

    /** One package's delivered files: the manifest + the `./client` bundle
     * (+ any staged package-local chunks), base64, fixed stamp. Null when a
     * required file is missing (the staging did not land — fail loud). */
    private fun stagedFiles(pkg: File, lib: File, vfsRoot: String): JSONObject? {
        val manifestB64 = stagedFileB64(File(pkg, "package.json")) ?: return null
        val bundleB64 = stagedFileB64(File(lib, "client.js")) ?: return null
        val files = JSONObject()
        files.put(
            "$vfsRoot/package.json",
            JSONObject().put("b64", manifestB64).put("mtimeMs", 0),
        )
        files.put(
            "$vfsRoot/lib/client.js",
            JSONObject().put("b64", bundleB64).put("mtimeMs", 0),
        )
        val staged = lib.listFiles()?.sortedBy { it.name } ?: return files
        for (chunk in staged) {
            val fileName = chunk.name
            if (fileName == "client.js" || !fileName.startsWith("client.") ||
                !fileName.endsWith(".js") || fileName.endsWith(".map")
            ) {
                continue
            }
            val chunkB64 = stagedFileB64(chunk) ?: continue
            files.put(
                "$vfsRoot/lib/$fileName",
                JSONObject().put("b64", chunkB64).put("mtimeMs", 0),
            )
        }
        return files
    }

    /** One staged file → base64 (null when the runner did not stage it). */
    private fun stagedFileB64(file: File): String? = try {
        Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    } catch (_: Exception) {
        null
    }
}
