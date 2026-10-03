import { defineConfig, devices } from '@playwright/test';

// Browser tests against the app in fixture mode: no network, no AWS. The app
// needs DATABASE_URL, the same as `pnpm dev` (see infra/compose.dev.yml).
const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 375, height: 812 },
  },
  webServer: {
    command: `next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { MODEL_MODE: 'fixture' },
  },
});
