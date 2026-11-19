/**
 * コンテナ版の reader のサーバーの入口（docs/decisions/container.md）。設定を読んで組み立てるだけにし、
 * 処理の中身は app.ts に置く。HTTP だけを受け、TLS は手前のリバースプロキシで終える。
 *
 * 設定（環境変数）
 * - SENDO_URL：中継の先の sendo のオリジン。既定は http://sendo:8787（compose の中の名前）
 * - PORT：受けるポート。既定は 8080
 * - HOST：受けるアドレス。既定は 0.0.0.0
 * - DIST_DIR：画面のビルドの置き場。既定は、このバンドル（dist-server/server.mjs）から見た ../dist
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createReaderServer } from "./app";
import { loadAssets } from "./assets";
import { type Env, parsePort, parseSendoUrl } from "./config";
import { createSyncUpdatesProxy } from "./sync-updates";

/** 止めるときに、処理中のリクエストを待つ上限 */
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;

function distDirectory(env: Env): string {
  return env.DIST_DIR?.trim() || fileURLToPath(new URL("../dist", import.meta.url));
}

async function main(env: Env): Promise<void> {
  const sendoOrigin = parseSendoUrl(env.SENDO_URL);
  const port = parsePort(env.PORT);
  const assets = await loadAssets(distDirectory(env));
  const app = createReaderServer({ assets, sendoOrigin });
  const updates = createSyncUpdatesProxy(sendoOrigin);

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: env.HOST?.trim() || "0.0.0.0",
      serverOptions: { shouldUpgradeCallback: updates.shouldUpgrade },
    },
    (info) =>
      console.info("sendo-reader is listening", {
        address: info.address,
        port: info.port,
        sendo: sendoOrigin,
      }),
  );

  server.prependListener("request", updates.trackRequest);
  server.on("upgrade", updates.handle);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info("shutting down", { signal });
    const timeout = setTimeout(() => {
      console.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // 新しい接続を受けるのをやめ、処理中のリクエストが終わるのを待つ
    server.close(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
    updates.stop();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main(process.env).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
