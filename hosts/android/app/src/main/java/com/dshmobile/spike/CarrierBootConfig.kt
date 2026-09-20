package com.dshmobile.spike

import org.json.JSONArray
import org.json.JSONObject

/**
 * The index-injection values for the official page (docs/webserver-contract.md
 * §2.6): the `__ModuleLoader__` bootstrap facade, the `__DSH_BOOT__` entry
 * graph, and the `__DSH_CONNECTION_RECOVERY__` timing. Defaults are
 * carrier-generated from the staged plugin set — the same JSON shapes
 * upstream emits, no upstream code involved (§3.4). The runtime may hand a
 * `web.boot` config over the bus seam to replace any of them (Phase-C).
 * Kotlin sibling of hosts/ios CarrierBootConfig.swift.
 */
class CarrierBootConfig(
    val moduleLoaderScript: String,
    val bootGraphJSON: String,
    val recoveryJSON: String,
) {
    /** The injection rows, in upstream execution order: facade script,
     * application preloads, graph global, recovery global (head rows all;
     * the `__DSH_BOOT_READY__` tail is appended by the render pipeline). */
    fun rows(): List<CarrierIndexInjection> {
        val graph = CarrierIndexInjection.jsonGlobalValue(bootGraphJSON)
        val recovery = CarrierIndexInjection.jsonGlobalValue(recoveryJSON)
        val rows = mutableListOf(CarrierIndexInjection.script(moduleLoaderScript))
        rows += preloadURLs().map { CarrierIndexInjection.scriptPreload(it) }
        rows.add(CarrierIndexInjection.global("__DSH_BOOT__", graph))
        rows.add(CarrierIndexInjection.global("__DSH_CONNECTION_RECOVERY__", recovery))
        return rows
    }

    /** Distinct combo URLs across the graph batches, in batch order. */
    private fun preloadURLs(): List<String> = try {
        JSONObject(bootGraphJSON).optJSONArray("batches")
            ?.let { batches -> (0 until batches.length()).mapNotNull { batches.getJSONObject(it).optStringOrNull("url") } }
            ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    companion object {
        /** The upstream client-modules package id the facade resolves. */
        const val clientModulesID = "@deepseek-ai/dsh-client-modules"

        /** The default config for a staged plugin set: upstream's facade script
         * verbatim, a carrier-generated application-phase graph, and upstream's
         * documented recovery defaults. */
        fun default(plugins: CarrierPlugins): CarrierBootConfig = CarrierBootConfig(
            moduleLoaderScript = moduleLoaderTemplate,
            bootGraphJSON = graphJSON(plugins.bootEntries()),
            recoveryJSON = recoveryDefaults,
        )

        /** Upstream `WebBootGraph` shape: one application batch over every
         * staged entry (a valid `partitionComboRecords` outcome for
         * mobile-sized sets), with a content-anchored graph rev. */
        fun graphJSON(entries: List<Map<String, String>>): String {
            if (entries.isEmpty()) {
                val zeros = "0".repeat(12)
                return """{"rev":"$zeros","entries":[],"batches":[]}"""
            }
            val ids = entries.map { it["id"] ?: "" }
            val revs = entries.map { it["rev"] ?: "" }
            val comboRev = CarrierPlugins.comboRev(ids, revs)
            val resources = ids.map { "$it/client.js" }.joinToString(",")
            val batch = JSONObject()
                .put("phase", "application")
                .put("url", "/plugins/??$resources&rev=$comboRev")
                .put("rev", comboRev)
                .put("entries", JSONArray(ids))
            val anchor = entries.map { "${it["id"] ?: ""}@${it["rev"] ?: ""}" }
                .joinToString(";")
            val graph = JSONObject()
                .put("rev", CarrierPlugins.shortHash(anchor))
                .put("entries", JSONArray(entries.map { JSONObject(it) }))
                .put("batches", JSONArray().put(batch))
            return CarrierIndexInjection.jsonGlobalValue(graph.toString())
        }

        /** Upstream recovery defaults (recovery-config.ts), as the `global`
         * row value the connection plugin resolves. */
        const val recoveryDefaults =
            """{"backoffBaseMs":500,"backoffFactor":2,""" +
            """"backoffMaxMs":10000,"generationReadyWarnMs":3000,""" +
            """"generationReadyTimeoutMs":15000}"""

        /** The upstream bootstrap facade (client-modules `bootInjections`
         * queue script), verbatim modulo the package-id constant. No `$`
         * occurs in the script, so a raw string needs no escaping. */
        val moduleLoaderTemplate = """
            (()=>{
            const pendingQueue=[]
            window.__ModuleLoader__={
              mode:"queue",
              pendingQueue,
              load(registration){pendingQueue.push(registration)},
              create(options){
                if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
                const index=pendingQueue.findIndex(registration=>registration.id==="@deepseek-ai/dsh-client-modules")
                const registration=pendingQueue[index]
                if(registration===undefined)throw new Error("client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js")
                pendingQueue.splice(index,1)
                const exports=registration.factory(specifier=>{
                  throw new Error('client-modules: @deepseek-ai/dsh-client-modules/client.js requested external "'+specifier+'" before the module system existed')
                })
                if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
                  throw new Error("client-modules: @deepseek-ai/dsh-client-modules/client.js did not export the bootstrap module face")
                }
                return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
              }
            }
            })()
        """.trimIndent()
    }
}

/** optStringOrNull: org.json maps missing keys to "" — the boot graph's url
 * rows are real strings, so only "" needs mapping to null here. */
private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).ifEmpty { null }
