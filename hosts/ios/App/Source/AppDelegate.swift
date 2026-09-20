import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private var mainWindow: UIWindow?
    private var console: UITextView?
    private var webView: WKWebView?
    private var bootVerdict = "PENDING"
    private var carrierVerdict = "PENDING"
    private var gatewayVerdict = "PENDING"
    /// Strong ref for the session: CarrierRuntime's internal closures are all
    /// weak, so without this the runtime deallocates the moment the queue
    /// drains its first block and the session dies silently.
    private var carrier: CarrierRuntime?
    /// Same for the m2 gateway phase (boot → carrier → gateway, order frozen).
    private var gateway: GatewaySession?
    /// The m2 on-device session phase (session launch mode only).
    private var session: SessionRuntime?
    private var sessionVerdict = "PENDING"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let root = UIViewController()
        let consoleFrame = CGRect(
            x: 16, y: 64,
            width: window.bounds.width - 32,
            height: window.bounds.height * 0.55 - 64
        )
        let console = UITextView(frame: consoleFrame)
        console.isEditable = false
        console.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        console.autoresizingMask = [.flexibleWidth, .flexibleBottomMargin]
        console.text = "DSH spikes — m1.spike.boot, m1.carrier.loopback, then the m2 gateway binding …"
        let webView = WKWebView(
            frame: CGRect(
                x: 0, y: window.bounds.height * 0.55,
                width: window.bounds.width,
                height: window.bounds.height * 0.45
            )
        )
        webView.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        root.view.addSubview(console)
        root.view.addSubview(webView)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.mainWindow = window
        self.console = console
        self.webView = webView
        if launchMode == "session" {
            let surface = SessionRuntime.profileName
                .map { "profile \($0) (config-selected client)" }
                ?? "Web Client \(SessionRuntime.activeWebClient)"
            console.text = "DSH session — m2.session over the system plugins, \(surface)…"
            print("spike: app launched in session mode (\(surface))")
            fflush(stdout)
            runSession()
            return true
        }
        print("spike: app launched, driving m1.spike.boot then m1.carrier.loopback")
        fflush(stdout)
        SpikeRuntime().run { [weak self] boot in
            self?.show(boot, phase: "m1.spike.boot") { self?.bootVerdict = $0 }
            self?.runCarrier()
        }
        return true
    }

    /// Launch mode from the launch arguments ("-dsh-mode session"): the
    /// default keeps the historical boot → carrier → gateway sequence.
    private var launchMode: String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-dsh-mode"), at + 1 < args.count else {
            return "spikes"
        }
        return args[at + 1]
    }

    /// The on-device session: the scenario runs behind the mounted Web
    /// Client and starts only once the page is connected (host.info), so
    /// the token deltas stream live into the rendered transcript.
    private func runSession() {
        let session = SessionRuntime()
        self.session = session
        session.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        session.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "m2.session") { self.sessionVerdict = $0 }
            self.session = nil
            // The session runner polls for this terminal marker.
            print("spike: sequence session=\(self.sessionVerdict)")
            fflush(stdout)
        }
    }

    private func runCarrier() {
        let carrier = CarrierRuntime()
        self.carrier = carrier
        carrier.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        carrier.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "m1.carrier.loopback") { self.carrierVerdict = $0 }
            self.carrier = nil
            self.runGateway()
        }
    }

    /// The m2 phase: the real nine-primitive gateway binding. Its outcome
    /// completes the launch sequence — this is where the final marker prints.
    private func runGateway() {
        let gateway = GatewaySession()
        self.gateway = gateway
        gateway.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "m2.gateway.binding") { self.gatewayVerdict = $0 }
            self.gateway = nil
            // The CI poll waits for this final marker before running the checkers.
            print("spike: sequence boot=\(self.bootVerdict) carrier=\(self.carrierVerdict)"
                + " gateway=\(self.gatewayVerdict)")
            fflush(stdout)
        }
    }

    private func show(
        _ outcome: SpikeOutcome, phase: String, setVerdict: @escaping (String) -> Void
    ) {
        setVerdict(outcome.verdict)
        var text = [
            "DSH spike — \(phase)",
            "engine: \(outcome.engineName) \(outcome.engineVersion)",
            "events logged: \(outcome.canonicalLines.count)",
            "verdict: \(outcome.verdict)",
        ].joined(separator: "\n")
        if !outcome.error.isEmpty {
            text += "\nerror: \(outcome.error)"
            print("spike: error \(outcome.error)")
        }
        console?.text = (console?.text ?? "") + "\n\n" + text
        print("spike: verdict \(outcome.verdict) (\(phase), events logged: \(outcome.canonicalLines.count))")
        fflush(stdout)
    }
}
