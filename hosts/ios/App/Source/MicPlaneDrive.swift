import Foundation

/// The capability plane's microphone drive (the `-dsh-mode mic-plane`
/// seat): the mic.plane scenario over the gateway session, split out of
/// AppDelegate to keep the mode-dispatch file under the size gate's file
/// budget. The sibling shape of the device-plane drive.
enum MicPlaneDrive {
    /// The mode-table entry: the harness banner + the canonical stdout line,
    /// then the drive.
    static func launch(_ appDelegate: AppDelegate) {
        appDelegate.announce(
            "DSH mic plane — mic.plane, the capability plane's microphone face live…",
            line: "rt: app launched in mic-plane mode", web: false)
        run(appDelegate)
    }

    static func run(_ appDelegate: AppDelegate) {
        let session = GatewaySession(
            entryModule: "scenario/mic-plane.js",
            sourceProvider: { String(cString: dsh_runtime_res_scenario_mic_plane_js(nil)) })
        appDelegate.gateway = session
        session.run { [weak appDelegate] outcome in
            appDelegate?.show(outcome, phase: "mic.plane") { appDelegate?.gatewayVerdict = $0 }
            appDelegate?.gateway = nil
            print("rt: mic-plane drive finished verdict=\(outcome.verdict)")
            fflush(stdout)
        }
    }
}
