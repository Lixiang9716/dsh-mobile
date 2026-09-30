import { defineConfig } from 'vitest/config';

// Coverage over the driver face: every module Node actually exercises when
// the suites run, PLUS the untouched ones (driver.js, skin-stub.js,
// mock-serve.mjs — loaded only by the loop suite) so the number is honest
// about what exists, not just what happens to be imported. The two
// self-executing runners (run-mock.mjs / run-lynx.mjs) are excluded — they
// are the loop's *shells*; every check they make is formalized in
// tests/driver-loop.test.js against the same modules. The ReactLynx bundle
// (bundle/) is engine-only and stays outside the Node-testable face.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['driver/**/*.js', 'driver/**/*.mjs', 'shared/**/*.js'],
      exclude: ['driver/run-lynx.mjs', 'driver/run-mock.mjs'],
    },
  },
});
