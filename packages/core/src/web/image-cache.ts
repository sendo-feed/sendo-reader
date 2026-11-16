/**
 * 画像のキャッシュ（docs/decisions/images.md の 3・4）。sendo が中継した画像（GET /api/v1/images）の
 * 成功した応答を、Service Worker が、画面のファイルとは別の名前のキャッシュに入れる
 * （apps/web/vite.config.ts）。ここには、その名前と上限、消す・減らす処理を置く。
 *
 * - 日数（30 日）で捨てるのは、Service Worker の中の Workbox が行う
 * - 容量（100MB）で捨てるのは、ここで行う（Workbox は、件数と日数でしか捨てられない）
 * - ログアウトとユーザーの切り替えでは、手元の DB と一緒に、まとめて消す
 */

/** キャッシュの名前。Service Worker の設定と、消す側とで同じものを使う */
export const IMAGE_CACHE_NAME = "sendo-images";

/** Service Worker がキャッシュする相手（画像の中継の入口）。URL の中身は読まない */
export const IMAGE_CACHE_URL_PATTERN = /\/api\/v1\/images\?/;

/** キャッシュに置く日数の上限（秒）。sendo の Cache-Control と同じ 30 日 */
export const IMAGE_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** キャッシュの容量の上限（バイト） */
export const IMAGE_CACHE_MAX_BYTES = 100 * 1024 * 1024;

/** 画像のキャッシュをまとめて消す。キャッシュの仕組みがない環境（Node のテストなど）では何もしない */
export async function clearImageCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(IMAGE_CACHE_NAME);
}

/**
 * 画像のキャッシュが上限を超えていたら、キャッシュに入れたのが古いものから捨てる。捨てた数を返す。
 * 容量は、応答の Content-Length（sendo が付ける）を足して数える。なければ、中身の大きさを見る。
 * 並びは、ブラウザのキャッシュが返す順（入れた順）。最後に使った時刻は、ブラウザが持たない。
 */
export async function trimImageCache(maxBytes: number = IMAGE_CACHE_MAX_BYTES): Promise<number> {
  if (typeof caches === "undefined" || !(await caches.has(IMAGE_CACHE_NAME))) return 0;
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const requests = await cache.keys();
  const sizes: number[] = [];
  let total = 0;
  for (const request of requests) {
    const response = await cache.match(request);
    const size = response === undefined ? 0 : await sizeOf(response);
    sizes.push(size);
    total += size;
  }
  let removed = 0;
  for (let i = 0; i < requests.length && total > maxBytes; i++) {
    const request = requests[i];
    if (request === undefined) break;
    await cache.delete(request);
    total -= sizes[i] ?? 0;
    removed += 1;
  }
  return removed;
}

async function sizeOf(response: Response): Promise<number> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) return length;
  return (await response.blob()).size;
}
