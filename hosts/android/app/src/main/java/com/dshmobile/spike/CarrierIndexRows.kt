package com.dshmobile.spike

import org.json.JSONArray
import org.json.JSONObject

/**
 * The upstream boot-row → carrier injection-row mapping shared by the
 * official-web drives: the runtime's `web.boot` rows (upstream row shapes)
 * become the carrier's typed injection rows, plus the
 * `__DSH_CONNECTION_RECOVERY__` global every official page needs (upstream
 * recovery-config.ts defaults). Extracted from the three drive sessions'
 * identical copies so the write-live drive stays under the file-size gate.
 */
object CarrierIndexRows {

    /** The injection rows for one `web.boot` rows array: the mapped rows
     * plus the recovery global (the origin never opens without them). */
    fun runtimeRows(webBootRows: JSONArray?): List<CarrierIndexInjection> {
        val out = ArrayList<CarrierIndexInjection>()
        for (i in 0 until (webBootRows?.length() ?: 0)) {
            injectionRow(webBootRows!!.getJSONObject(i))?.let { out.add(it) }
        }
        out.add(
            CarrierIndexInjection.global(
                "__DSH_CONNECTION_RECOVERY__",
                CarrierIndexInjection.jsonGlobalValue(CarrierBootConfig.recoveryDefaults),
            ),
        )
        return out
    }

    /** One upstream row shape → the carrier's typed injection row. */
    fun injectionRow(row: JSONObject): CarrierIndexInjection? = when (row.optString("kind")) {
        "script" -> row.optString("text").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.script(it) }
        "script-src" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptSrc(it) }
        "script-preload" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptPreload(it) }
        "global" -> {
            val name = row.optString("name")
            val value = row.optString("value")
            if (name.isEmpty() || value.isEmpty()) null
            else CarrierIndexInjection.global(name, value)
        }
        else -> null
    }
}
