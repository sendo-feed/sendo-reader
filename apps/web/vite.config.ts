import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  IMAGE_CACHE_MAX_AGE_SECONDS,
  IMAGE_CACHE_NAME,
  IMAGE_CACHE_URL_PATTERN,
} from "../../packages/core/src/web/image-cache.ts";
import { contentSecurityPolicy, securityHeaders, xEmbedPageHeaders } from "./security-headers.ts";
import { isSendoPath, SENDO_NAVIGATION_DENYLIST } from "./sendo-paths.ts";
import {
  applyXEmbedOrigin,
  isXEmbedHost,
  toXEmbedOrigin,
  withXEmbedMeta,
} from "./x-embed-origin.ts";

/**
 * X の投稿の隔離フレームのオリジン（docs/decisions/embeds.md の 3）。本番のコンテナと同じ環境変数
 * X_EMBED_ORIGIN で受け、同じ関数（x-embed-origin.ts）で確かめる。手元では、開発用の
 * http://localhost と http://127.0.0.1 も受け付ける（reader と違うほうのホスト名にする）
 */
function devXEmbedOrigin(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const origin = toXEmbedOrigin(text, { allowDevelopment: true });
  if (origin === null) throw new Error(`X_EMBED_ORIGIN の形が合わない: ${text}`);
  return origin;
}

const X_EMBED_ORIGIN = devXEmbedOrigin(process.env.X_EMBED_ORIGIN);

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** 隔離フレームのページ（x-embed/）。dev と preview は、開くたびにファイルから読む */
const X_EMBED_PAGE = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/embed.js", { file: "embed.js", type: "text/javascript; charset=utf-8" }],
]);
const X_EMBED_DIR = fileURLToPath(new URL("./x-embed/", import.meta.url));

/**
 * 隔離フレームのホスト名への要求は、隔離フレームのページ（/ と /embed.js）だけを返し、sendo にも画面にも
 * 回さない（本番の server/app.ts と同じ）
 */
