import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * サムネイルとフィードのアイコン（docs/decisions/images.md）。画像は sendo が中継し、同じオリジンの
 * URL から読む。本番と同じ CSP（vite preview）のまま出ること、Service Worker のキャッシュの
 * 入れ方と消し方を確かめる。
 */

const IMAGE_CACHE = "sendo-images";

function seed() {
  const server = new FakeSendo();
  const blog = server.subscribe({
    url: "https://blog.example/feed.xml",
    title: "Blog",
    iconUrl: server.imageUrl("https://blog.example/favicon.ico"),
  });
  const news = server.subscribe({ url: "https://news.example/feed.xml", title: "News" });
  const t = Date.now();
  server.deliver(blog.id, {
    title: "画像のある記事",
    summary: "要約",
    thumbnailUrl: server.imageUrl("https://blog.example/a.png"),
    publishedAt: t - 1000,
  });
  server.deliver(news.id, {
    title: "画像が取れない記事。タイトルが長くて、何行にも折り返す。".repeat(4),
    summary: "要約",
    thumbnailUrl: server.imageUrl("https://news.example/broken.png"),
    publishedAt: t - 2000,
  });
  server.deliver(news.id, { title: "画像のない記事", summary: "要約", publishedAt: t - 3000 });
  server.imageStatusFor.set("https://news.example/broken.png", 502);
  return { server, blog, news };
}

/** CSP の違反を集める（画像をほかのオリジンから読もうとした、など） */
async function collectCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const found: string[] = [];
    Object.assign(window, { cspViolations: found });
    document.addEventListener("securitypolicyviolation", (event) => {
      found.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

/** Service Worker がページを受け持つまで待つ（画像をキャッシュするのは、受け持ってから） */
async function controlledByServiceWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

/** 画像のキャッシュに入っている、もとの URL（中継の URL から読むのは、テストの中だけ） */
function cachedImages(page: Page): Promise<string[]> {
  return page.evaluate(async (name) => {
    if (!(await caches.has(name))) return [];
    const keys = await (await caches.open(name)).keys();
    return keys.map((request) => new URL(request.url).searchParams.get("url") ?? "").sort();
  }, IMAGE_CACHE);
}

/** 読み込めた画像の数（壊れた画像は数えない） */
function loadedImages(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluateAll(
      (images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length,
    );
}

test("サムネイルとフィードのアイコンを、CSP を変えずに出す。一度出した画像は、オフラインでも出る", async ({
  page,
  context,
}) => {
  const { server } = seed();
  const violations = await collectCspViolations(page);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav.sidebar");
  await expect(list.locator(".item")).toHaveCount(3);
  await controlledByServiceWorker(page);
  await expect(list.locator(".item")).toHaveCount(3);

  // サムネイルは、画像のある記事にだけ出る。取れなかった画像と、ない画像は、場所ごと出さない
  await expect(list.locator(".thumb:visible")).toHaveCount(1);
  await expect(
    list.locator(".row", { hasText: "画像のある記事" }).locator(".thumb img"),
  ).toBeVisible();
  await expect.poll(() => loadedImages(page, ".article-list .thumb img")).toBe(1);
  await expect(
    list.locator(".row", { hasText: "画像が取れない記事" }).locator(".thumb"),
  ).toBeHidden();
  await expect(list.locator(".row", { hasText: "画像のない記事" }).locator(".thumb")).toHaveCount(
    0,
  );
  // 画像のある行も、ない行も、取れなかった行も、高さは同じ
  expect(
    await list
      .locator(".row")
      .evaluateAll((rows) => [
        ...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height))),
      ]),
  ).toHaveLength(1);
  // 飾りなので、alt は空
  await expect(list.locator(".thumb img")).toHaveAttribute("alt", "");

  // フィードのアイコンは、左のメニューと、一覧の行のフィード名の前。ないフィードは頭文字の印
  await expect(nav.getByRole("link", { name: "Blog" }).locator(".avatar img")).toBeVisible();
  await expect(nav.getByRole("link", { name: "News" }).locator(".avatar")).toHaveText("N");
  await expect(nav.getByRole("link", { name: "News" }).locator(".avatar img")).toHaveCount(0);
  await expect(list.locator(".feed-icon:visible")).toHaveCount(1);

  // 成功した画像だけを、キャッシュに入れる（502 は入れない）
  await expect
    .poll(() => cachedImages(page))
    .toEqual(["https://blog.example/a.png", "https://blog.example/favicon.ico"]);
  expect(await violations()).toEqual([]);

  // オフラインで開き直しても、一度出した画像は出る
  await context.setOffline(true);
  server.imageRequests.length = 0;
  await page.reload();
  await expect(list.locator(".item")).toHaveCount(3);
  await expect.poll(() => loadedImages(page, ".article-list .thumb img")).toBe(1);
  await expect.poll(() => loadedImages(page, "nav.sidebar .avatar img")).toBe(1);
  // キャッシュにある画像は、取りにいかない（取りにいくのは、キャッシュに入れなかった画像だけ）
  expect(server.imageRequests.filter((url) => url.startsWith("https://blog.example/"))).toEqual([]);
  expect(await violations()).toEqual([]);
});

