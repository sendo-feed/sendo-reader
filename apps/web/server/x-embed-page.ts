/**
 * X の投稿の隔離フレームのページ（apps/web/x-embed）を、サーバーのバンドル（dist-server/server.mjs）に
 * 文字として取り込む（esbuild の import attributes の type: "text"）。イメージには、画面のビルドと、
 * 1 つのファイルにまとめたサーバーだけを入れる（docs/decisions/container.md の 7）
 */
// @ts-expect-error 型のない .js を、esbuild が文字として取り込む（TypeScript はこの読み方を知らない）
import script from "../x-embed/embed.js" with { type: "text" };
import html from "../x-embed/index.html" with { type: "text" };
import { xEmbedPageAssets } from "./assets";
import type { Assets } from "./static";

export function bundledXEmbedPage(): Assets {
  return xEmbedPageAssets(html, String(script));
}
