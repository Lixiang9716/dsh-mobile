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
        \(readTranscriptLeg);
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
          return JSON.stringify({pressed: true});
        };
        """

    /// The send button's current shape + the toast text (the composer's
    /// cancel path toasts 已请求停止 only on an accepted cancel).
    static let stopStateLeg = """
        window.__next.stopState = () => {
          const send = document.getElementById('composer-send');
          const toast = document.getElementById('toast');
          return JSON.stringify({
            stop: !!send && send.classList.contains('stop'),
            disabled: !!send && send.disabled,
            toast: toast ? toast.textContent : ''});
        };
        """

    /// The TRUE rendered transcript state: user bubble, streamed assistant
    /// markdown, streaming-tail presence, and the nav title.
    static let readTranscriptLeg = """
        window.__next.readTranscript = () => {
          const host = document.getElementById('transcript');
          const assistant = host.querySelector('.item-assistant .md');
          return JSON.stringify({
            items: host.querySelectorAll('.item').length,
            userShown: host.querySelector('.user-bubble') !== null,
            tailPresent: host.querySelector('.tail-state') !== null,
            assistant: assistant ? assistant.textContent.slice(0, 200) : '',
            title: document.getElementById('chat-title').textContent,
            status: document.getElementById('chat-status').textContent});
        };
        """
}
