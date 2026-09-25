import Foundation
import WebKit

/// The nextweb.mount same-origin probe (the b4 precedent): the page stays
/// untouched self-hosted code — the probe defines `__next` legs that drive
/// OUR UI like a user: open a session from the home view, type into the
/// real composer, send, and then read the TRUE rendered state (the user
/// bubble + the streamed assistant markdown). Split from NextWebRuntime to
/// keep both under the file-size gate.
enum NextWebProbe {
    /// The typed message and the reply fragment the drive waits for — the
    /// carrier's scripted-loopback pair (CarrierRoutes scripted SSE, success
    /// text "Hello from upstream").
    static let messageText = "Say hello from the next client"
    static let expectedReply = "Hello from upstream"

    /// Installs the `__next` legs; every leg is its own constant so each
    /// stays small.
    static func probeScript() -> String {
        """
        window.__next = {};
        \(openLeg)
        \(typeLeg)
        \(settleLeg);
        'defined';
        """
    }

    /// Home → chat: tap the new-session card and wait for the chat view.
    static let openLeg = """
        window.__next.open = () => new Promise((resolve, reject) => {
          const button = document.getElementById('new-session');
          if (!button) return reject(new Error('no #new-session'));
          button.click();
          const deadline = Date.now() + 10000;
          const poll = () => {
            const chat = document.getElementById('view-chat');
            if (chat && !chat.hidden) return resolve(JSON.stringify({chatVisible: true}));
            if (Date.now() > deadline) return reject(new Error('chat view never shown'));
            setTimeout(poll, 100);
          };
          poll();
        });
        """

    /// Type into the real composer (value + input event — the composer's
    /// own listener owns the send-button enablement).
    static let typeLeg = """
        window.__next.type = (text) => {
          const input = document.getElementById('composer-input');
          if (!input) return JSON.stringify({found: false});
          input.value = text;
          input.dispatchEvent(new Event('input', {bubbles: true}));
          return JSON.stringify({found: true, value: input.value,
            sendEnabled: !document.getElementById('composer-send').disabled});
        };
        """

    /// Send, then settle: resolve when the assistant's final markdown row is
    /// rendered AND the streaming tail is gone (the durable message promoted
    /// the text), reading the true DOM facts the manifest pins.
    static let settleLeg = """
        window.__next.sendAndSettle = () => new Promise((resolve, reject) => {
          const send = document.getElementById('composer-send');
          if (!send || send.disabled) return reject(new Error('send button not ready'));
          send.click();
          const deadline = Date.now() + 30000;
          const poll = () => {
            const items = document.querySelectorAll('#transcript .item').length;
            const userShown = document.querySelector('#transcript .user-bubble') !== null;
            const assistant = document.querySelector('#transcript .item-assistant .md');
            const tailGone = document.querySelector('.tail-state') === null;
            if (items > 0 && userShown && assistant !== null && tailGone
              && assistant.textContent.includes('Hello from upstream')) {
              return resolve(JSON.stringify({items, userShown,
                assistant: assistant.textContent.slice(0, 200), tailGone,
                title: document.getElementById('chat-title').textContent}));
            }
            if (Date.now() > deadline) {
              return reject(new Error('reply never rendered; items=' + items
                + ' user=' + userShown + ' tailGone=' + tailGone));
            }
            setTimeout(poll, 120);
          };
          poll();
        });
        """
}
