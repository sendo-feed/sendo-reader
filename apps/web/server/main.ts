/**
 * コンテナ版の reader のサーバーの入口（docs/decisions/container.md）。設定を読んで組み立てるだけにし、
 * 処理の中身は app.ts に置く。HTTP だけを受け、TLS は手前のリバースプロキシで終える。
 *
 * 設定（環境変数）
 * - SENDO_URL：中継の先の sendo のオリジン。既定は http://sendo:8787（compose の中の名前）
 * - PORT：受けるポート。既定は 8080
 * - HOST：受けるアドレス。既定は 0.0.0.0
 * - DIST_DIR：画面のビルドの置き場。既定は、このバンドル（dist-server/server.mjs）から見た ../dist
 * - X_EMBED_ORIGIN：X の投稿の隔離フレームのオリジン（https）。なければ、この機能は出ない
 *   （docs/decisions/embeds.md の 3）
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { contentSecurityPolicy } from "../security-headers";
import { createReaderServer } from "./app";
import { loadAssets, withXEmbedOrigin } from "./assets";
import { type Env, parsePort, parseSendoUrl, parseXEmbedOrigin } from "./config";
import { createUpgradeRelay } from "./websocket";
import { bundledXEmbedPage } from "./x-embed-page";

/** 止めるときに、処理中のリクエストを待つ上限 */
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;

function distDirectory(env: Env): string {
  return env.DIST_DIR?.trim() || fileURLToPath(new URL("../dist", import.meta.url));
}

async function main(env: Env): Promise<void> {
  const sendoOrigin = parseSendoUrl(env.SENDO_URL);
  const port = parsePort(env.PORT);
  const xEmbedOrigin = parseXEmbedOrigin(env.X_EMBED_ORIGIN);
  const loaded = await loadAssets(distDirectory(env));
  // 設定があるときは、index.html と sw.js を書き換えて、読者に新しい版として届ける
  const assets =
    xEmbedOrigin === null
      ? loaded
      : await withXEmbedOrigin(
          loaded,
          xEmbedOrigin,
          contentSecurityPolicy("production", { xEmbedOrigin }),
        );
  // 隔離フレームのページは、設定があるときだけ使う（なければ、このホスト名の振り分けもない）
  const xEmbedPage = xEmbedOrigin === null ? undefined : bundledXEmbedPage();
  const app = createReaderServer({ assets, sendoOrigin, xEmbedOrigin, xEmbedPage });

  const server = serve(
    { fetch: app.fetch, port, hostname: env.HOST?.trim() || "0.0.0.0" },
    (info) =>
      console.info("sendo-reader is listening", {
        address: info.address,
        port: info.port,
        sendo: sendoOrigin,
        xEmbed: xEmbedOrigin,
      }),
  );

  // sendo の通知（WebSocket）の Upgrade を中継する（websocket.ts）
  const relay = createUpgradeRelay(sendoOrigin, { xEmbedOrigin });
  server.on("upgrade", relay.handle);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info("shutting down", { signal });
    const timeout = setTimeout(() => {
      console.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // 中継している WebSocket は切る（ブラウザはつなぎ直す）。新しい接続を受けるのをやめ、
    // 処理中のリクエストが終わるのを待つ
    relay.closeAll();
    server.close(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main(process.env).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
