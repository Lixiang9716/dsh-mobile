import Foundation
import UIKit

/// The v1.5.0 device-plane primitives that need no user-consent surface:
/// deviceInfo (read-only facts), haptic (one cue per call), keepAwake (the
/// boolean screen latch), and presentShare (the system share sheet — the
/// sheet IS the per-call consent; the host learns only that it completed,
/// never the destination). clipboardRead/Write live in ClipboardPrimitives.
/// Audit detail carries only the closed-vocabulary facts the §6 table names
/// (pattern / hold / share kind) — never payload contents.
final class DevicePlanePrimitives {
    private weak var core: GatewayCore?
    private let fs: FSPrimitives

    init(core: GatewayCore, fs: FSPrimitives) {
        self.core = core
        self.fs = fs
        core.register(name: "deviceInfo") { call, done in self.deviceInfo(call, done) }
        core.register(name: "haptic") { call, done in self.haptic(call, done) }
        core.register(name: "keepAwake") { call, done in self.keepAwake(call, done) }
        core.register(name: "presentShare") { call, done in self.share(call, done) }
    }

    // ---- deviceInfo ---------------------------------------------------------

    private func deviceInfo(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        core?.stageAuditDetail(["platform": "ios"])
        let uid = UIDevice.current
        var info: [String: Any] = [
            "platform": "ios",
            "model": uid.model,
            "osVersion": uid.systemVersion,
            "appVersion": Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "screen": Self.screen(),
            "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "locale": Locale.current.identifier,
            "timezone": TimeZone.current.identifier,
        ]
        if let battery = Self.battery() { info["battery"] = battery }
        done(.success(info))
    }

    private static func screen() -> [String: Any] {
        let bounds = UIScreen.main.bounds
        return ["width": bounds.width, "height": bounds.height,
                "scale": UIScreen.main.scale]
    }

    /// The battery dict, or nil where the OS hides it (unknown level — the
    /// one field a host may omit, contract §4 device plane).
    private static func battery() -> [String: Any]? {
        let uid = UIDevice.current
        uid.isBatteryMonitoringEnabled = true
        guard uid.batteryLevel >= 0 else { return nil }
        let state: String
        switch uid.batteryState {
        case .charging: state = "charging"
        case .full: state = "full"
        case .unplugged: state = "unplugged"
        default: state = "unknown"
        }
        return ["level": uid.batteryLevel, "state": state]
    }

    // ---- haptic -------------------------------------------------------------

