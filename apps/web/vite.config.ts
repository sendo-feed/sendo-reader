import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
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
  plugins: [svelte(), securityHeadersPlugin()],
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
