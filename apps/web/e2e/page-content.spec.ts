import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  server.pageContentEnabled = true;
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Blog" });
  const article = server.deliver(feed.id, { title: "要約の記事", summary: "短い要約" });
  server.pageContents.set(article.id, "<h2>元ページの見出し</h2><p>要約にない全文の続き</p>");
  return { server, article, feed };
}

test("要約だけの記事から全文を取得し、切り替え・オフラインの再表示ができる", async ({
  page,
  context,
}) => {
  const { server, article } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  expect(server.pageContentRequests).toEqual([]);

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/content") ? blocked : Promise.resolve());
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.getByRole("status")).toHaveText("全文を取得しています…");
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await expect(view.getByRole("button", { name: "Full text", exact: true })).toBeDisabled();
  release();
  server.onRequest = null;
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await expect(view.getByRole("button", { name: "Full text", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await view.getByRole("button", { name: "Feed content" }).click();
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  expect(server.pageContentRequests).toEqual([article.id]);

  server.onRequest = () => Promise.reject(new TypeError("offline"));
  await context.setOffline(true);
  await page.reload();
  await expect(view.locator(".body")).toContainText("要約にない全文の続き");
  await view.getByRole("button", { name: "Feed content" }).click();
  await expect(view.locator(".summary")).toHaveText("短い要約");
  await view.getByRole("button", { name: "Full text", exact: true }).click();
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
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.getByRole("status")).toHaveText(
    "全文を取得できませんでした。元の記事で続きを読めます。",
  );
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");

  server.onRequest = (path) =>
    path.endsWith("/content") ? Promise.reject(new TypeError("offline")) : Promise.resolve();
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("接続を確かめて");
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");

  server.onRequest = null;
  server.pageContents.set(article.id, "<p>取得できた全文</p>");
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.locator(".body")).toHaveText("取得できた全文");
  await view.getByRole("button", { name: "Feed content" }).click();
  await expect(view.locator(".body")).toHaveText("残して読むフィード本文");
});

test("取得中に記事を替えても、前の記事の全文を出さない", async ({ page, context }) => {
  const { server, article, feed } = seed();
  const next = server.deliver(feed.id, { title: "別の記事", summary: "別の記事の要約" });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await page.locator(".article-list .item", { hasText: article.title ?? "" }).click();
  const view = page.locator(".article-view");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.onRequest = (path) => (path.endsWith("/content") ? blocked : Promise.resolve());
  await view.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(view.getByRole("status")).toHaveText("全文を取得しています…");
  await page.locator(".article-list .item", { hasText: next.title ?? "" }).click();
  await expect(view.locator(".summary")).toHaveText("別の記事の要約");
  release();
  server.onRequest = null;
  // 先に始めた取得が終わっても、今の記事を保つ
  await expect.poll(() => server.pageContentRequests).toEqual([article.id]);
  await expect(view.locator(".summary")).toHaveText("別の記事の要約");
  await expect(view.locator(".body")).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: "Full text", exact: true })).toHaveCount(0);
    expect(server.pageContentRequests).toEqual([]);
  });
}
