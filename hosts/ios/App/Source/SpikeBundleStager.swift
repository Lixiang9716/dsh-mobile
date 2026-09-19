import Foundation

/// Stages the embedded JS bundle into a fresh writable sandbox directory,
/// preserving the runtime/spike layout the C loader expects: logger.js at
/// the root, the entry under scenario/, and the vendored upstream package
/// under vendor/ (the "dsh:util-crypto" import maps there). The bytes come
/// from the embedded arrays (gen_bundle_header.py), so what the simulator
/// runs is byte-identical to the checkout.
enum SpikeBundleStager {
    static func stage() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("spike", isDirectory: true)
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        try write("logger.js", data: resData(dsh_spike_res_logger_js),
                  under: root)
        try write("scenario/m1-spike-boot.js", data: resData(dsh_spike_res_scenario_js),
                  under: root)
        try write("vendor/dsh/util-crypto@0.1.6-alpha.1/lib/index.js",
                  data: resData(dsh_spike_res_pkg_crypto_js), under: root)
        return root
    }

    private static func resData(
        _ accessor: (UnsafeMutablePointer<Int>?) -> UnsafePointer<CChar>?
    ) -> Data {
        var len: Int = 0
        guard let bytes = accessor(&len), len > 0 else { return Data() }
        return Data(bytes: bytes, count: len)
    }

    private static func write(_ relative: String, data: Data, under root: URL) throws {
        guard !data.isEmpty else {
            throw SpikeBundleError.emptyResource(relative)
        }
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: url)
    }
}

enum SpikeBundleError: Error {
    case emptyResource(String)
}
