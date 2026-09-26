import Foundation
import WebKit

/// The nextweb.mount same-origin probe (the b4 precedent): the page stays
/// untouched self-hosted code — the probe defines `__next` legs that drive
/// OUR UI like a user. Every leg is a STATELESS one-shot evaluate that
/// returns immediately: the DRIVE owns all waiting (its own Swift timers —
/// a driven WKWebView throttles the page's timers to near-zero, so page-
/// side polling loops are unusable). Split from NextWebRuntime to keep both
/// under the file-size gate.
enum NextWebProbe {
    /// The typed messages and the reply fragment the drive waits for — the
    /// carrier's scripted-loopback pair (CarrierRoutes scripted SSE, success
    /// text "Hello from upstream"). The second message carries SLOW_TURN,
    /// the drip-script marker the cancel leg streams against.
    static let messageText = "Say hello from the next client"
    static let cancelMessageText = "SLOW_TURN keep going"
    static let expectedReply = "Hello from upstream"

    /// Installs the `__next` legs; every leg is its own constant so each
    /// stays small.
    static func probeScript() -> String {
        """
        window.__next = {};
        \(clickNewSessionLeg)
        \(chatVisibleLeg)
        \(typeLeg)
        \(pressSendLeg)
        \(stopStateLeg)
        \(readTranscriptLeg)
        \(pressCreationCardLeg)
        \(readCreationLeg);
        'defined';
        """
    }

    /// Home → the new-session card (one tap; the drive re-taps if needed).
    static let clickNewSessionLeg = """
        window.__next.clickNewSession = () => {
          const button = document.getElementById('new-session');
          if (!button) return JSON.stringify({clicked: false});
          button.click();
          return JSON.stringify({clicked: true});
        };
        """

    static let chatVisibleLeg = """
        window.__next.chatVisible = () => {
          const chat = document.getElementById('view-chat');
          if (!chat || chat.hidden) {
            // served ≠ executed: the page's module may not have registered
            // the click listener yet — RE-TAP until the view flips (the
            // runtime's createOrAdopt absorbs the extra taps).
            document.getElementById('new-session')?.click();
          }
          return JSON.stringify({chatVisible: !!chat && !chat.hidden});
        };
        """

    /// Type into the real composer (value + input event — the composer's
    /// own listener owns the send-button enablement).
    static let typeLeg = """
        window.__next.typeComposer = (text) => {
          const input = document.getElementById('composer-input');
          if (!input) return JSON.stringify({found: false});
          input.value = text;
          input.dispatchEvent(new Event('input', {bubbles: true}));
          const send = document.getElementById('composer-send');
          return JSON.stringify({found: true, value: input.value,
            sendEnabled: !!send && !send.disabled});
        };
        """

    /// One press of the send/stop button (which shape it is, the drive
    /// reads from stopState).
    static let pressSendLeg = """
        window.__next.pressSend = () => {
          const send = document.getElementById('composer-send');
          if (!send) return JSON.stringify({pressed: false});
          send.click();
          return JSON.stringify({pressed: true,
            stopShown: send.classList.contains('stop')});
        };
        """

    /// The send button's current shape + the toast text (the composer's
    /// cancel path toasts 已请求停止 only on an accepted cancel).
    static let stopStateLeg = """
        window.__next.stopState = () => {
          const send = document.getElementById('composer-send');
          const toast = document.getElementById('toast');
          const dbg = window.__dshComposerDebug ? window.__dshComposerDebug() : {};
          return JSON.stringify({
            stop: !!send && send.classList.contains('stop'),
            disabled: !!send && send.disabled,
            toast: (toast ? toast.textContent : '').slice(0, 40),
            running: dbg.running === true,
            optimistic: dbg.optimistic === true,
            session: String(dbg.sessionId ?? '').slice(0, 10)});
        };
        """

    /// The TRUE rendered transcript state: user bubble, streamed assistant
    /// markdown, streaming-tail presence, and the nav title.
    static let readTranscriptLeg = """
        window.__next.readTranscript = () => {
          const host = document.getElementById('transcript');
          const assistant = host.querySelector('.item-assistant .md');
          const dbg = window.__dshComposerDebug ? window.__dshComposerDebug() : {};
          return JSON.stringify({
            toast: (document.getElementById('toast')?.textContent ?? '').slice(0, 50),
            sent: window.__dshSentCount ?? 0,
            sendError: window.__dshSendError ?? '',
            muxFrames: window.__dshMuxDiag ? window.__dshMuxDiag.frames : -1,
            items: host.querySelectorAll('.item').length,
            userShown: host.querySelector('.user-bubble') !== null,
            tailPresent: host.querySelector('.tail-state') !== null,
            creationCard: host.querySelector('.creation-card') !== null,
            dump: [...host.querySelectorAll('.item, .group')].map((n) =>
              (n.className.split(' ')[0] || 'div') + ':' +
              n.textContent.slice(0, 24)).join(' | ').slice(0, 420),
            assistant: assistant ? assistant.textContent.slice(0, 200) : '',
            title: document.getElementById('chat-title').textContent,
            status: document.getElementById('chat-status').textContent,
            toast: (document.getElementById('toast')?.textContent ?? '').slice(0, 60)});
        };
        """

    /// Tap the first creation card (opens the fullscreen viewer).
    static let pressCreationCardLeg = """
        window.__next.pressCreationCard = () => {
          const card = document.querySelector('.creation-card');
          if (!card) return JSON.stringify({pressed: false});
          card.click();
          return JSON.stringify({pressed: true});
        };
        """

    /// The creation viewer's state: open + the frame's srcdoc (the drive
    /// waits for its staged canary to prove the file's CONTENT rendered).
    static let readCreationLeg = """
        window.__next.readCreation = () => {
          const frame = document.getElementById('creation-frame');
          const view = document.getElementById('creation-view');
          return JSON.stringify({
            open: !!view && !view.hidden,
            srcdoc: frame ? frame.srcdoc.slice(0, 400) : ''});
        };
        """
}
