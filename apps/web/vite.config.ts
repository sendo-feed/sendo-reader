import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { renderHeadersFile, securityHeaders } from "./security-headers.ts";

/** 手元のサーバーにはヘッダーを付け、本番のビルドには _headers を書き出す */
function securityHeadersPlugin(): Plugin {
  return {
    name: "sendo-reader:security-headers",
    configureServer(server) {
      const headers = securityHeaders("development");
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
    configurePreviewServer(server) {
      const headers = securityHeaders("production");
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: renderHeadersFile() });
    },
  };
}

export default defineConfig({
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
        icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,wasm,webmanifest}"],
        // sqlite-wasm が一緒に出力するが、使わないワーカーの JS はキャッシュしない
        globIgnores: ["**/sqlite3-worker1-*.js", "**/sqlite3-opfs-async-proxy-*.js"],
        // SPA なので、ないパスには index.html を返す。/api は sendo に任せる
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // CSP で Trusted Types を強制しているので、Service Worker の中で importScripts に
        // 文字列を渡せない。Workbox の実行部分を sw.js に入れる
        inlineWorkboxRuntime: true,
        cleanupOutdatedCaches: true,
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
