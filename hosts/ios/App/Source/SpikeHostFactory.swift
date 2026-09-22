import Foundation

/// Creating the C spike host, in ONE place, because the host has to declare its
/// capabilities to the JS spine *before* the entry module runs — and the spine
/// boots from four different drives (the plain runtime, the session runtime, the
/// carrier, the web-boot drive). A declaration made on one path and forgotten on
/// another is worse than no declaration: the JS layer then decides whether a
/// tool exists from a fact that is true on one drive and false on the next.
///
/// Today the declaration is the guest userland (contract v1.3.0 `ishRun`): the
/// shell plugin offers its `ish` tool only when the host says it can serve one,
/// and a host with no userland must stay silent so the plugin can say so instead
/// of handing the model a command line that cannot run.
func dsh_spike_new_declaring(
    _ bundleRoot: String,
    _ sink: inout dsh_spike_sink,
    note: ((String) -> Void)? = nil
) -> OpaquePointer? {
    guard let host = dsh_spike_new(bundleRoot, &sink) else { return nil }
    if let guestRoot = IshPrimitive.declaredGuestRoot() {
        let env = ["DSH_ISH_ROOTFS": guestRoot]
        if let data = try? JSONSerialization.data(withJSONObject: env),
           let json = String(data: data, encoding: .utf8) {
            dsh_spike_set_launch_env(host, json)
            note?("dsh.spike.log: launch env declares the guest userland: \(guestRoot)")
        }
    }
    return host
}
