import Foundation
import UIKit

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

    /// The create-approve-hotmount chain leg (the `-dsh-mode create-card`
    /// seat): the create.card scenario invokes dsh-create's plugin_create
    /// execute — package, NATIVE Approve (the drive taps), registry install,
    /// and the LIVE native card. The card seam (PR-1) renders beside the
    /// verdict panel.
    func runCreateCardDrive() {
        let surface = CardPlayerSurface()
        cardSurface = surface
        let session = GatewaySession(
            entryModule: "scenario/create-card.js",
            sourceProvider: { String(cString: dsh_runtime_res_scenario_create_card_js(nil)) })
        session.onCardEvent = { [weak surface] msg in
            DispatchQueue.main.async { surface?.handle(msg) }
        }
        gateway = session
        session.run { [weak self] outcome in
            self?.show(outcome, phase: "create.card") { self?.gatewayVerdict = $0 }
            self?.gateway = nil
            print("rt: create-card drive finished verdict=\(outcome.verdict)")
            fflush(stdout)
        }
        if let window = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first,
           let host = window.rootViewController?.view {
            surface.attach(to: host)
        }
    }

    /// The calendar live leg (`-dsh-mode calendar-live`): the serve seat
    /// with the create-calendar-live scenario — ONE real-backend turn (no
    /// page in the path), then the cordis live mount with its native
    /// approval, the plugin's own apply() driving the card.
    func runCalendarLiveDrive() {
        let surface = CardPlayerSurface()
        cardSurface = surface
        let serve = SessionServe(
            credential: SessionServe.loadCredential(),
            interactive: true)
        self.serve = serve
        serve.scenarioEntry = (
            accessor: dsh_runtime_res_scenario_create_calendar_live_js,
            path: "scenario/create-calendar-live.js"
        )
        serve.onOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        serve.onCardEvent = { [weak surface] msg in
            DispatchQueue.main.async { surface?.handle(msg) }
        }
        serve.cardState = { [weak surface] in surface?.snapshot() ?? [:] }
        serve.onRuntimeFailure = { message in
            NSLog("%@", "dsh.session.serve: runtime failed: \(message)")
        }
        if let host = webView?.superview {
            surface.attach(to: host)
        }
        do {
            try serve.start()
        } catch {
            NSLog("%@", "dsh.session.serve: bootstrap failed: \(error)")
        }
    }

    /// The WEB-seat launch modes' table (one line each in the dispatch
    /// switch): banner + canonical stdout line + the drive. The serve and
    /// card-player comments explain the seat's contract — see
    /// runServingBoot and CardPlayerDrive for the machinery.
    func launchWebDrive(_ mode: String) {
        switch mode {
        case "official-web":
            announce("DSH official web — officialweb.mount, the upstream app on the contract carrier…",
                     line: "rt: app launched in official-web mode", web: true)
            runOfficialWeb()
        case "session-live":
            announce("DSH session live — session.live-read, the upstream spine on-device answering the official app…",
                     line: "rt: app launched in session-live mode", web: true)
            runSessionLive()
        case "session-write":
            announce("DSH session write — composer.live-write, the official composer driving the upstream spine…",
                     line: "rt: app launched in session-write mode", web: true)
            runSessionWrite()
        case "next-web":
            announce("DSH next web — v2web.mount, the self-hosted client on the serving seat…",
                     line: "rt: app launched in next-web mode", web: true)
            runV2Web()
        case "serve":
            // The USER-FACING serving seat with the harness's logging intact
            // (a release build drops every debug/info record by design) —
            // the mode to reproduce a user-visible failure in.
            announce("DSH serve — the user-facing seat, driven by hand (harness logging on)…",
                     line: "rt: app launched in serve mode", web: true)
            runServingBoot()
        case "card-player":
            // PR-1 of the create-approve-hotmount-native loop: a plugin card
            // rendered by the app's OWN chrome (not an HTML page).
            CardPlayerDrive.launch(self)
        default:
            break
        }
    }

}
