// 画面のスレッドで最初に読む JS の大きさ（gzip 後）を数え、予算を超えたら失敗する
// （docs/decisions/performance.md）。apps/web をビルドしてから実行する。
//
// 数えるのは、dist/index.html が読む <script type="module"> と、
// <link rel="modulepreload">（入口から静的に import するもの）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MAIN_THREAD_BUDGET = 100 * 1024;

const dist = join(import.meta.dirname, "..", "apps", "web", "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");

const paths = new Set();
for (const tag of html.match(/<script\b[^>]*>|<link\b[^>]*>/g) ?? []) {
  const isModuleScript = tag.startsWith("<script") && /\btype="module"/.test(tag);
  const isModulePreload = tag.startsWith("<link") && /\brel="modulepreload"/.test(tag);
  if (!isModuleScript && !isModulePreload) continue;
  const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
  if (url === undefined) continue;
  if (!url.startsWith("/")) {
    console.error(`同じオリジンの絶対パスでない JS がある：${url}`);
    process.exit(1);
  }
  paths.add(url);
}

if (paths.size === 0) {
  console.error("dist/index.html から JS が見つからない。apps/web をビルドしたか確かめる");
  process.exit(1);
}

let total = 0;
for (const path of [...paths].sort()) {
  const size = gzipSync(readFileSync(join(dist, path)), { level: 9 }).length;
  total += size;
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB  ${path}`);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`画面のスレッドの JS（gzip 後）：${kb(total)} ／ 予算 ${kb(MAIN_THREAD_BUDGET)}`);
if (total > MAIN_THREAD_BUDGET) {
  console.error("予算を超えた（docs/decisions/performance.md）");
  process.exit(1);
}
