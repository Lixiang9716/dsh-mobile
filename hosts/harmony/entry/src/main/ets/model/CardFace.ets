// dsh:logging-exempt (pure state model: no logging surface of its own)

/**
 * CardFace — the state model of the native card face on Harmony (the ArkTS
 * sibling of hosts/ios CardPlayerSurface.swift and hosts/android
 * CardSurface.kt, #452's PiP shape): a plugin speaks bus lines (`card.present`
 * / `card.state` / `card.dismiss` / `card.complete`) and the page renders the
 * projected face through the @State bindings Index.ets binds. PiP posture:
 * the card anchors TOP under the safe area — never over the bottom-docked
 * composer — and is locally closable (the ✕); drag comes free with the
 * position offsets the page holds. Dismissal authority stays the plugin's
 * per the contract: a locally closed card ignores later state records and
 * the next card.present re-shows it. No contract change.
 *
 * Timer cards tick locally between authoritative card.state patches (a 250
 * ms interval re-renders the countdown from the anchor — the page owns the
 * timer through the visible flag's @Watch).
 */
export class CardFace {
  /** The projected face (volatile across threads: the /api/state seam
   * reads it from a connection thread while the bus hops onto main). */
  private static face: Record<string, Object> = CardFace.blank();

  private static blank(): Record<string, Object> {
    return CardFace.projected(true, false, '');
  }

  /** One projected {card: …} record built key-by-key (ArkTS forbids
   * untyped object literals and spreads). */
  private static projected(attached: boolean, visible: boolean,
    id: string): Record<string, Object> {
    const card: Record<string, Object> = { 'attached': attached, 'visible': visible };
    if (id.length > 0) {
      card['id'] = id;
    }
    const out: Record<string, Object> = { 'card': card };
    return out;
  }

  /** The presented card (empty when none). */
  private static card: Record<string, Object> = {};
  /** Milliseconds left, anchored at [anchorAt]. */
  private static remainingMs: number = 0;
  private static anchorAt: number = 0;

  /** One bus card.* record (main thread). */
  static handle(type: string, msg: Record<string, Object>): void {
    if (type === 'card.present') {
      const record = msg['card'] as Record<string, Object> ?? {};
      const id = String(record['id'] ?? '');
      if (id.length === 0) {
        return;
      }
      CardFace.card = record;
      CardFace.remainingMs = Number(record['durationMs'] ?? 0);
      CardFace.anchorAt = Date.now();
    } else if (type === 'card.state') {
      if (!CardFace.visible()) {
        return;
      }
      const patch = msg['state'] as Record<string, Object> ?? {};
      const remaining = Number(patch['remainingMs'] ?? NaN);
      if (!Number.isNaN(remaining)) {
        CardFace.remainingMs = remaining;
        CardFace.anchorAt = Date.now();
      }
      const label = String(patch['label'] ?? '');
      if (label.length > 0) {
        CardFace.card['label'] = label;
      }
    } else if (type === 'card.complete') {
      if (!CardFace.visible()) {
        return;
      }
      CardFace.card['completeMessage'] = String(msg['message'] ?? '完成');
    }
    CardFace.project();
  }

  static dismiss(): void {
    CardFace.project();
  }

  /** Whether a card is live (the page's @Watch drives the local tick). */
  static visible(): boolean {
    const card = CardFace.face['card'] as Record<string, Object>;
    return card['visible'] === true;
  }

  /** The projected face for the GET /api/state seam (any thread). */
  static snapshot(): Record<string, Object> {
    const card = CardFace.face['card'] as Record<string, Object>;
    const visible = card['visible'] === true;
    const id = visible ? String(card['id'] ?? '') : '';
    return CardFace.projected(true, visible, id);
  }

  /** Re-projects the face from the model (called by the page's tick and
   * after every handled record). */
  static project(): void {
    const card: Record<string, Object> = {
      'attached': true,
      'visible': Object.keys(CardFace.card).length > 0,
    };
    if (Object.keys(CardFace.card).length > 0) {
      card['id'] = String(CardFace.card['id'] ?? '');
      card['title'] = String(CardFace.card['title'] ?? card['id']);
      card['kind'] = String(CardFace.card['kind'] ?? 'info');
      const remaining = CardFace.remainingMs - (Date.now() - CardFace.anchorAt);
      if (String(CardFace.card['kind']) === 'timer') {
        card['remainingText'] = CardFace.clock(Math.max(0, remaining));
      }
      const label = String(CardFace.card['label'] ?? '');
      if (label.length > 0) {
        card['label'] = label;
      }
      const complete = String(CardFace.card['completeMessage'] ?? '');
      if (complete.length > 0) {
        card['completeMessage'] = complete;
      }
    }
    CardFace.face = CardFace.wrap(card);
  }

  private static wrap(card: Record<string, Object>): Record<string, Object> {
    const out: Record<string, Object> = { 'card': card };
    return out;
  }

  private static clock(ms: number): string {
    const total = Math.floor(ms / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