test("画像が 401 ／ 403 ／ 502 を返しても、画面は崩れず、キャッシュにも入れない", async ({
  page,
  context,
}) => {
  const { server } = seed();
  server.imageStatusFor.set("https://blog.example/a.png", 403);
  server.imageStatusFor.set("https://blog.example/favicon.ico", 401);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const nav = page.locator("nav.sidebar");
  await expect(list.locator(".item")).toHaveCount(3);
  await controlledByServiceWorker(page);
  await expect(list.locator(".title")).toHaveText([
    "画像のある記事",
    /^画像が取れない記事/,
    "画像のない記事",
  ]);

  // 画像の中継には届いている（取りにいった）が、どれも出さない。壊れた画像の印も出さない
  await expect.poll(() => server.imageRequests.length).toBeGreaterThanOrEqual(3);
  await expect(list.locator(".thumb:visible")).toHaveCount(0);
  await expect(page.locator("img:visible")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Blog" }).locator(".avatar")).toHaveText("B");
  expect(await cachedImages(page)).toEqual([]);

  // あとで取れるようになったら、開き直すと出る（失敗をキャッシュしていない）
  server.imageStatusFor.clear();
  await page.reload();
  await expect.poll(() => loadedImages(page, ".article-list .thumb img")).toBe(2);
  await expect.poll(() => loadedImages(page, "nav.sidebar .avatar img")).toBe(1);
});

test("ログアウトすると、画像のキャッシュも消える", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(3);
  await controlledByServiceWorker(page);
  await expect.poll(() => cachedImages(page)).toHaveLength(2);

  await page.locator("nav.sidebar").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(() => cachedImages(page)).toEqual([]);
  await expect.poll(() => page.evaluate((name) => caches.has(name), IMAGE_CACHE)).toBe(false);
});

test("画像を取りにいっている間にキャッシュを消したら、遅れて届いた画像は入れない", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  // 合図を出すまで、画像の応答を止めておけるようにする
  let holding = false;
  const waiting: (() => void)[] = [];
  const held = new Set<string>();
  await context.route("**/api/v1/images**", async (route) => {
    if (holding) {
      held.add(route.request().url());
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    await route.fallback();
  });
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(3);
  await controlledByServiceWorker(page);
  await expect.poll(() => cachedImages(page)).toHaveLength(2);

  /** ログアウトやユーザーの切り替えのときと同じに、世代を進めてから、キャッシュを消す */
  const clear = () =>
    page.evaluate(async (name) => {
      const marker = await caches.open("sendo-images-generation");
      await marker.put("/sendo-images-generation", new Response(crypto.randomUUID()));
      await caches.delete(name);
    }, IMAGE_CACHE);

  // キャッシュを空にしてから開き直す。画像を取りにいくが、応答は止まっている
  await clear();
  holding = true;
  await page.reload();
  await expect(page.locator(".article-list .item")).toHaveCount(3);
  await expect.poll(() => held.size).toBeGreaterThanOrEqual(1);

  // 取りにいっている間に、キャッシュを消す（ログアウトした）。そのあとで、応答が届く
  await clear();
  holding = false;
  for (const resume of waiting.splice(0)) resume();
  await expect.poll(() => loadedImages(page, ".article-list .thumb img")).toBe(1);
  await page.waitForTimeout(500);
  expect(await cachedImages(page)).toEqual([]);

  // そのあとに取りにいった画像は、これまでどおり入る
  await page.reload();
  await expect.poll(() => cachedImages(page)).toHaveLength(2);
});
