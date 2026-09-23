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
    // The launch-env snapshot is the host's declaration channel to the JS
    // spine. Two kinds of fact ride it: the guest userland (DSH_ISH_ROOTFS,
    // below) and the E2E runner's DSH_-prefixed process environment — the
    // parity drive's mock endpoint (DSH_MOCK_LLM_URL/KEY) arrives that way,
    // injected through simctl's SIMCTL_CHILD_* inheritance (the simulator
    // shares the host's loopback, so the node-side mock is reachable).
    var env: [String: String] = ProcessInfo.processInfo.environment
        .filter { $0.key.hasPrefix("DSH_") }
    if let guestRoot = IshPrimitive.declaredGuestRoot() {
        env["DSH_ISH_ROOTFS"] = guestRoot
        note?(launchEnvRecord(guestRoot))
    }
    if !env.isEmpty,
       let data = try? JSONSerialization.data(withJSONObject: env),
       let json = String(data: data, encoding: .utf8) {
        dsh_spike_set_launch_env(host, json)
    }
    return host
}

/// The declaration as ONE canonical record on the `dsh.spike.log:` stream —
/// every prefixed line a checker reads must be the unified-logger envelope or
/// it counts as a parse error against EVERY scenario riding the capture (free
/// text after the prefix broke both m1 verdicts). The fact belongs to no
/// scenario (a host with no userland stays silent), so it rides the reserved
/// `host.launch` scenario id: manifests filter on their own scenario and never
/// see it, while the capture keeps the evidence. Level `info`, so the release
/// build's warn/error strip drops it like every other debug-fact line.
private func launchEnvRecord(_ guestRoot: String) -> String {
    let payload: [String: Any] = [
        "scenario": "host.launch",
        "event": "ish.rootfs.declared",
        "env": "DSH_ISH_ROOTFS",
        "rootfs": guestRoot,
    ]
    let envelope = GatewayCore.jsonLine([
        "level": "info", "module": "dsh.host",
        "message": "launch env declares the guest userland",
        "data": [payload],
    ]) ?? "{}"
    return SpikeLogSink.prefix + envelope
}
