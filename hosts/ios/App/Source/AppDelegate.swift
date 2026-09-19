import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private var mainWindow: UIWindow?
    private var console: UITextView?
    private var webView: WKWebView?
    private var bootVerdict = "PENDING"
    private var carrierVerdict = "PENDING"
    /// Strong ref for the session: CarrierRuntime's internal closures are all
    /// weak, so without this the runtime deallocates the moment the queue
    /// drains its first block and the session dies silently.
    private var carrier: CarrierRuntime?

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
        console.text = "DSH M1 spikes — driving m1.spike.boot then m1.carrier.loopback …"
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
        print("spike: app launched, driving m1.spike.boot then m1.carrier.loopback")
        fflush(stdout)
        SpikeRuntime().run { [weak self] boot in
            self?.show(boot, phase: "m1.spike.boot") { self?.bootVerdict = $0 }
            self?.runCarrier()
        }
        return true
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
            // The CI poll waits for this final marker before running the checkers.
            print("spike: sequence boot=\(self.bootVerdict) carrier=\(self.carrierVerdict)")
            fflush(stdout)
        }
    }

    private func show(
        _ outcome: SpikeOutcome, phase: String, setVerdict: @escaping (String) -> Void
    ) {
        setVerdict(outcome.verdict)
        var text = [
            "DSH M1 spike — \(phase)",
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
