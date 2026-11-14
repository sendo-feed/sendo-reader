import { defineConfig, devices } from "@playwright/test";

/**
 * 画面を通したテスト（docs/decisions/performance.md の関所を含む）。本番のビルド（pnpm build）を
 * vite preview（本番と同じヘッダー）で開く。sendo の API は、テストの中で偽の sendo が答える。
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // 時間を測るテストがあるので、1 つずつ動かす
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
