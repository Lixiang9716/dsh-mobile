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
    /// The Phase-B official-web mount drive (`-dsh-mode official-web`).
    private var official: OfficialWebRuntime?
    private var officialVerdict = "PENDING"
    /// The W-SESS session-live drive (`-dsh-mode session-live`).
    private var sessionLive: SessionLiveRuntime?
    private var sessionLiveVerdict = "PENDING"
    /// The W-RPC session-write drive (`-dsh-mode session-write`).
    private var sessionWrite: SessionWriteRuntime?
    private var sessionWriteVerdict = "PENDING"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let root = UIViewController()
        if BuildFlavor.isRelease {
            return bootRelease(window: window, root: root)
        }
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
            let surface = SessionLaunchConfig.scenarioName
                .map { "scenario \($0) (real-LLM drive)" }
                ?? SessionLaunchConfig.profileName
                    .map { "profile \($0) (config-selected client)" }
                ?? "Web Client \(SessionLaunchConfig.activeWebClient)"
            console.text = "DSH session — m2.session over the system plugins, \(surface)…"
            print("spike: app launched in session mode (\(surface))")
            fflush(stdout)
            runSession()
            return true
        }
        if launchMode == "official-web" {
            console.text = "DSH official web — b1.official-web.mount, the upstream app on the contract carrier…"
            print("spike: app launched in official-web mode")
            fflush(stdout)
            webView.navigationDelegate = self
            runOfficialWeb()
            return true
        }
        if launchMode == "session-live" {
            console.text = "DSH session live — b3.session.live, the upstream spine on-device answering the official app…"
            print("spike: app launched in session-live mode")
            fflush(stdout)
            webView.navigationDelegate = self
            runSessionLive()
            return true
        }
        if launchMode == "session-write" {
            console.text = "DSH session write — b4.write.live, the official composer driving the upstream spine…"
            print("spike: app launched in session-write mode")
            fflush(stdout)
            webView.navigationDelegate = self
            runSessionWrite()
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
        requestedLaunchMode ?? "spikes"
    }

    /// The `-dsh-mode` value, or nil when the flag is absent.
    private var requestedLaunchMode: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-dsh-mode"), at + 1 < args.count else {
            return nil
        }
        return args[at + 1]
    }

    /// The user-facing boot: the official DSH Web Client, full screen, with
    /// no launch arguments required. No verification drive runs, no verdict
    /// panel exists, and no per-event E2E record is produced — the "release"
    /// half of AGENTS.md constraint 5 / rules.md rule L4. A launch that asks
    /// for an E2E drive is refused LOUD (rule 5): this binary has no drives.
    private func bootRelease(window: UIWindow, root: UIViewController) -> Bool {
        if let mode = requestedLaunchMode, mode != "official-web" {
            fatalError("""
                DSHSpike release build: refusing '-dsh-mode \(mode)'. This is the \
                user-facing distribution build — the verification drives, the \
                verdict panel, and the per-event E2E log stream are compiled out \
                (AGENTS.md constraint 5, rules.md rule L4). Build/run the harness \
                variant (dsh-ios-harness) to drive E2E legs.
                """)
        }
        let webView = WKWebView(frame: window.bounds)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(webView)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.mainWindow = window
        self.webView = webView
        webView.navigationDelegate = self
        runOfficialWeb()
        return true
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

    /// The Phase-B official-web mount: the contract carrier serves the
    /// vendored upstream dist; the drive probes the wire + rendered state.
    /// In a release build the same serving stack runs with the evidence
    /// machinery off (no probe, no watchdog, no canonical records).
    private func runOfficialWeb() {
        let official = OfficialWebRuntime(evidence: !BuildFlavor.isRelease)
        self.official = official
        official.attach(webView: webView!)
        official.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        official.run { [weak self] outcome in
            guard let self, !BuildFlavor.isRelease else { return }
            self.show(outcome, phase: "b1.official-web.mount") { self.officialVerdict = $0 }
            self.official = nil
            print("spike: sequence official-web=\(self.officialVerdict)")
            fflush(stdout)
        }
    }

    /// The W-SESS session-live mount: the spine runs on-device, the claimed
    /// session surface answers the official app, the journal streams real
    /// records.
    private func runSessionLive() {
        let live = SessionLiveRuntime()
        self.sessionLive = live
        live.attach(webView: webView!)
        live.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        live.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "b3.session.live") { self.sessionLiveVerdict = $0 }
            self.sessionLive = nil
            print("spike: sequence session-live=\(self.sessionLiveVerdict)")
            fflush(stdout)
        }
    }

    /// The W-RPC session-write mount: the spine answers the official app's
    /// write surface; the probe types into the real composer and the reply
    /// renders in the official UI.
    private func runSessionWrite() {
        let write = SessionWriteRuntime()
        self.sessionWrite = write
        write.attach(webView: webView!)
        write.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        write.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "b4.write.live") { self.sessionWriteVerdict = $0 }
            self.sessionWrite = nil
            print("spike: sequence session-write=\(self.sessionWriteVerdict)")
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

extension AppDelegate: WKNavigationDelegate {
    /// The official page finished loading: all head subresources have
    /// arrived — the drive emits its mount evidence, probes the wire, and
    /// reads the rendered state.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        official?.pageDidFinish()
        sessionLive?.pageDidFinish()
        sessionWrite?.pageDidFinish()
    }
}
