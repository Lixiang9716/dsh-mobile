import Foundation

/// The index-injection values for the official page (docs/webserver-contract.md
/// §2.6): the `__ModuleLoader__` bootstrap facade, the `__DSH_BOOT__` entry
/// graph, and the `__DSH_CONNECTION_RECOVERY__` timing. Defaults are
/// carrier-generated from the staged plugin set — the same JSON shapes
/// upstream emits, no upstream code involved (§3.4). The runtime may hand a
/// `web.boot` config over the bus seam to replace any of them (Phase-C).
struct CarrierBootConfig {
    /// The upstream client-modules package id the facade resolves.
    static let clientModulesID = "@deepseek-ai/dsh-client-modules"

    let moduleLoaderScript: String
    let bootGraphJSON: String
    let recoveryJSON: String

    /// The default config for a staged plugin set: upstream's facade script
    /// verbatim, a carrier-generated application-phase graph, and upstream's
    /// documented recovery defaults.
    static func `default`(plugins: CarrierPlugins) -> CarrierBootConfig {
        CarrierBootConfig(
            moduleLoaderScript: moduleLoaderTemplate,
            bootGraphJSON: graphJSON(entries: plugins.bootEntries()),
            recoveryJSON: recoveryDefaults
        )
    }

    /// The injection rows, in upstream execution order: facade script,
    /// application preloads, graph global, recovery global, and the settings
    /// phone adaptation (head rows all; the `__DSH_BOOT_READY__` tail is
    /// appended by the render pipeline).
    func rows() -> [CarrierIndexInjection] {
        let graph = CarrierIndexInjection.jsonGlobalValue(bootGraphJSON)
        let recovery = CarrierIndexInjection.jsonGlobalValue(recoveryJSON)
        var rows = [CarrierIndexInjection(kind: .script(placement: .head, text: moduleLoaderScript))]
        rows += preloadURLs().map {
            CarrierIndexInjection(kind: .scriptPreload(src: $0))
        }
        rows.append(CarrierIndexInjection(kind: .global(name: "__DSH_BOOT__", value: graph)))
        rows.append(CarrierIndexInjection(kind: .global(
            name: "__DSH_CONNECTION_RECOVERY__", value: recovery)))
        rows.append(Self.settingsPhoneAdaptation)
        return rows
    }

    /// Distinct combo URLs across the graph batches, in batch order.
    private func preloadURLs() -> [String] {
        guard let data = bootGraphJSON.data(using: .utf8),
              let graph = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let batches = graph["batches"] as? [[String: Any]] else { return [] }
        return batches.compactMap { $0["url"] as? String }
    }

    /// Upstream `WebBootGraph` shape: one application batch over every
    /// staged entry (a valid `partitionComboRecords` outcome for mobile-sized
    /// sets), with a content-anchored graph rev.
    static func graphJSON(entries: [[String: String]]) -> String {
        guard !entries.isEmpty else {
            let zeros = String(repeating: "0", count: 12)
            return "{\"rev\":\"\(zeros)\",\"entries\":[],\"batches\":[]}"
        }
        let ids = entries.map { $0["id"] ?? "" }
        let revs = entries.map { $0["rev"] ?? "" }
        let comboRev = CarrierPlugins.comboRev(ids: ids, revs: revs)
        let resources = ids.map { "\($0)/client.js" }.joined(separator: ",")
        let batch: [String: Any] = [
            "phase": "application",
            "url": "/plugins/??\(resources)&rev=\(comboRev)",
            "rev": comboRev,
            "entries": ids,
        ]
        let graph: [String: Any] = [
            "rev": CarrierPlugins.shortHash(graphAnchor(entries)),
            "entries": entries,
            "batches": [batch],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: graph),
              var json = String(data: data, encoding: .utf8) else { return "{}" }
        json = json.replacingOccurrences(of: "<", with: "\\u003c")
        return json
    }

    private static func graphAnchor(_ entries: [[String: String]]) -> String {
        entries.map { "\($0["id"] ?? "")@\($0["rev"] ?? "")" }.joined(separator: ";")
    }

    /// Upstream recovery defaults (recovery-config.ts), as the `global` row
    /// value the connection plugin resolves.
    static let recoveryDefaults = #"{"backoffBaseMs":500,"backoffFactor":2,"# +
        #""backoffMaxMs":10000,"generationReadyWarnMs":3000,"# +
        #""generationReadyTimeoutMs":15000}"#

    /// The settings dialog's phone adaptation, injected as a §1.5 `style` row
    /// into every official-page render. Upstream's SettingsRoot panel is a
    /// fixed 800px desktop modal with a 188px side nav and no narrow layout,
    /// so on a phone it arrived as a 342pt modal squeezed against the screen
    /// edge — the owner complaint this patch answers (the main screen needs
    /// no help: the AppFrame measures its own width and drops the sidebar
    /// below 1024). Two tiers, mirroring upstream's own responsive
    /// conventions: ≤1024 (the app frame's auto-collapse width) near-full-
    /// bleed, ≤560 (the narrow tweak settings-models ships) full-bleed with
    /// the nav flipped into a horizontal chip row. The scope hook is
    /// STRUCTURAL, never the hash classes (they change on upstream re-pins):
    /// the settings panel is the served page's only `role=dialog` element
    /// carrying `aria-modal` AND `aria-labelledby` — the attachment lightbox
    /// and the shell's dialog use `aria-label` instead (verified across the
    /// pinned dist and every client bundle). Cascade safety: the selector is
    /// specificity (0,3,0) and beats the bundle's hash classes (0,1,0) no
    /// matter which <style> lands first, while inline styles still win.
    static let settingsPhoneCSS = """
    @media (max-width:1024px){div[role="dialog"][aria-modal="true"][aria-labelledby]{width:min(calc(100vw - 24px),800px);max-width:calc(100vw - 24px);height:min(calc(100vh - 24px),800px);border-radius:20px}}
    @media (max-width:560px){
    div[role="dialog"][aria-modal="true"][aria-labelledby]{width:100vw;max-width:100vw;height:100vh;border-radius:0;flex-direction:column}
    div[role="dialog"][aria-modal="true"][aria-labelledby]>nav{flex-direction:row;align-items:center;gap:12px;width:auto;max-width:100%;padding:10px 12px 0}
    div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:first-child{flex:none;padding:0;white-space:nowrap}
    div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:last-child{flex-direction:row;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;padding-bottom:8px}
    div[role="dialog"][aria-modal="true"][aria-labelledby] nav button{flex:none;height:36px;padding:6px 12px;white-space:nowrap}
    }
    """

    /// The `style` row every producer appends — the carrier defaults in
    /// `rows()` below and the runtime-composed rows in SessionServe /
    /// OfficialWebRuntime — so the page adapts whichever wire it boots from.
    static let settingsPhoneAdaptation = CarrierIndexInjection(
        kind: .style(text: settingsPhoneCSS))

    /// The upstream bootstrap facade (client-modules `bootInjections` queue
    /// script), verbatim modulo the package-id constant.
    static let moduleLoaderTemplate = #"""
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
    """#
}
