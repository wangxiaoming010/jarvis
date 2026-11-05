import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4331",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "local", testMatch: "workbench.spec.ts" },
    {
      name: "cloud",
      testMatch: "cloud.spec.ts",
      use: { baseURL: "http://127.0.0.1:4332" },
    },
  ],
  webServer: [
    {
      command: "npx tsx tests/browser-server.ts",
      url: "http://127.0.0.1:4331/api/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "npx tsx tests/cloud-browser-server.ts",
      url: "http://127.0.0.1:4332/api/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
