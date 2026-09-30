import { defineConfig } from 'vitest/config';

// Coverage over web/js — INCLUDING the browser-only files at their honest
// (near-zero) numbers: main.js, render-chat.js, render-home.js, composer.js
// and markdown.js's render half are DOM-tied and stay untested here on
// purpose (no fake jsdom coverage). The Node-runnable faces are api.js
// (envelope bridge), mux.js (WS state machine, over a real socket) and
// timeline.js (the journal fold).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['web/js/**/*.js'],
    },
  },
});
