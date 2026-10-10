import UIKit

/// CardPlayerSurface — the NATIVE half of the plugin card contract (PR-1 of
/// the create-approve-hotmount-native loop). A cordis plugin speaks bus lines
/// (`card.present` / `card.state` / `card.dismiss` / `card.complete`); this
/// surface renders them as a live card floating over the app's own chrome —
/// the plugin manifests in the app, NOT as an HTML page (the owner's
/// explicit product bar).
///
/// The pomodoro shape drives the design: `kind: "timer"` cards carry a
/// `durationMs` and the surface ticks locally between authoritative
/// `card.state` patches, so a once-per-second plugin tick still renders a
/// smooth countdown (and the card survives a dropped tick honestly — the
/// next patch resnaps the remaining time).
///
/// UIKit on purpose: the app's window is UIKit-built; hosting SwiftUI here
/// would add a lifetime bridge for no gain.
final class CardPlayerSurface {
    private weak var hostView: UIView?
    private var cardView: CardView?
    private var tickTimer: Timer?
    private var card: [String: Any] = [:]

    // The local tick model: authoritative fields from card.state, plus the
    // instant the local countdown anchored to.
    private var remainingMs: Double = 0
    private var anchor: Date = .init()

    final class CardView: UIView {
        let titleLabel = UILabel()
        let timeLabel = UILabel()
        let subtitleLabel = UILabel()
        let progress = UIProgressView(progressViewStyle: .default)
    }

    func attach(to view: UIView) {
        hostView = view
    }

    // ---- the four contract events -------------------------------------------

    /// Main-thread only (the drive hops bus events onto main before calling).
    func handle(_ msg: [String: Any]) {
        guard let type = msg["type"] as? String else { return }
        switch type {
        case "card.present": present(msg)
        case "card.state": state(msg)
        case "card.complete": complete(msg)
        case "card.dismiss": dismiss()
        default: break
        }
    }

    private func present(_ msg: [String: Any]) {
        guard let card = msg["card"] as? [String: Any],
              let id = card["id"] as? String else { return }
        self.card = card
        remainingMs = (card["durationMs"] as? Double) ?? 0
        anchor = Date()
        showCard(id: id, title: card["title"] as? String ?? id,
                 subtitle: card["subtitle"] as? String,
                 kind: card["kind"] as? String ?? "info")
        GatewayCore.uiMarker("card-present", "wait")
    }

    private func state(_ msg: [String: Any]) {
        guard cardView != nil, let state = msg["state"] as? [String: Any] else { return }
        if let remaining = state["remainingMs"] as? Double {
            remainingMs = remaining
            anchor = Date()
        }
        if let label = state["label"] as? String {
            cardView?.subtitleLabel.text = label
        }
        render()
    }

    private func complete(_ msg: [String: Any]) {
        guard cardView != nil else { return }
        remainingMs = 0
        cardView?.subtitleLabel.text = (msg["message"] as? String) ?? "完成"
        render()
        GatewayCore.uiMarker("card-present", "done")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.dismiss()
        }
    }

    private func dismiss() {
        tickTimer?.invalidate()
        tickTimer = nil
        guard let view = cardView else { return }
        UIView.animate(withDuration: 0.3, animations: {
            view.alpha = 0
            view.transform = CGAffineTransform(translationX: 0, y: 60)
        }, completion: { _ in
            view.removeFromSuperview()
        })
        cardView = nil
    }

    // ---- rendering ------------------------------------------------------------

    private func showCard(id: String, title: String, subtitle: String?, kind: String) {
        dismiss()
        guard let host = hostView else { return }
        let card = buildCardView(id: id, title: title, subtitle: subtitle, kind: kind)
        activateCardConstraints(card, in: host)
        cardView = card
        card.alpha = 0
        card.transform = CGAffineTransform(translationX: 0, y: 60)
        UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.8,
                       initialSpringVelocity: 0.4) {
            card.alpha = 1
            card.transform = .identity
        }
        render()
        // The local tick: between authoritative state patches the countdown
        // runs on the main run loop; the run loop never touches the runtime.
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) {
            [weak self] _ in self?.render()
        }
    }

    private func buildCardView(
        id: String, title: String, subtitle: String?, kind: String
    ) -> CardView {
        let card = CardView(frame: .zero)
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 18
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.18
        card.layer.shadowRadius = 14
        card.layer.shadowOffset = CGSize(width: 0, height: 6)

        card.titleLabel.text = title
        card.titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)

        // Non-timer cards (calendar/info/…): no countdown — the subtitle IS
        // the face (a calendar shows its date line, not 00:00).
        if kind != "timer" {
            card.timeLabel.font = .systemFont(ofSize: 20, weight: .medium)
        } else {
            card.timeLabel.font = .monospacedDigitSystemFont(ofSize: 44, weight: .medium)
        }
        card.timeLabel.textAlignment = .center
        card.timeLabel.adjustsFontSizeToFitWidth = true
        card.timeLabel.numberOfLines = kind == "timer" ? 1 : 3

        card.subtitleLabel.text = subtitle ?? ""
        card.subtitleLabel.font = .systemFont(ofSize: 13)
        card.subtitleLabel.textColor = .secondaryLabel
        card.subtitleLabel.textAlignment = .center

        card.progress.progressViewStyle = .default
        card.progress.progressTintColor = kind == "timer"
            ? .systemOrange : .systemBlue
        if kind != "timer" { card.progress.alpha = 0 }

        for sub in [card.titleLabel, card.timeLabel, card.subtitleLabel, card.progress] {
            sub.translatesAutoresizingMaskIntoConstraints = false
            card.addSubview(sub)
        }
        return card
    }

    private func activateCardConstraints(_ card: CardView, in host: UIView) {
        card.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(card)
        let safe = host.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalToSystemSpacingAfter: safe.leadingAnchor, multiplier: 1.5),
            safe.trailingAnchor.constraint(equalToSystemSpacingAfter: card.trailingAnchor, multiplier: 1.5),
            safe.bottomAnchor.constraint(equalToSystemSpacingBelow: card.bottomAnchor, multiplier: 2),
            card.heightAnchor.constraint(equalToConstant: 148),
            card.titleLabel.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            card.titleLabel.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            card.timeLabel.topAnchor.constraint(equalTo: card.titleLabel.bottomAnchor, constant: 8),
            card.timeLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            card.timeLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            card.progress.topAnchor.constraint(equalTo: card.timeLabel.bottomAnchor, constant: 10),
            card.progress.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            card.progress.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
            card.subtitleLabel.topAnchor.constraint(equalTo: card.progress.bottomAnchor, constant: 8),
            card.subtitleLabel.centerXAnchor.constraint(equalTo: card.centerXAnchor),
        ])
    }

    private func render() {
        guard let view = cardView else { return }
        if (card["kind"] as? String) != "timer" {
            // Non-timer cards: the label face (a calendar's date line) —
            // no countdown clock on a card that isn't counting.
            view.timeLabel.text = (card["label"] as? String)
                ?? view.subtitleLabel.text ?? ""
            return
        }
        let elapsed = Date().timeIntervalSince(anchor) * 1000
        let current = max(0, remainingMs - elapsed)
        let total = (card["durationMs"] as? Double) ?? 0
        view.timeLabel.text = Self.clock(current)
        if total > 0 {
            view.progress.setProgress(Float(1 - current / total), animated: true)
        }
    }

    private static func clock(_ ms: Double) -> String {
        let total = Int(ms / 1000)
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}
