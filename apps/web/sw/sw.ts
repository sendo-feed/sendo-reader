/**
 * reader の Service Worker（docs/decisions/ui.md の 5、docs/decisions/notifications.md の 5）。
 *
 * vite-plugin-pwa の injectManifest でビルドし、Workbox の部品も含めて 1 つのファイル（sw.js）にする。
 * 本番の CSP の下で動き、Trusted Types を強制しているので、importScripts は使わない。
 */
import {
  IMAGE_CACHE_GENERATION,
  IMAGE_CACHE_MAX_AGE_SECONDS,
  IMAGE_CACHE_NAME,
  IMAGE_CACHE_URL_PATTERN,
} from "@sendo-reader/core/web/image-cache";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim, type WorkboxPlugin } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { SENDO_NAVIGATION_DENYLIST } from "../sendo-paths";

declare const self: ServiceWorkerGlobalScope;

// 新しい版は、取り込んだらすぐ使い始め、開いている画面を受け持つ（docs/decisions/ui.md の 5）。
// 待機させると、開いているタブをすべて閉じるまで使われず、src/lib/app-update.ts の読み込み直しも
// 起きない。読み込み直す時期は、app-update.ts が決める（画面が裏にある間か、次に前に出たとき）
self.skipWaiting();
clientsClaim();

// アプリの外枠と SQLite の wasm をキャッシュして、ネットワークがなくても起動する。一覧は、ビルドの
// ときに injectManifest が差し込む（vite.config.ts の globPatterns。/version.json は入れない）
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA なので、ないパスには index.html を返す。sendo のパス（/api、同じオリジンに並ぶ /mcp や OAuth
// など）は横取りせず、sendo に届ける（docs/decisions/container.md の 3）
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: SENDO_NAVIGATION_DENYLIST,
  }),
);

/** 画像のキャッシュの世代の印の中身（なければ空） */
async function imageCacheGeneration(): Promise<string> {
  const marker = await caches.match(IMAGE_CACHE_GENERATION.url, {
    cacheName: IMAGE_CACHE_GENERATION.cacheName,
  });
  return marker === undefined ? "" : await marker.text();
}

/**
 * 画像のキャッシュを消したあと（ログアウト、ユーザーの切り替え）に、消す前に取りにいき始めた
 * 画像が遅れて届いても、キャッシュに入れない（docs/decisions/images.md の 4）。取りにいき始めたときの
 * 世代を覚え、入れる前と入れたあとに、世代が変わっていないかを見る。世代の印は
 * packages/core/src/web/image-cache.ts の clearImageCache が進める
 */
const imageCacheGenerationPlugin: WorkboxPlugin = {
  requestWillFetch: async ({ request, state }) => {
    if (state !== undefined) state.generation = await imageCacheGeneration();
    return request;
  },
  cacheWillUpdate: async ({ response, state }) =>
    state !== undefined && (await imageCacheGeneration()) === state.generation ? response : null,
  cacheDidUpdate: async ({ cacheName, request, state }) => {
    if (state !== undefined && (await imageCacheGeneration()) === state.generation) return;
    const cache = await caches.open(cacheName);
    await cache.delete(request);
  },
};

// sendo が中継した画像（サムネイル、フィードのアイコン）を、キャッシュを先に見て出す
// （docs/decisions/images.md の 3）。オフラインでも、一度出した画像を出す。入れるのは成功（200）だけで、
// 401 ／ 403 ／ 502 は入れない。画面のファイルとは別の名前にして、ログアウトでまとめて消せるように
// する。容量の上限（100MB）は、画面の側で見る
registerRoute(
  IMAGE_CACHE_URL_PATTERN,
  new CacheFirst({
    cacheName: IMAGE_CACHE_NAME,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxAgeSeconds: IMAGE_CACHE_MAX_AGE_SECONDS, purgeOnQuotaError: true }),
      imageCacheGenerationPlugin,
    ],
  }),
  "GET",
);
