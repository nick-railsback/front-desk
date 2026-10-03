import { configDefaults, defineConfig } from 'vitest/config';

// Browser tests under tests/e2e/ run with Playwright (`pnpm test:e2e`), never
// under `pnpm test`: they need a running app and a browser.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