    private func haptic(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let pattern = call.string("pattern") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "haptic", message: "pattern missing")))
        }
        guard let effect = Self.effect(pattern) else {
            return done(.failure(GatewayError(
                code: "unavailable", primitive: "haptic",
                message: "pattern not expressible on this platform: \(pattern)")))
        }
        core?.stageAuditDetail(["pattern": pattern])
        DispatchQueue.main.async { effect() }
        done(.success(NSNull()))
    }

    /// Maps the closed vocabulary onto UIKit's generators; unknown names are
    /// `unavailable`, never a silent substitute.
    private static func effect(_ pattern: String) -> (() -> Void)? {
        switch pattern {
        case "light", "medium", "heavy", "rigid", "soft":
            let styles: [String: UIImpactFeedbackGenerator.FeedbackStyle] = [
                "light": .light, "medium": .medium, "heavy": .heavy,
                "rigid": .rigid, "soft": .soft,
            ]
            let generator = UIImpactFeedbackGenerator(style: styles[pattern]!)
            return { generator.impactOccurred() }
        case "selection":
            let generator = UISelectionFeedbackGenerator()
            return { generator.selectionChanged() }
        case "success", "warning", "error":
            let kinds: [String: UINotificationFeedbackGenerator.FeedbackType] = [
                "success": .success, "warning": .warning, "error": .error,
            ]
            let generator = UINotificationFeedbackGenerator()
            return { generator.notificationOccurred(kinds[pattern]!) }
        default:
            return nil
        }
    }

    // ---- keepAwake ----------------------------------------------------------

    private func keepAwake(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let hold = call.bool("hold")
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = hold
        }
        core?.stageAuditDetail(["hold": hold])
        done(.success(NSNull()))
    }

    // ---- presentShare -------------------------------------------------------

    /// The share sheet is the OS's own trust boundary: the payload leaves and
    /// only the completion comes back. Files resolve through the fs scope
    /// discipline — each path is "<scopeHandle>:<scope-relative path>" (the
    /// same (scope, path) pair fsRead takes, joined with a colon); anything
    /// outside a granted scope is denied before the sheet appears.
    private func share(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let kind = call.string("kind") ?? ""
        let activity: [Any]
        switch kind {
        case "text": activity = [call.string("text") ?? ""]
        case "url":
            guard let url = URL(string: call.string("url") ?? "") else {
                return done(.failure(GatewayError(
                    code: "invalid", primitive: "presentShare",
                    message: "url payload expects a valid URL string")))
            }
            activity = [url]
        case "files":
            guard let files = self.shareFiles(call, fs, done) else { return }
            activity = files
        default:
            return done(.failure(GatewayError(
                code: "invalid", primitive: "presentShare",
                message: "share payload kind must be text | url | files")))
        }
        core?.stageAuditDetail(["kind": kind])
        presentSheet(activity, done)
    }

    /// Resolves the files payload against the granted scopes; settles and
    /// returns nil on any malformed or ungranted path.
    private func shareFiles(
        _ call: GatewayCall, _ fs: FSPrimitives, _ done: @escaping GatewayDone
    ) -> [URL]? {
        let paths = (call.args["paths"] as? [String]) ?? []
        guard !paths.isEmpty else {
            done(.failure(GatewayError(
                code: "invalid", primitive: "presentShare",
                message: "files payload expects a non-empty paths array")))
            return nil
        }
        var urls: [URL] = []
        for path in paths {
            guard let (scope, rel) = Self.splitScopePath(path) else {
                done(.failure(GatewayError(
                    code: "invalid", primitive: "presentShare",
                    message: "path must be \"<scope>:<relative path>\": \(path)")))
                return nil
            }
            guard let url = shareFileURL(scope: scope, rel: rel) else {
                done(.failure(GatewayError(
                    code: "denied", primitive: "presentShare",
                    message: "path outside a granted scope: \(path)")))
                return nil
            }
            urls.append(url)
        }
        return urls
    }

    /// Resolves a granted scope root + relative path to a file URL — the
    /// containment half of the scope discipline for primitives that hand a
    /// FILE to a host subsystem. nil when the scope handle is unknown or the
    /// relative path escapes it.
    private func shareFileURL(scope: String, rel: String) -> URL? {
        guard let (root, security) = fs.scopeForMount(scope) else { return nil }
        let file = root.appendingPathComponent(rel)
        guard file.path.hasPrefix(root.path + "/") || file.path == root.path else {
            return nil
        }
        let accessed = security ? root.startAccessingSecurityScopedResource() : false
        defer { if accessed { root.stopAccessingSecurityScopedResource() } }
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// Splits "<scope>:<relative path>" into the fsRead argument pair.
    private static func splitScopePath(_ path: String) -> (String, String)? {
        guard let at = path.firstIndex(of: ":") else { return nil }
        let scope = String(path[path.startIndex..<at])
        let rel = String(path[path.index(after: at)...])
        guard !scope.isEmpty, FSPrimitives.safeRelative(rel) != nil else { return nil }
        return (scope, rel)
    }

    private func presentSheet(_ activity: [Any], _ done: @escaping GatewayDone) {
        DispatchQueue.main.async { [weak self] in
            GatewayCore.uiMarker("share", "wait")
            guard let self, let root = self.rootViewController() else {
                return done(.failure(GatewayError(
                    code: "unavailable", primitive: "presentShare",
                    message: "no key window to present on")))
            }
            let sheet = UIActivityViewController(activityItems: activity, applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = root.view
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                GatewayCore.uiMarker("share", "done")
                done(.success(["shared": completed]))
            }
            root.present(sheet, animated: true)
        }
    }

    private func rootViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let window = scenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        return window?.rootViewController
    }
}
