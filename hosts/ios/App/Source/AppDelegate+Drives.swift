import Foundation

/// The E2E drive launchers that outgrew AppDelegate's file budget — the
/// -dsh-mode case table calls these; the session lifecycle (the `gateway`
/// slot, the verdict panel) stays on the main class.

extension AppDelegate {
    /// Announces + launches the capability plane's camera drive (the
    /// camera sibling of startBleMode).
    func startCameraMode() {
        announce("DSH camera plane — camera.plane, the capability plane's capture burst live…",
                 line: "rt: app launched in camera-plane mode", web: false)
        runCameraPlane()
    }

    /// Announces + launches the capability plane's BLE drive: the real
    /// CoreBluetooth radio by default (a simulator answers `unavailable`
    /// honestly — the CI skip leg), the deterministic mock on the -mock
    /// mode (the envelope + audit CI leg).
    func startBleMode() {
        let mock = launchMode == "ble-plane-mock"
        announce(
            "DSH BLE plane — ble.plane, the capability plane's BLE face "
                + (mock ? "over the deterministic mock radio…" : "over the real radio…"),
            line: "rt: app launched in \(launchMode) mode", web: false)
        runBlePlane(mockRadio: mock)
    }

    /// The capability plane's BLE drive over the ble.plane scenario (see
    /// startBleMode for the radio choice).
    func runBlePlane(mockRadio: Bool) {
        let session = GatewaySession(
            entryModule: "scenario/ble-plane.js",
            sourceProvider: { String(cString: dsh_runtime_res_scenario_ble_plane_js(nil)) },
            bleRadio: mockRadio ? MockBleRadio() : nil)
        self.gateway = session
        session.run { [weak self] outcome in
            self?.show(outcome, phase: "ble.plane") { self?.gatewayVerdict = $0 }
            self?.gateway = nil
            print("rt: ble-plane drive finished verdict=\(outcome.verdict)")
            fflush(stdout)
        }
    }

}
