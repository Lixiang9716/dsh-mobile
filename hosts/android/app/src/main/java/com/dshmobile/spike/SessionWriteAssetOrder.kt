package com.dshmobile.spike

import org.json.JSONObject

/**
 * The write-live drive's once-guarded asset/combo report order (extracted
 * from SessionWriteSession, unchanged behavior): the entry JS chunk is the
 * deterministic first-fetch evidence (the `.js` suffix is load-bearing; the
 * css/js first fetch is a race), and the application batch's combo may land
 * before it — a `comboPending` arrival waits for the asset event so the
 * report order stays fixed. Single-emission per event. */
class SessionWriteAssetOrder(private val emit: (String, JSONObject) -> Unit) {

    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: Pair<String, Int>? = null

    /** The entry chunk's arrival flag (the probe waits on it, rule 8). */
    val assetSeen: Boolean get() = assetLogged

    @Synchronized
    fun observeAsset(path: String) {
        if (!path.startsWith("/assets/index-") || !path.endsWith(".js")) return
        if (assetLogged) return
        assetLogged = true
        emit("asset.served", JSONObject().put("path", path))
        val combo = comboPending ?: return
        if (comboLogged) return
        comboLogged = true
        emit(
            "plugins.served",
            JSONObject().put("path", combo.first).put("bytes", combo.second),
        )
    }

    @Synchronized
    fun observeCombo(url: String, bytes: Int) {
        if (comboLogged) return
        if (!assetLogged) {
            comboPending = url to bytes
            return
        }
        comboLogged = true
        emit("plugins.served", JSONObject().put("path", url).put("bytes", bytes))
    }
}
