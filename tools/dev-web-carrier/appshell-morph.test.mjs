// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * appshell-morph.test.mjs — the M2 acceptance leg: one prompt per theme
 * (微信 → 网易云音乐 → 支付宝), each producing an appshell_render tool card
 * whose preview renders from the echoed spec, then the fullscreen presented
 * surface opens with the theme's own accent and closes cleanly. Browser
 * assertions only — screenshots stay a local artifact, never the verdict.
 * Also pins the "fourth app" counterfactual at the E2E layer: three themes,
 * zero renderer edits between them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { openCarriedPage, closeCarriedPage, waitFor, STATES } from '../../test/tools/helpers/carrier-page.mjs';

const THEMES = [
  { prompt: '变成微信', label: '微信', accent: '#07C160' },
  { prompt: '变成网易云音乐', label: '网易云音乐', accent: '#ec4141' },
  { prompt: '变成支付宝', label: '支付宝', accent: '#1677FF' },
];

const carried = openCarriedPage();
let page;
const pageErrors = [];
afterAll(async () => {
  if (page) expect(pageErrors, 'page errors: ' + pageErrors.join(' | ')).toEqual([]);
  await closeCarriedPage(await carried);
});


const forceCloseSurface = () => page.evaluate(() => {
  const view = document.getElementById('appshell-view');
  if (view && !view.hidden) {
    document.getElementById('appshell-close')?.click();
    view.hidden = true;
  }
});

/** Fold + composer fully quiescent: item count stable across two samples
 * 400ms apart and the composer out of generating. A prompt sent inside the
 * drain window is answered session/busy (measured). */
const waitTurnSettled = async () => {
  let previous = -1;
  await waitFor(
    async () => {
      const snapshot = await page.evaluate(() => ({
        items: window.__dshTimelineDebug?.()?.items ?? -1,
        running: window.__dshComposerDebug?.()?.running ?? true,
      }));
      const settled = !snapshot.running && snapshot.items === previous && previous >= 0;
      previous = snapshot.items;
      return settled;
    },
    'the previous turn fully settled (stable fold + composer idle)',
  );
};

const sendPrompt = async (text) => {
  await page.waitForSelector('#composer-input', { visible: true });
  await page.click('#composer-input');
  await page.type('#composer-input', text);
  await page.click('#composer-send');
};


const cardRenderedFor = (label) => page.evaluate((label2) => {
  const rows = [...document.querySelectorAll('.appshell-tool-row')];
  const last = rows[rows.length - 1];
  return last !== undefined && last.textContent.includes(label2)
    && last.querySelector('.appshell-open-btn') !== null
    && last.querySelector('.appshell-preview')?.children?.length > 0;
}, label);

/** The composer drops a prompt that lands in the previous turn's drain
 * window (session/busy, toasted) — the honest retry is sending again,
 * bounded, condition-waited. */
const sendPromptWithRetry = async (text, label) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendPrompt(text);
    try {
      await waitFor(() => cardRenderedFor(label), 'card (attempt ' + (attempt + 1) + ')', 6000);
      return;
    } catch {
      const busy = await page.evaluate(() => window.__dshSendError === 'session/busy');
      if (!busy || attempt === 2) {
        const err = await page.evaluate(() => window.__dshSendError);
        throw new Error('card never rendered for ' + label + ' (sendError: ' + err + ')');
      }
      await page.evaluate(() => { window.__dshSendError = null; });
    }
  }
};

/** Atomic in-page: expand the card's process group, wait for the open
 * button to be visible, click it — ElementHandles go stale across the
 * fold's structure bumps, so nothing crosses a render. */
const openSurfaceByLabel = async (label) => {
  await waitFor(
    () => page.evaluate((label2) => {
      const rows = [...document.querySelectorAll('.appshell-tool-row')];
      const last = rows[rows.length - 1];
      if (!last || !last.textContent.includes(label2)) return false;
      const group = last.closest('.group');
      if (group && !group.classList.contains('open')) group.querySelector('.group-header')?.click();
      const button = last.querySelector('.appshell-open-btn');
      if (!button || button.offsetParent === null) return false;
      button.click();
      return true;
    }, label),
    'the ' + label + ' surface opened by clicking its card button',
  );
};

const assertSurface = async (theme) => {
  await waitFor(
    () => page.evaluate((accent) => {
      const view = document.getElementById('appshell-view');
      return view?.hidden === false
        && document.getElementById('appshell-title-text')?.textContent !== ''
        && view.querySelector('.ash-card') !== null
        && getComputedStyle(view.querySelector('.creation-header')).backgroundColor.includes(
          accent === '#07C160' ? '7, 193, 96' : accent === '#ec4141' ? '236, 65, 65' : '22, 119, 255');
    }, theme.accent),
    'the fullscreen ' + theme.label + ' surface with its own accent',
  );
};

const switchTabLocal = async () => {
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#appshell-view .ash-tab')];
    tabs[tabs.length - 1].click();
  });
  await waitFor(
    () => page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#appshell-view .ash-tab')];
      return tabs.length > 1 && tabs[tabs.length - 1].classList.contains('active')
        && !tabs[0].classList.contains('active');
    }),
    'the local tab switch (no turn emitted)',
  );
};

const assertActionLoopback = async () => {
  const hasButton = await page.evaluate(() => document.querySelector('#appshell-view .ash-btn') !== null);
  if (!hasButton) return; // wechat: pure chat list — the tab switch above covered local-only
  await page.evaluate(() => document.querySelector('#appshell-view .ash-btn')?.click());
  await waitFor(
    () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('.user-bubble')];
      return bubbles.some((b) => b.textContent.startsWith('[appshell:'));
    }),
    'the app-shell action landed as a tagged user turn',
  );
};

const closeSurfaceAndDrain = async (label) => {
  await page.click('#appshell-close');
  await waitFor(
    () => page.evaluate((label2) => {
      const title = document.getElementById('chat-title')?.textContent ?? '';
      return document.getElementById('appshell-view')?.hidden === true && title.includes(label2);
    }, label),
    'the surface closed and the turn chain fully drained (title = ' + label + ')',
  );
};

const runMorph = async (theme) => {
  await waitTurnSettled();
  await sendPromptWithRetry(theme.prompt, theme.label);
  await openSurfaceByLabel(theme.label);
  await assertSurface(theme);
  await switchTabLocal();
  await assertActionLoopback();
  await closeSurfaceAndDrain(theme.label);
};

describe('one-prompt app morphing on the dev carrier', () => {
  it('boots, closes first-run onboarding, and opens the fixture session', async () => {
    const env = await carried;
    page = env.page;
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await STATES.home.drive(page);
    await STATES.session.drive(page);
  });

  for (const theme of THEMES) {
    it('morphs to ' + theme.label + ' from one prompt', async () => {
      // A failed assertion must not leave the presented surface open over
      // the page — that cascaded into every later theme (measured).
      try {
        await runMorph(theme);
      } finally {
        await forceCloseSurface();
      }
    });
  }

  it('three themes, zero page errors — the renderer never changed between them', async () => {
    expect(pageErrors).toEqual([]);
  });
});
