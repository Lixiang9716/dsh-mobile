import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private var mainWindow: UIWindow?
    private var console: UITextView?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let console = UITextView(frame: window.bounds.insetBy(dx: 16, dy: 64))
        console.isEditable = false
        console.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        console.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        console.text = "DSH M1 spike — driving scenario m1.spike.boot …"
        window.rootViewController = UIViewController()
        window.rootViewController?.view.addSubview(console)
        window.makeKeyAndVisible()
        self.mainWindow = window
        self.console = console
        print("spike: app launched, driving scenario m1.spike.boot")
        SpikeRuntime().run { [weak self] outcome in self?.show(outcome) }
        return true
    }

    private func show(_ outcome: SpikeOutcome) {
        var text = [
            "DSH M1 spike — m1.spike.boot",
            "engine: \(outcome.engineName) \(outcome.engineVersion)",
            "events logged: \(outcome.canonicalLines.count)",
            "",
            "verdict: \(outcome.verdict)",
        ].joined(separator: "\n")
        if !outcome.error.isEmpty {
            text += "\nerror: \(outcome.error)"
            print("spike: error \(outcome.error)")
        }
        console?.text = text
        print("spike: verdict \(outcome.verdict) (events logged: \(outcome.canonicalLines.count))")
        fflush(stdout)
    }
}
