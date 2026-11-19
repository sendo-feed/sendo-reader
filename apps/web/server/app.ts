/**
 * コンテナ版の reader のサーバー（docs/decisions/container.md）。sendo のパスは sendo に中継し、
 * ほかは画面の静的なファイルを返す。
 */
import { Hono } from "hono";
import { isSendoPath } from "../sendo-paths";
import { proxyToSendo } from "./proxy";
import { type Assets, serveAsset } from "./static";

export type ReaderServerOptions = {
  assets: Assets;
  embedOrigin?: string;
  /** 中継の先の sendo のオリジン（例：http://sendo:8787） */
  sendoOrigin: string;
};

export function createReaderServer(options: ReaderServerOptions) {
  const app = new Hono();
  app.all("*", (c) => {
    const request = c.req.raw;
    return isSendoPath(new URL(request.url).pathname)
      ? proxyToSendo(request, options.sendoOrigin)
      : serveAsset(request, options.assets, options.embedOrigin);
  });
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "Internal Server Error" } }, 500);
  });
  return app;
}
