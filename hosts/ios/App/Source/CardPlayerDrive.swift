import Foundation

/// The card-player drive (`-dsh-mode card-player`): the serving seat with
/// the card leg selected and the NATIVE CardPlayerSurface wired — the
/// scenario's `card.present`/`card.state`/`card.complete` bus lines render
/// as a live card over the app's own chrome. PR-1 of the
/// create-approve-hotmount-native loop: the surface the generated pomodoro
/// plugin will speak to (PR-2/3 plug the generation and the install into
/// this same contract).
enum CardPlayerDrive {
    /// The mode-table entry: banner + the canonical stdout line, then the
    /// drive (the MicPlane shape — announce(web:) builds the WebView the
    /// origin loads into).
    static func launch(_ appDelegate: AppDelegate) {
        appDelegate.announce(
            "DSH card player — card.player, a plugin card in the app's own chrome…",
            line: "rt: app launched in card-player mode", web: true)
        run(appDelegate)
    }

    static func run(_ appDelegate: AppDelegate) {
        let surface = CardPlayerSurface()
        appDelegate.cardSurface = surface
        let serve = SessionServe(
            credential: SessionServe.loadCredential(),
            interactive: false)
        appDelegate.serve = serve
        serve.scenarioEntry = (
            accessor: dsh_runtime_res_scenario_card_player_js,
            path: "scenario/card-player.js"
        )
        serve.onOrigin = { [weak appDelegate] origin in
            appDelegate?.webView?.load(URLRequest(url: origin))
        }
        serve.onCardEvent = { [weak surface] msg in
            DispatchQueue.main.async { surface?.handle(msg) }
        }
        serve.onRuntimeFailure = { message in
            NSLog("%@", "dsh.session.serve: runtime failed: \(message)")
        }
        if let host = appDelegate.webView?.superview {
            surface.attach(to: host)
        }
        do {
            try serve.start()
        } catch {
            NSLog("%@", "dsh.session.serve: bootstrap failed: \(error)")
            print("rt: card-player bootstrap failed: \(error)")
            fflush(stdout)
        }
    }
}