function xEmbedHostMiddleware(headers: Record<string, string>): Middleware {
  return (req, res, next) => {
    if (X_EMBED_ORIGIN === null || !isXEmbedHost(req.headers.host, X_EMBED_ORIGIN)) return next();
    const isGet = req.method === "GET" || req.method === "HEAD";
    const page = X_EMBED_PAGE.get(new URL(req.url ?? "/", "http://x-embed.invalid").pathname);
    if (isGet && page !== undefined) {
      for (const [name, value] of Object.entries(xEmbedPageHeaders())) res.setHeader(name, value);
      res.setHeader("content-type", page.type);
      res.setHeader("cache-control", "no-cache");
      res.end(req.method === "HEAD" ? undefined : readFileSync(path.join(X_EMBED_DIR, page.file)));
      return;
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (!isGet) {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end(req.method === "HEAD" ? undefined : "Not Found");
  };
}

/**
 * 隔離フレームのホスト名への要求は、sendo に中継しない（WebSocket の Upgrade も）。Vite の中継の
 * bypass で false を返すと、Vite が 404 を返して、中継しない
 */
function bypassXEmbedHost(req: IncomingMessage): false | undefined {
  return X_EMBED_ORIGIN !== null && isXEmbedHost(req.headers.host, X_EMBED_ORIGIN)
    ? false
    : undefined;
}

/** preview が返すビルドのファイルのうち、ほかのパスの代わりに index.html を返すものか（SPA） */
function isIndexPath(pathname: string, outDir: string): boolean {
  if (pathname === "/" || pathname === "/index.html") return true;
  if (isSendoPath(pathname)) return false;
  let file: string;
  try {
    file = path.resolve(outDir, `.${decodeURIComponent(pathname)}`);
  } catch {
    return true;
  }
  if (!file.startsWith(outDir + path.sep)) return true;
  return !(existsSync(file) && statSync(file).isFile());
}

/**
 * 手元の dev サーバーと preview にヘッダーを付ける。本番は、reader のコンテナのサーバーが同じものを付ける
 * （server/static.ts）。X の投稿の隔離フレームのオリジンが設定してあれば、本番のコンテナと同じく、
 * CSP の frame-src に入れ、index.html に <meta> を足し（preview は sw.js の版の印も書き換え）、
 * 隔離フレームのホスト名への要求を断る
 */
function securityHeadersPlugin(): Plugin[] {
  const developmentHeaders = securityHeaders("development", { xEmbedOrigin: X_EMBED_ORIGIN });
  const productionHeaders = securityHeaders("production", { xEmbedOrigin: X_EMBED_ORIGIN });
  return [
    {
      name: "sendo-reader:security-headers",
      configureServer(server) {
        server.middlewares.use(xEmbedHostMiddleware(developmentHeaders));
        server.middlewares.use((_req, res, next) => {
          for (const [name, value] of Object.entries(developmentHeaders)) {
            res.setHeader(name, value);
          }
          next();
        });
      },
      async configurePreviewServer(server) {
        server.middlewares.use(xEmbedHostMiddleware(productionHeaders));
        server.middlewares.use((_req, res, next) => {
          for (const [name, value] of Object.entries(productionHeaders)) res.setHeader(name, value);
          next();
        });
        if (X_EMBED_ORIGIN === null) return;
        // 本番のコンテナと同じく、起動するときに index.html と sw.js を書き換える
        const outDir = path.resolve(server.config.root, server.config.build.outDir);
        const files = await applyXEmbedOrigin(
          {
            indexHtml: readFileSync(path.join(outDir, "index.html"), "utf8"),
            sw: readFileSync(path.join(outDir, "sw.js"), "utf8"),
          },
          X_EMBED_ORIGIN,
          contentSecurityPolicy("production", { xEmbedOrigin: X_EMBED_ORIGIN }),
        );
        server.middlewares.use((req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const pathname = new URL(req.url ?? "/", "http://preview.invalid").pathname;
          const body =
            pathname === "/sw.js"
              ? files.sw
              : isIndexPath(pathname, outDir)
                ? files.indexHtml
                : null;
          if (body === null) return next();
          res.setHeader(
            "content-type",
            pathname === "/sw.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
          );
          res.setHeader("cache-control", "no-cache");
          res.end(req.method === "HEAD" ? undefined : body);
        });
      },
    },
    {
      // 手元の dev サーバーだけ。ビルドした index.html には埋めない（イメージは 1 つのまま。
      // 本番はコンテナが起動するときに埋める）
      name: "sendo-reader:x-embed-origin-meta",
      apply: "serve",
      transformIndexHtml(html) {
        return X_EMBED_ORIGIN === null ? html : withXEmbedMeta(html, X_EMBED_ORIGIN);
      },
    },
  ];
}

/**
 * 手元で動かす sendo（sendo の pnpm dev）。e2e は、偽の通知のサーバーに向ける（SENDO_DEV_URL。
 * playwright.config.ts）
 */
const SENDO_DEV_URL = process.env.SENDO_DEV_URL || "http://localhost:8787";

/** Workbox が、1 回の取得の間、プラグインの呼び出しに渡して回す入れ物 */
type GenerationState = { state?: { generation?: string } };

/**
 * 画像のキャッシュを消したあと（ログアウト、ユーザーの切り替え）に、消す前に取りにいき始めた
 * 画像が遅れて届いても、キャッシュに入れない（docs/decisions/images.md の 4）。
 *
 * 取りにいき始めたときの世代を覚え、入れる前と入れたあとに、世代が変わっていないかを見る。
 * 世代の印は packages/core/src/web/image-cache.ts の clearImageCache が進める。
 *
 * この関数は、ビルドのときに文字にして Service Worker に埋め込まれる。外の変数や関数を
 * 参照できないので、印の置き場所（IMAGE_CACHE_GENERATION と同じ名前）を直接書いている。
 */
const imageCacheGenerationPlugin = {
  requestWillFetch: async ({ request, state }: { request: Request } & GenerationState) => {
    const marker = await caches.match("/sendo-images-generation", {
      cacheName: "sendo-images-generation",
    });
    if (state !== undefined) state.generation = marker === undefined ? "" : await marker.text();
    return request;
  },
  cacheWillUpdate: async ({ response, state }: { response: Response } & GenerationState) => {
    const marker = await caches.match("/sendo-images-generation", {
      cacheName: "sendo-images-generation",
    });
    const generation = marker === undefined ? "" : await marker.text();
    return state !== undefined && generation === state.generation ? response : null;
  },
  cacheDidUpdate: async ({
    cacheName,
    request,
    state,
  }: { cacheName: string; request: Request } & GenerationState) => {
    const marker = await caches.match("/sendo-images-generation", {
      cacheName: "sendo-images-generation",
    });
    const generation = marker === undefined ? "" : await marker.text();
    if (state !== undefined && generation === state.generation) return;
    const cache = await caches.open(cacheName);
    await cache.delete(request);
  },
};

/**
 * 動いている版を、設定の画面で見分けるための印（コミットと、ビルドした時刻）。
 * PWA は、新しい版に替わるのが遅れることがあるので、いまどの版かを画面で確かめられるようにする。
 * コンテナのイメージは、CI がビルドの引数で APP_COMMIT_SHA に渡す（イメージを作るときは .git がない）。
 * 手元では git から読む
 */
function appVersion(): { commit: string; builtAt: string } {
  let commit = process.env.APP_COMMIT_SHA || "";
  if (commit === "") {
    try {
      commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      commit = "unknown";
    }
  }
  // 日時は ISO 8601 のまま埋め込み、表示するときに利用者のロケールとタイムゾーンに合わせる。
  return { commit: commit.slice(0, 7), builtAt: new Date().toISOString() };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    svelte(),
    ...securityHeadersPlugin(),
    // アプリの外枠と SQLite の wasm をキャッシュして、ネットワークがなくても起動する
    // （docs/decisions/ui.md）。登録は src/main.ts で、Trusted Types のポリシーを通して行う
    VitePWA({
      injectRegister: false,
      registerType: "autoUpdate",
      manifest: {
        name: "Sendo",
        short_name: "Sendo",
        description: "Sendo の公式リーダー",
        lang: "ja",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#0f766e",
        background_color: "#ffffff",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,webmanifest}"],
        // sqlite-wasm が一緒に出力するが、使わないワーカーの JS はキャッシュしない
        globIgnores: ["**/sqlite3-worker1-*.js", "**/sqlite3-opfs-async-proxy-*.js"],
        // SPA なので、ないパスには index.html を返す。sendo のパス（/api、同じオリジンに並ぶ /mcp や
        // OAuth など）は横取りせず、sendo に届ける（docs/decisions/container.md の 3）
        navigateFallback: "/index.html",
        navigateFallbackDenylist: SENDO_NAVIGATION_DENYLIST,
        // CSP で Trusted Types を強制しているので、Service Worker の中で importScripts に
        // 文字列を渡せない。Workbox の実行部分を sw.js に入れる
        inlineWorkboxRuntime: true,
        cleanupOutdatedCaches: true,
        // 新しい版は、取り込んだらすぐ使い始める（docs/decisions/ui.md の 5）。待機させると、開いている
        // タブをすべて閉じるまで使われず、src/lib/app-update.ts の読み込み直しも起きない。
        // 読み込み直す時期は、app-update.ts が決める（画面が裏にある間か、次に前に出たとき）
        skipWaiting: true,
        clientsClaim: true,
        // sendo が中継した画像（サムネイル、フィードのアイコン）を、キャッシュを先に見て出す
        // （docs/decisions/images.md の 3）。オフラインでも、一度出した画像を出す。入れるのは
        // 成功（200）だけで、401 ／ 403 ／ 502 は入れない。画面のファイルとは別の名前にして、
        // ログアウトでまとめて消せるようにする。容量の上限（100MB）は、画面の側で見る
        runtimeCaching: [
          {
            urlPattern: IMAGE_CACHE_URL_PATTERN,
            handler: "CacheFirst",
            method: "GET",
            options: {
              cacheName: IMAGE_CACHE_NAME,
              cacheableResponse: { statuses: [200] },
              expiration: { maxAgeSeconds: IMAGE_CACHE_MAX_AGE_SECONDS, purgeOnQuotaError: true },
              plugins: [imageCacheGenerationPlugin],
            },
          },
        ],
      },
    }),
  ],
  // DB のワーカー（src/db.worker.ts）は ES モジュールで作る。sqlite-wasm は wasm を自分の場所から
  // 読むので、Vite の事前バンドルに入れない
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    // 手元では、本番の reader のコンテナのサーバーと同じパス（sendo-paths.ts）を、sendo の pnpm dev
    // （ポート 8787）に中継する（docs/decisions/ui.md の 4）。^ で始まるキーは、Vite が正規表現として
    // パスとクエリに当てる
    proxy: Object.fromEntries(
      // ws: true で、sendo の通知（WebSocket の Upgrade）も中継する
      SENDO_NAVIGATION_DENYLIST.map((pattern) => [
        pattern.source,
        // preview も、この中継を引き継ぐ。隔離フレームのホスト名への要求は中継しない
        { target: SENDO_DEV_URL, ws: true, bypass: bypassXEmbedHost },
      ]),
    ),
  },
});
