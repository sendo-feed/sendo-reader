/**
 * コンテナ版の reader のサーバー（docs/decisions/container.md）。sendo のパスは sendo に中継し、
 * ほかは画面の静的なファイルを返す。
 *
 * X の投稿の隔離フレームのオリジンが設定してあるときは、そのホスト名への要求を、sendo にも画面にも
 * 回さない（docs/decisions/embeds.md の 3）。隔離フレームのページは、まだ置いていないので、
 * どのパスも 404 にする。
 */
import { Hono } from "hono";
import { securityHeaders } from "../security-headers";
import { isSendoPath } from "../sendo-paths";
import { isXEmbedHost } from "../x-embed-origin";
import { proxyToSendo } from "./proxy";
import { type Assets, serveAsset } from "./static";

export type ReaderServerOptions = {
  assets: Assets;
  /** 中継の先の sendo のオリジン（例：http://sendo:8787） */
  sendoOrigin: string;
  /** X の投稿の隔離フレームのオリジン（config.ts で確かめたもの）。未設定なら null */
  xEmbedOrigin?: string | null;
};

/** 隔離フレームのホスト名への要求。sendo にも画面にも回さない */
function serveXEmbedHost(request: Request): Response {
  const headers = new Headers(securityHeaders("production"));
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  return new Response(request.method === "HEAD" ? null : "Not Found", { status: 404, headers });
}

export function createReaderServer(options: ReaderServerOptions) {
  const xEmbedOrigin = options.xEmbedOrigin ?? null;
  const headers = securityHeaders("production", { xEmbedOrigin });
  const app = new Hono();
  app.all("*", (c) => {
    const request = c.req.raw;
    if (xEmbedOrigin !== null && isXEmbedHost(request.headers.get("host"), xEmbedOrigin)) {
      return serveXEmbedHost(request);
    }
    return isSendoPath(new URL(request.url).pathname)
      ? proxyToSendo(request, options.sendoOrigin)
      : serveAsset(request, options.assets, headers);
  });
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "Internal Server Error" } }, 500);
  });
  return app;
}
