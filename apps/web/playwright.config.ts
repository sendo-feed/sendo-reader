import { defineConfig, devices } from "@playwright/test";
import { FAKE_UPDATES_PORT } from "./e2e/fake-updates";

/**
 * 画面を通したテスト（docs/decisions/performance.md の関所を含む）。本番のビルド（pnpm build）を
 * vite preview（本番と同じヘッダー）で開く。sendo の API は、テストの中で偽の sendo が答える。
 * 通知（WebSocket）は、ワーカーから開くので Playwright では横取りできない。vite preview の中継の先を
 * 偽の通知のサーバー（e2e/fake-updates.ts）に向ける
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
    // CI では、やり直す回（retries）だけトレースを録る。全部のテストで録ると、そのぶん CPU を使い、
    // 遅くなる。手元はやり直さないので、失敗したテストのトレースを残す
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    env: { SENDO_DEV_URL: `http://127.0.0.1:${FAKE_UPDATES_PORT}` },
  },
});
