/**
 * コンテナ版の reader のサーバー（docs/decisions/container.md）。sendo のパスは sendo に中継し、
 * ほかは画面の静的なファイルを返す。
 *
 * X の投稿の隔離フレームのオリジンが設定してあるときは、そのホスト名への要求を、sendo にも画面にも
 * 回さない（docs/decisions/embeds.md の 3）。返すのは、隔離フレームのページ（/ と /embed.js）だけで、
 * ほかのパスは 404 にする。
 */
import { Hono } from "hono";
import { securityHeaders, xEmbedPageHeaders } from "../security-headers";
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
  /** 隔離フレームのページ（assets.ts の loadXEmbedPage）。/ と /embed.js */
  xEmbedPage?: Assets | undefined;
};

/** 隔離フレームのホスト名への要求。隔離フレームのページだけを返し、sendo にも画面にも回さない */
function serveXEmbedHost(request: Request, page: Assets): Response {
  const pathname = new URL(request.url).pathname;
  const isGet = request.method === "GET" || request.method === "HEAD";
  if (isGet && page.has(pathname)) return serveAsset(request, page, xEmbedPageHeaders(), false);
  const headers = new Headers(securityHeaders("production"));
  if (!isGet) {
    headers.set("allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  return new Response(request.method === "HEAD" ? null : "Not Found", { status: 404, headers });
}

export function createReaderServer(options: ReaderServerOptions) {
  const xEmbedOrigin = options.xEmbedOrigin ?? null;
  const headers = securityHeaders("production", { xEmbedOrigin });
  const page: Assets = options.xEmbedPage ?? new Map();
  const app = new Hono();
  app.all("*", (c) => {
    const request = c.req.raw;
    if (xEmbedOrigin !== null && isXEmbedHost(request.headers.get("host"), xEmbedOrigin)) {
      return serveXEmbedHost(request, page);
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
