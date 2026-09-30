import { defineConfig } from 'vitest/config';

// The panel suite scopes collection to THIS directory: the repo's other
// trees carry their own suites (and the vendored corpus carries thousands),
// and a default-include run from the repo root sweeps them all (measured:
// 173 files, 3 failures that are not ours — vendored zod's own specs).
export default defineConfig({
  test: {
    include: ['*.test.js'],
    environment: 'node',
  },
});
