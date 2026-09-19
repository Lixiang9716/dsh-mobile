import Foundation
import UserNotifications

/// notify (contract/primitives.md §5) plus both frozen event channels. The
/// first call requests .alert+.sound authorization (the system prompt is the
/// automatable "notification-permission" surface); scheduling answers
/// `{id: "n:<uuid>"}`. The center delegate delivers `notify.response` — and,
/// frozen order, THEN `app.state foreground` — when the user taps a banner;
/// app.state edges also flow from the UIApplication lifecycle while the m2
/// session is live (deduped to state changes).
final class NotifyPrimitive: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private weak var core: GatewayCore?
    private let stateLock = NSLock()
    private var authRequested = false
    private var lastState: String?

    init(core: GatewayCore) {
        self.core = core
        super.init()
        center.delegate = self
        core.register(name: "notify") { call, done in self.schedule(call, done) }
    }

    // ---- notify --------------------------------------------------------------

    private func schedule(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let title = call.string("title") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "notify", message: "missing title")))
        }
        let first = !authRequested
        authRequested = true
        if first { GatewayCore.uiMarker("notification-permission", "wait") }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            if first { GatewayCore.uiMarker("notification-permission", "done") }
            guard let self else { return }
            guard granted else {
                return done(.failure(GatewayError(
                    code: "denied", primitive: "notify",
                    message: "notification authorization refused by user policy")))
            }
            self.deliver(call.args, title: title, done)
        }
    }

    private func deliver(_ payload: [String: Any], title: String, _ done: @escaping GatewayDone) {
        let content = UNMutableNotificationContent()
        content.title = title
        if let body = payload["body"] as? String { content.body = body }
        if let threadId = payload["threadId"] as? String { content.threadIdentifier = threadId }
        if let data = payload["data"] as? [String: Any] { content.userInfo = data }
        let id = "n:\(UUID().uuidString)"
        // 5s trigger, not nil: an immediate delivery while the app is
        // foreground is consumed by willPresent and never reaches
        // Notification Center, so a caller that backgrounds right after
        // scheduling (the E2E banner-tap leg) would have nothing to tap.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        center.add(request) { error in
            if let error {
                done(.failure(GatewayError(
                    code: "io", primitive: "notify", message: "\(error)")))
            } else {
                done(.success(["id": id]))
            }
        }
    }

    // ---- UNUserNotificationCenterDelegate -------------------------------------

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions)
            -> Void
    ) {
        completionHandler([.banner, .sound]) // foreground still shows the banner
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        var event: [String: Any] = [
            "event": "notify.response",
            "id": response.notification.request.identifier,
        ]
        let action = response.actionIdentifier
        if !action.isEmpty, action != UNNotificationDefaultActionIdentifier {
            event["action"] = action
        }
        emitEvent(event) // frozen order: notify.response first...
        deliverState("foreground") // ...then app.state foreground
        completionHandler()
    }

    // ---- app.state channel ----------------------------------------------------

    /// Session lifecycle (main thread) forwards UIApplication edges here.
    /// After a background delivery the driver's banner-wait marker prints.
    func appState(_ state: String) {
        deliverState(state)
        if state == "background" { GatewayCore.uiMarker("notification-banner", "wait") }
    }

    private func deliverState(_ state: String) {
        stateLock.lock()
        guard lastState != state else {
            stateLock.unlock()
            return
        }
        lastState = state
        stateLock.unlock()
        emitEvent(["event": "app.state", "state": state])
    }

    private func emitEvent(_ obj: [String: Any]) {
        guard let line = GatewayCore.jsonLine(obj) else { return }
        core?.emit?(line)
    }
}
