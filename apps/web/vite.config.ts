import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  IMAGE_CACHE_MAX_AGE_SECONDS,
  IMAGE_CACHE_NAME,
  IMAGE_CACHE_URL_PATTERN,
} from "../../packages/core/src/web/image-cache.ts";
import {
  embedOriginFromHeaders,
  renderHeadersFile,
  securityHeaders,
  xEmbedOrigin,
} from "./security-headers.ts";
import { SENDO_NAVIGATION_DENYLIST } from "./sendo-paths.ts";

const embedOrigin = xEmbedOrigin(process.env.SENDO_X_EMBED_ORIGIN);

/** 手元のサーバーにはヘッダーを付け、本番のビルドには _headers を書き出す */
function securityHeadersPlugin(): Plugin {
  return {
    name: "sendo-reader:security-headers",
    configureServer(server) {
      const headers = securityHeaders("development", embedOrigin);
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
    async configurePreviewServer(server) {
      const path = resolve(server.config.root, server.config.build.outDir, "_headers");
      const builtHeaders = await readFile(path, "utf8");
      const headers = securityHeaders("production", embedOriginFromHeaders(builtHeaders));
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: renderHeadersFile(embedOrigin),
      });
    },
  };
}

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
 * Workers Builds はコミットを環境変数で渡す。コンテナ版のイメージは、CI がビルドの引数で APP_COMMIT_SHA に
 * 渡す（イメージを作るときは .git がない）。手元では git から読む
 */
function appVersion(): { commit: string; builtAt: string } {
  let commit = process.env.WORKERS_CI_COMMIT_SHA || process.env.APP_COMMIT_SHA || "";
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
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __X_EMBED_ORIGIN__: JSON.stringify(embedOrigin),
  },
  plugins: [
    svelte(),
    securityHeadersPlugin(),
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
        // SPA なので、ないパスには index.html を返す。sendo のパス（/api、コンテナ版で同じオリジンに
        // 並ぶ /mcp や OAuth など）は横取りせず、sendo に届ける（docs/decisions/container.md の 3）
        navigateFallback: "/index.html",
        navigateFallbackDenylist: SENDO_NAVIGATION_DENYLIST,
        // CSP で Trusted Types を強制しているので、Service Worker の中で importScripts に
        // 文字列を渡せない。Workbox の実行部分を sw.js に入れる
        inlineWorkboxRuntime: true,
        cleanupOutdatedCaches: true,
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
    // 手元では sendo（pnpm dev、ポート 8787）に中継する。本番は reader Worker が
    // Service binding で中継する（worker/index.ts）
    proxy: {
      "/api": { target: "http://localhost:8787" },
    },
  },
});
