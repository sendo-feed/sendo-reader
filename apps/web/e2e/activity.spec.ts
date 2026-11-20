import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("表示した記事の開封をオフラインでも記録し、同じ表示で既読を変えても増やさない", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://example.com/feed", title: "Example" });
  const article = server.deliver(feed.id, { title: "開封の記録を確認する記事" });
  server.deliver(feed.id, { title: "一覧にだけ表示する記事" });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const articleRow = page.locator(".article-list").getByText(article.title ?? "");
  await expect(articleRow).toBeVisible();
  expect(server.activityRequests).toHaveLength(0);

  await context.setOffline(true);
  await articleRow.click();
  await expect(page.getByRole("heading", { name: article.title ?? "" })).toBeVisible();
  // 開いたまま未読に戻す（m）
  await page.keyboard.press("m");
  await expect(
    page.locator(".article-list .row.unread", { hasText: article.title ?? "" }),
  ).toBeVisible();
  expect(server.activityRequests).toHaveLength(0);

  await context.setOffline(false);
  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.click();
  await expect(sync).toBeEnabled();
  expect([...server.articleOpens.values()]).toMatchObject([{ articleId: article.id }]);
});
