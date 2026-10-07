import Foundation

/// The GAME leg of the v2web.mount creation loop (the canvas game — the
/// viewer's first rAF artifact), split from V2WebRuntime to keep both
/// under the file-size gate (the V2WebProbe precedent). Same drive
/// posture: every wait is a Swift-side poll; the page only answers
/// stateless one-shot legs.
extension V2WebRuntime {
    // ---- the GAME leg (the creation loop's second deliverable) -------------

    /// Close the compact viewer — the overlay hides the composer, and the game
    /// turn cannot send until the page is back. The close settles on the
    /// honest facts: open flips false AND the srcdoc is cleared.
    func closeCreation() {
        pollPage("window.__next.pressCreationClose()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in self?.awaitCreationClosed() })
    }

    private func awaitCreationClosed() {
        pollPage("window.__next.readCreation()",
            until: { ($0["open"] as? Bool) == false },
            collect: { [weak self] probe in
                guard let self else { return }
                let srcdoc = probe["srcdoc"] as? String ?? "-"
                self.eventLog.emit("creation.closed", [
                    "srcdocCleared": srcdoc.isEmpty,
                ])
                self.beginGameTurn()
        })
    }

    private func beginGameTurn() {
        pollPage("window.__next.stopState()",
            until: { $0["stop"] as? Bool == false
                && $0["optimistic"] as? Bool == false },
            collect: { [weak self] _ in self?.typeGamePrompt() })
    }

    private func typeGamePrompt() {
        pollPage(
            "window.__next.typeComposer('\(Self.gameMessageText)')",
            until: { $0["sendEnabled"] as? Bool == true },
            collect: { [weak self] _ in
                self?.pressSendThenAwaitGameCard()
        })
    }

    private func pressSendThenAwaitGameCard() {
        pollPage("window.__next.pressSend()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in
                self?.awaitGameCard()
        })
    }

    /// The compact's card is still in the transcript — the game's card is
    /// identified BY TITLE (the second .creation-card), never by position
    /// alone.
    private func awaitGameCard() {
        pollPage("window.__next.readTranscript()",
            until: { probe in
                let titles = probe["creationTitles"] as? [String] ?? []
                // SUBSTRING match: the card's textContent also carries the
                // emoji + path ("🎨弹球小游戏 — 点按全屏查看creations/dsh-game.html").
                return titles.contains { $0.contains(Self.gameCardTitle) }
            },
            collect: { [weak self] probe in
                guard let self else { return }
                self.eventLog.emit("game.card.rendered", [
                    "title": Self.gameCardTitle,
                    "items": probe["items"] ?? 0,
                ])
                self.openGameViewer()
        })
    }

    private func openGameViewer() {
        pollPage("window.__next.installGameListener()",
            until: { $0["installed"] as? Bool == true },
            collect: { [weak self] _ in self?.pressLastCard() })
    }

    private func pressLastCard() {
        pollPage("window.__next.pressLastCreationCard()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in self?.awaitGameViewer() })
    }

    private func awaitGameViewer() {
        pollPage("window.__next.readCreation()",
            until: { ($0["open"] as? Bool) == true
                && ($0["srcdoc"] as? String ?? "").contains("DSH-GAME-CANARY") },
            collect: { [weak self] _ in
                guard let self else { return }
                self.eventLog.emit("game.opened", [
                    "srcdocContains": "DSH-GAME-CANARY",
                ])
                self.awaitGameAlive(0)
        })
    }

    /// The game RUNS: two heartbeat samples, the second strictly larger.
    /// A host whose driven WebView throttles the page's frames AND timers
    /// to zero fails here honestly — a real capability fact, not a race to
    /// paper over (the manifest pins `advancing: true`; the counters ride
    /// along unpinned).
    private func awaitGameAlive(_ firstTotal: Int) {
        pollPage("window.__next.readGame()",
            until: { probe in
                let total = (probe["frames"] as? Int ?? 0)
                    + (probe["beats"] as? Int ?? 0)
                return firstTotal == 0 ? total >= 1 : total > firstTotal
            },
            collect: { [weak self] probe in
                guard let self else { return }
                let frames = probe["frames"] as? Int ?? 0
                let beats = probe["beats"] as? Int ?? 0
                if firstTotal == 0 {
                    self.awaitGameAlive(frames + beats)
                } else {
                    self.emitGameFrames(frames, beats: beats)
                    self.closeGameViewer()
                }
        })
    }

    /// game.frames emitter (hoisted: the inline dictionary's continuation
    /// broke the code-size indent gate at this nesting depth).
    private func emitGameFrames(_ frames: Int, beats: Int) {
        let fields: [String: Any] = [
            "advancing": true, "frames": frames, "beats": beats]
        eventLog.emit("game.frames", fields)
    }

    private func closeGameViewer() {
        pollPage("window.__next.pressCreationClose()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in self?.awaitGameClosed() })
    }

    private func awaitGameClosed() {
        pollPage("window.__next.readCreation()",
            until: { ($0["open"] as? Bool) == false },
            collect: { [weak self] probe in
                guard let self else { return }
                let srcdoc = probe["srcdoc"] as? String ?? "-"
                self.eventLog.emit("game.closed", [
                    "srcdocCleared": srcdoc.isEmpty,
                ])
                self.finish(JsOutcome(
                    completed: true, passed: true, error: "",
                    canonicalLines: self.eventLog.lines))
        })
    }

}
