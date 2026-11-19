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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { embedOriginFromBuild, X_EMBED_ORIGIN_FILE } from "../security-headers";
import { createReaderServer } from "./app";
import { loadAssets } from "./assets";
import { type Env, parsePort, parseSendoUrl } from "./config";

/** 止めるときに、処理中のリクエストを待つ上限 */
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;

function distDirectory(env: Env): string {
  return env.DIST_DIR?.trim() || fileURLToPath(new URL("../dist", import.meta.url));
}

async function main(env: Env): Promise<void> {
  const sendoOrigin = parseSendoUrl(env.SENDO_URL);
  const port = parsePort(env.PORT);
  const directory = distDirectory(env);
  const [assets, builtOrigin] = await Promise.all([
    loadAssets(directory),
    readFile(join(directory, X_EMBED_ORIGIN_FILE), "utf8").catch((error) => {
      if (error.code === "ENOENT") return JSON.stringify("");
      throw error;
    }),
  ]);
  const embedOrigin = embedOriginFromBuild(builtOrigin);
  const app = createReaderServer({ assets, sendoOrigin, embedOrigin });

  const server = serve(
    { fetch: app.fetch, port, hostname: env.HOST?.trim() || "0.0.0.0" },
    (info) =>
      console.info("sendo-reader is listening", {
        address: info.address,
        port: info.port,
        sendo: sendoOrigin,
      }),
  );

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
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main(process.env).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
