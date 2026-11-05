import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1421',
    viewport: { width: 1440, height: 940 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev.mjs --test',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 60000,
  },
  reporter: 'list',
});
