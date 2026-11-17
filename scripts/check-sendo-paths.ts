/** sendo の実際のルーターと、コンテナ・Service Worker の中継先が合うかを調べる。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSendoPath, SENDO_NAVIGATION_DENYLIST } from "../apps/web/sendo-paths";

interface Route {
  method: string;
  path: string;
}

/** 画面のルートの代表。動的な部分には具体的な値を入れ、広すぎる中継指定も検出する。 */
const READER_PATHS = [
  "/",
  "/starred",
  "/search",
  "/manage",
  "/settings",
  "/feeds/example",
  "/folders/example",
  "/oauth/authorize",
];

export function pathProblems(routes: readonly Route[]): string[] {
  const problems = new Set<string>();
  if (routes.length === 0)
    problems.add("sendo のルートが 0 件です。ルートの取り出し方を確認してください。");
  const denied = (url: string) => SENDO_NAVIGATION_DENYLIST.some((pattern) => pattern.test(url));
  for (const route of routes) {
    if (!isSendoPath(route.path)) {
      problems.add(`${route.method} ${route.path}: コンテナが sendo に中継しません。`);
    }
    if (!denied(route.path) || !denied(`${route.path}?check=1`)) {
      problems.add(`${route.method} ${route.path}: Service Worker が画面の HTML を返します。`);
    }
  }
  for (const pathname of READER_PATHS) {
    if (isSendoPath(pathname) || denied(pathname) || denied(`${pathname}?check=1`)) {
      problems.add(`${pathname}: reader の画面が sendo の中継先と重なっています。`);
    }
  }
  return [...problems];
}

/** ルーターの組み立てだけを許す。DB・外部通信などを呼んだら失敗させる。 */
function unavailable(name: string): unknown {
  return new Proxy(() => {}, {
    get: (_target, prop) => unavailable(`${name}.${String(prop)}`),
    apply: () => {
      throw new Error(`${name} はパスの検査中に使えません。`);
    },
  });
}

async function main() {
  const root = process.argv[2];
  if (root === undefined)
    throw new Error("使い方: tsx scripts/check-sendo-paths.ts <sendo のディレクトリ>");
  const { createApp } = await import(pathToFileURL(path.resolve(root, "src/app.ts")).href);
  const routes: Route[] = createApp(unavailable("platform")).routes;
  const problems = pathProblems(routes);
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\napps/web/sendo-paths.ts の EXACT_PATHS / PATH_PREFIXES を直してください。\n画面と重なる場合は sendo と reader のパスを調整してください。`,
    );
  }
  console.log(
    `sendo の ${routes.length} 件のルートは、コンテナと Service Worker の中継先に含まれています。`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
