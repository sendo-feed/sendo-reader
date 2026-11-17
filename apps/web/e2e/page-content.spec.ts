import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  server.pageContentEnabled = true;
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const article = server.deliver(feed.id, { title: "要約の記事", summary: "短い要約" });
  server.pageContents.set(article.id, "<h2>元ページの見出し</h2><p>要約にない全文の続き</p>");
  return { server, article, feed };
}

function actions(page: Page) {
  return page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Article actions", exact: true }),
  });
}

async function chooseContent(page: Page, name: string) {
  await page.locator(".article-view").getByRole("button", { name: "More actions" }).click();
  await actions(page).getByRole("button", { name, exact: true }).click();
  await expect(actions(page)).not.toBeVisible();
}

test("記事を開くと全文を自動取得し、切り替え・オフラインの再表示ができる", async ({
  page,
  context,
}) => {
  const { server, article } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/content") ? blocked : Promise.resolve());
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  await expect(view.getByRole("status")).toHaveText("全文を取得しています…");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await expect(view.locator(".content").getByRole("button")).toHaveCount(0);
  release();
  server.onRequest = null;
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await expect(view.locator(".content").getByRole("button")).toHaveCount(0);
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await chooseContent(page, "Show full text");
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  expect(server.pageContentRequests).toEqual([article.id]);

  server.onRequest = () => Promise.reject(new TypeError("offline"));
  await context.setOffline(true);
  await page.reload();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await chooseContent(page, "Show full text");
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  expect(server.pageContentRequests).toEqual([article.id]);
});

test("全文がない・通信できないときもフィード本文を残し、再試行できる", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  const article = server.deliver(feed.id, {
    title: "フィード本文の記事",
    content: "<p>残して読むフィード本文</p>",
  });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");
  await expect(view.getByRole("status")).toHaveText(
    "全文を取得できませんでした。元の記事で続きを読めます。",
  );
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");

  server.onRequest = (path) =>
    path.endsWith("/content") ? Promise.reject(new TypeError("offline")) : Promise.resolve();
  await chooseContent(page, "Retry full text");
  await expect(view.getByRole("status")).toContainText("接続を確かめて");
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");

  server.onRequest = null;
  server.pageContents.set(article.id, "<p>取得できた全文</p>");
  await chooseContent(page, "Retry full text");
  await expect(view.locator(".body")).toHaveText("取得できた全文");
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");
});

test("取得中に記事を替えても、前の記事の全文を出さない", async ({ page, context }) => {
  const { server, article, feed } = seed();
  const next = server.deliver(feed.id, { title: "別の記事", summary: "別の記事の要約" });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const view = page.locator(".article-view");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) =>
    path.includes(`${article.id}/content`) ? blocked : Promise.resolve();
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  await expect(view.getByRole("status")).toHaveText("全文を取得しています…");
  await page.locator(".article-list .item", { hasText: next.title ?? "" }).click();
  await expect(view.locator(".summary")).toHaveText("別の記事の要約");
  release();
  server.onRequest = null;
  // 先に始めた取得が終わっても、今の記事を保つ
  await expect.poll(() => server.pageContentRequests).toContain(article.id);
  await expect(view.locator(".summary")).toHaveText("別の記事の要約");
  await expect(view.locator(".body")).toHaveCount(0);
});

test("自動取得中にフィードへ切り替えたら、取得後も選んだ本文を保つ", async ({ page, context }) => {
  const { server, article } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/content") ? blocked : Promise.resolve());
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  await expect(view.getByRole("status")).toHaveText("全文を取得しています…");
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  release();
  server.onRequest = null;
  await expect.poll(() => server.pageContentRequests).toEqual([article.id]);
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await expect(view.locator(".body")).toHaveCount(0);
  await chooseContent(page, "Show full text");
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await view.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  expect(server.pageContentRequests).toEqual([article.id]);
});

test("機能一覧が遅くても要約を先に出し、スマホでも全文と原文への導線を使える", async ({
  page,
  context,
}) => {
  const { server, article } = seed();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/features") ? blocked : Promise.resolve());
  await page.setViewportSize({ width: 390, height: 844 });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await expect(view.getByRole("heading", { level: 1 }).getByRole("link")).toBeInViewport();
  expect(server.pageContentRequests).toEqual([]);
  release();
  server.onRequest = null;
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await expect(view.locator(".content").getByRole("button")).toHaveCount(0);
  await expect(view.getByRole("button", { name: "More actions" })).toBeInViewport();
  await chooseContent(page, "Show feed content");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await chooseContent(page, "Show full text");
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  expect(server.pageContentRequests).toEqual([article.id]);
});

for (const featuresStatus of [200, 404]) {
  test(`全文を使えない版では取得ボタンを出さない（features=${featuresStatus}）`, async ({
    page,
    context,
  }) => {
    const { server, article } = seed();
    server.pageContentEnabled = false;
    server.featuresStatus = featuresStatus;
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
    await expect(page.locator(".article-view .summary")).toHaveText("短い要約");
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    expect(server.pageContentRequests).toEqual([]);
  });
}

test("補助メニューをキーボードで開閉しても記事を閉じず、フォーカスを戻す", async ({
  page,
  context,
}) => {
  const { server, article } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  const more = view.getByRole("button", { name: "More actions" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(actions(page)).toBeVisible();
  await expect(actions(page).getByRole("button", { name: "Show feed content" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions(page)).not.toBeVisible();
  await expect(more).toBeFocused();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");

  await chooseContent(page, "Show feed content");
  await expect(more).toBeFocused();
  await expect(view.locator(".summary")).toHaveText("短い要約");
});
