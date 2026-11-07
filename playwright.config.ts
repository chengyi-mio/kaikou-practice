import { defineConfig } from "@playwright/test";
const port = Number(process.env.KAIKOU_E2E_PORT || 4173);
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 40000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    channel: "msedge",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: `http://127.0.0.1:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env.KAIKOU_E2E_PORT,
    timeout: 30000,
  },
});
