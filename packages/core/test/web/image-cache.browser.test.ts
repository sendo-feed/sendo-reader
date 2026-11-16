import { afterEach, describe, expect, test } from "vitest";
import { clearImageCache, IMAGE_CACHE_NAME, trimImageCache } from "../../src/web/image-cache";

/** 画像のキャッシュに、決まった大きさの応答を入れる（Service Worker が入れたものに見立てる） */
async function put(name: string, bytes: number, withLength = true): Promise<void> {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (withLength) headers["content-length"] = String(bytes);
  await cache.put(
    `/api/v1/images?url=${name}&sig=x`,
    new Response(new Uint8Array(bytes), { headers }),
  );
}

async function names(): Promise<string[]> {
  if (!(await caches.has(IMAGE_CACHE_NAME))) return [];
  const keys = await (await caches.open(IMAGE_CACHE_NAME)).keys();
  return keys.map((request) => new URL(request.url).searchParams.get("url") ?? "");
}

afterEach(async () => {
  await caches.delete(IMAGE_CACHE_NAME);
});

describe("画像のキャッシュ", () => {
  test("上限を超えていたら、入れたのが古いものから、上限に収まるまで捨てる", async () => {
    await put("a", 400);
    await put("b", 300);
    await put("c", 200);
    await put("d", 100);

    // 1,000 バイトで、ちょうど上限。捨てない
    expect(await trimImageCache(1000)).toBe(0);
    expect(await names()).toEqual(["a", "b", "c", "d"]);

    // 上限が 500 なら、古い a と b を捨てて 300 にする
    expect(await trimImageCache(500)).toBe(2);
    expect(await names()).toEqual(["c", "d"]);
  });

  test("Content-Length がない応答は、中身の大きさで数える", async () => {
    await put("a", 400, false);
    await put("b", 300, false);
    expect(await trimImageCache(350)).toBe(1);
    expect(await names()).toEqual(["b"]);
  });

  test("入れ直した画像は、新しく入れたものとして扱う", async () => {
    await put("a", 400);
    await put("b", 300);
    await put("a", 400);
    expect(await trimImageCache(500)).toBe(1);
    expect(await names()).toEqual(["a"]);
  });

  test("キャッシュがなければ、何もしない（キャッシュを作らない）", async () => {
    expect(await trimImageCache(0)).toBe(0);
    expect(await caches.has(IMAGE_CACHE_NAME)).toBe(false);
  });

  test("まとめて消せる", async () => {
    await put("a", 100);
    await clearImageCache();
    expect(await caches.has(IMAGE_CACHE_NAME)).toBe(false);
  });
});
