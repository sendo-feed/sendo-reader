// ビルドした画面の大きさ（gzip 後）を数え、予算を超えたら失敗する
// （docs/decisions/performance.md）。apps/web をビルドしてから実行する。
//
// - 画面のスレッド：dist/index.html が読む <script type="module"> と <link rel="modulepreload">
// - DB のワーカー：assets/db.worker-*.js と、そこから静的に import する JS、そこから読む wasm
//   （sqlite-wasm が一緒に出力する、使わないワーカーの JS は数えない）

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MAIN_THREAD_BUDGET = 100 * 1024;
const WORKER_BUDGET = 550 * 1024;

const dist = join(import.meta.dirname, "..", "apps", "web", "dist");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gzipped = (path) => gzipSync(readFileSync(join(dist, path)), { level: 9 }).length;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 画面のスレッドで最初に読む JS */
function mainThreadFiles() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const paths = new Set();
  for (const tag of html.match(/<script\b[^>]*>|<link\b[^>]*>/g) ?? []) {
    const isModuleScript = tag.startsWith("<script") && /\btype="module"/.test(tag);
    const isModulePreload = tag.startsWith("<link") && /\brel="modulepreload"/.test(tag);
    if (!isModuleScript && !isModulePreload) continue;
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (url === undefined) continue;
    if (!url.startsWith("/")) fail(`同じオリジンの絶対パスでない JS がある：${url}`);
    paths.add(url.slice(1));
  }
  if (paths.size === 0)
    fail("dist/index.html から JS が見つからない。apps/web をビルドしたか確かめる");
  return [...paths];
}

/** DB のワーカーが読む JS と wasm */
function workerFiles() {
  const assets = readdirSync(join(dist, "assets"));
  const entry = assets.find((name) => /^db\.worker-[\w-]+\.js$/.test(name));
  if (entry === undefined) fail("assets/db.worker-*.js が見つからない");
  const files = new Set();
  const visit = (name) => {
    if (files.has(`assets/${name}`)) return;
    files.add(`assets/${name}`);
    const code = readFileSync(join(dist, "assets", name), "utf8");
    for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) {
      visit(match[1]);
    }
    for (const match of code.matchAll(/([\w.-]+\.wasm)/g)) {
      if (assets.includes(match[1])) files.add(`assets/${match[1]}`);
    }
  };
  visit(entry);
  if (![...files].some((path) => path.endsWith(".wasm"))) {
    fail("DB のワーカーが読む wasm が見つからない");
  }
  return [...files];
}

let failed = false;
for (const [label, files, budget] of [
  ["画面のスレッドの JS", mainThreadFiles(), MAIN_THREAD_BUDGET],
  ["DB のワーカーの JS と wasm", workerFiles(), WORKER_BUDGET],
]) {
  let total = 0;
  for (const path of files.sort()) {
    const size = gzipped(path);
    total += size;
    console.log(`${kb(size).padStart(10)}  ${path}`);
  }
  console.log(`${label}（gzip 後）：${kb(total)} ／ 予算 ${kb(budget)}\n`);
  if (total > budget) {
    console.error(`${label}が予算を超えた（docs/decisions/performance.md）`);
    failed = true;
  }
}
if (failed) process.exit(1);
