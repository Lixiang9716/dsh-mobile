import Foundation

/// The plane drives (device.plane, camera.plane) over the standard
/// GatewaySession machinery, extracted from AppDelegate to keep the mode
/// dispatcher under the size gate. The finished markers are the E2E
/// runners' terminal hooks.
extension AppDelegate {
    /// The v1.5.0 device-plane drive over the device.plane scenario.
    func runDevicePlane() {
        let session = GatewaySession(
            entryModule: "scenario/device-plane.js",
            sourceProvider: { String(cString: dsh_spike_res_scenario_device_plane_js(nil)) })
        gateway = session
        session.run { [weak self] outcome in
            self?.show(outcome, phase: "device.plane") { self?.gatewayVerdict = $0 }
            self?.gateway = nil
            print("spike: device-plane drive finished verdict=\(outcome.verdict)")
            fflush(stdout)
        }
    }
    /// The capability plane's camera drive (proposal v1.10.0): the burst,
    /// the read-through scope, the phased rows' honest `unavailable`.
    func runCameraPlane() {
        let session = GatewaySession(
            entryModule: "scenario/camera-plane.js",
            sourceProvider: { String(cString: dsh_spike_res_scenario_camera_plane_js(nil)) })
        gateway = session
        session.run { [weak self] outcome in
            self?.show(outcome, phase: "camera.plane") { self?.gatewayVerdict = $0 }
            self?.gateway = nil
            print("spike: camera-plane drive finished verdict=\(outcome.verdict)")
            fflush(stdout)
        }
    }
}
