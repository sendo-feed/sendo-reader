import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 画面の状態（*.svelte.ts。$state などのルーンを使う）も読み込めるようにする
  plugins: [svelte()],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
