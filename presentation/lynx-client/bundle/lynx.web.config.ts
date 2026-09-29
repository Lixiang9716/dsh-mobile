import { defineConfig } from '@lynx-js/rspeedy';
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';

/**
 * lynx.web.config.ts — the WEB-TARGET build of the same App source, for the
 * @lynx-js/web-core platform probe (test/e2e: the screenshot-for-humans
 * channel). Output goes to dist-web/ (gitignored — a probe artifact, not the
 * product payload; the native bundle in dist/ is the payload). Build:
 *   npm run build:web
 */
export default defineConfig({
  plugins: [pluginReactLynx()],
  source: {
    entry: './src/index.tsx',
  },
  environments: {
    web: {},
  },
  output: {
    distPath: { root: 'dist-web' },
  },
});
