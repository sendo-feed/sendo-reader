/**
 * コンテナ版の reader のサーバー（docs/decisions/container.md）。sendo のパスは sendo に中継し、
 * ほかは画面の静的なファイルを返す。
 */
import { Hono } from "hono";
import { SYNC_UPDATES_PROTOCOL_HEADER } from "../../../packages/core/src/web/sync-updates-protocol";
import { isSendoPath } from "../sendo-paths";
import { proxyToSendo } from "./proxy";
import { type Assets, serveAsset } from "./static";

export type ReaderServerOptions = {
  assets: Assets;
  /** 中継の先の sendo のオリジン（例：http://sendo:8787） */
  sendoOrigin: string;
  syncSessionProtocol?(cookie: string | null): string | undefined;
};

export function createReaderServer(options: ReaderServerOptions) {
  const app = new Hono();
  app.all("*", async (c) => {
    const request = c.req.raw;
    const path = new URL(request.url).pathname;
    if (!isSendoPath(path)) return serveAsset(request, options.assets);
    const response = await proxyToSendo(request, options.sendoOrigin);
    if (request.method === "GET" && path === "/api/v1/me" && options.syncSessionProtocol) {
      response.headers.delete(SYNC_UPDATES_PROTOCOL_HEADER);
      const protocol =
        response.ok && !request.headers.has("authorization")
          ? options.syncSessionProtocol(request.headers.get("cookie"))
          : undefined;
      if (protocol !== undefined) {
        response.headers.set(SYNC_UPDATES_PROTOCOL_HEADER, protocol);
        response.headers.set("Cache-Control", "private, no-store");
      }
    }
    return response;
  });
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "Internal Server Error" } }, 500);
  });
  return app;
}
