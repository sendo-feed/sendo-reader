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
import { notificationPath, type PushEventLike, readPush } from "../src/lib/notification";
import {
  type NotificationClickEnvironment,
  openFromNotification,
} from "../src/lib/notification-click";
import { forgetTag, rememberTag } from "../src/lib/notification-store";

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

/** 宣言型の push の navigate（TypeScript の型にまだない） */
type NotificationOptionsWithNavigate = NotificationOptions & { navigate: string };

/**
 * push を受けたら、届いた中身で通知を出し直す（docs/decisions/notifications.md の 6）。reader を開いて
 * いても出す（userVisibleOnly の登録は、push のたびに通知を出す約束）。中身は通知に出すだけにし、
 * どこにも残さない（10）。push の中では setAppBadge を呼ばない（iOS で、宣言型の push の中で呼ぶと
 * 返らず、通知ごと出ない。閉じている間のバッジは、sendo の app_badge でブラウザーが書く。11）
 */
self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

async function showPush(event: PushEvent): Promise<void> {
  const { declarative, payload } = readPush(event as unknown as PushEventLike);
  if (payload === null) {
    // 宣言型では出し直さない（宣言した通知が出る）。読まないブラウザーでは、「Sendo」とだけ出し、
    // 押したら reader の先頭を開く
    if (!declarative) {
      const fallback: NotificationOptionsWithNavigate = {
        navigate: new URL("/", self.location.origin).href,
      };
      await self.registration.showNotification("Sendo", fallback);
    }
    return;
  }
  // navigate は届いた値を使わず、tag の記事の ID から、自分のオリジンの URL を組み立てる。宣言型の
  // push で出し直すときに navigate がないと、例外になる
  const options: NotificationOptionsWithNavigate = {
    tag: payload.tag,
    data: payload.data,
    navigate: new URL(notificationPath(payload.tag), self.location.origin).href,
  };
  if (payload.body !== undefined) options.body = payload.body;
  await self.registration.showNotification(payload.title, options);
  // 出し終えてから覚える（出せなかった通知を、押されたものと取り違えない。8）
  await rememberTag(payload.tag, Date.now()).catch(() => {});
}

/** 押された通知の記事を開く画面を選び、開かせる（src/lib/notification-click.ts） */
const clickEnvironment: NotificationClickEnvironment = {
  // 最後に前に出ていたものから並ぶ。まだ受け持っていない窓も選ぶ
  windows: () => self.clients.matchAll({ type: "window", includeUncontrolled: true }),
  openWindow: (url) => self.clients.openWindow(url),
  forgetTag,
};

/**
 * 押したことが届いたら、その記事を開く（docs/decisions/notifications.md の 7）。通知を閉じ、覚えた tag を
 * 外してから、開いている reader の画面に開かせる。選べる画面がない、断られた、0.5 秒のうちに受けた
 * ことが返らないときは、新しい窓で開く
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFromNotification(clickEnvironment, event.notification.tag));
});

/** 利用者が消した通知は、覚えから外す（押された通知と取り違えない。8） */
self.addEventListener("notificationclose", (event) => {
  event.waitUntil(forgetTag(event.notification.tag).catch(() => {}));
});
