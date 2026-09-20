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
    /// application preloads, graph global, recovery global (head rows all;
    /// the `__DSH_BOOT_READY__` tail is appended by the render pipeline).
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
