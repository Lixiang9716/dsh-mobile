package com.dshmobile.spike

import org.json.JSONArray
import org.json.JSONObject

/**
 * The upstream boot-row → carrier injection-row mapping shared by the
 * official-web drives: the runtime's `web.boot` rows (upstream row shapes)
 * become the carrier's typed injection rows, plus the
 * `__DSH_CONNECTION_RECOVERY__` global every official page needs (upstream
 * recovery-config.ts defaults) and the settings dialog's phone adaptation
 * (`style` row). Extracted from the three drive sessions' identical copies
 * so the write-live drive stays under the file-size gate.
 */
object CarrierIndexRows {

    /** The settings dialog's phone adaptation, injected as a §1.5 `style`
     * row into every official-page render. Upstream's SettingsRoot panel is
     * a fixed 800px desktop modal with a 188px side nav and no narrow
     * layout, so on a phone it arrived as a ~342pt modal squeezed against
     * the screen edge — the owner complaint this patch answers (the main
     * screen needs no help: the AppFrame measures its own width and drops
     * the sidebar below 1024). Two tiers, mirroring upstream's own
     * responsive conventions: ≤1024 (the app frame's auto-collapse width)
     * near-full-bleed, ≤560 (the narrow tweak settings-models ships)
     * full-bleed with the nav flipped into a horizontal chip row. The scope
     * hook is STRUCTURAL, never the hash classes (they change on upstream
     * re-pins): the settings panel is the served page's only `role=dialog`
     * element carrying `aria-modal` AND `aria-labelledby` — the attachment
     * lightbox and the shell's dialog use `aria-label` instead (verified
     * across the pinned dist and every client bundle). Cascade safety: the
     * selector is specificity (0,3,0) and beats the bundle's hash classes
     * (0,1,0) no matter which <style> lands first, while inline styles
     * still win. Kept verbatim in step with the iOS sibling
     * (CarrierBootConfig.settingsPhoneCSS) and the Harmony sibling
     * (WebDist.settingsPhoneCss). */
    const val SETTINGS_PHONE_CSS = """@media (max-width:1024px){div[role="dialog"][aria-modal="true"][aria-labelledby]{width:min(calc(100vw - 24px),800px);max-width:calc(100vw - 24px);height:min(calc(100vh - 24px),800px);border-radius:20px}}
@media (max-width:560px){
div[role="dialog"][aria-modal="true"][aria-labelledby]{width:100vw;max-width:100vw;height:100vh;border-radius:0;flex-direction:column}
div[role="dialog"][aria-modal="true"][aria-labelledby]>nav{flex-direction:row;align-items:center;gap:12px;width:auto;max-width:100%;padding:10px 12px 0}
div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:first-child{flex:none;padding:0;white-space:nowrap}
div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:last-child{flex-direction:row;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;padding-bottom:8px}
div[role="dialog"][aria-modal="true"][aria-labelledby] nav button{flex:none;height:36px;padding:6px 12px;white-space:nowrap}
}"""

    /** The `style` row every producer appends, so the page adapts whichever
     * wire it boots from. */
    val SETTINGS_PHONE_ADAPTATION: CarrierIndexInjection = CarrierIndexInjection.style(
        SETTINGS_PHONE_CSS,
    )

    /** The injection rows for one `web.boot` rows array: the mapped rows
     * plus the recovery global and the settings phone adaptation (the
     * origin never opens without them). */
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
        out.add(SETTINGS_PHONE_ADAPTATION)
        return out
    }

    /** One upstream row shape → the carrier's typed injection row. An
     * unknown row kind is contract drift (docs/webserver-contract.md §1.5
     * names the kinds) and aborts with the offending name (rules.md rule
     * 5); a known kind with a missing field maps to null. */
    fun injectionRow(row: JSONObject): CarrierIndexInjection? = when (row.optString("kind")) {
        "script" -> row.optString("text").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.script(it) }
        "script-src" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptSrc(it) }
        "script-preload" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptPreload(it) }
        "style" -> row.optString("text").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.style(it) }
        "global" -> {
            val name = row.optString("name")
            val value = row.optString("value")
            if (name.isEmpty() || value.isEmpty()) null
            else CarrierIndexInjection.global(name, value)
        }
        else -> error("official-web: unknown web.boot row kind: ${row.optString("kind")}")
    }
}
