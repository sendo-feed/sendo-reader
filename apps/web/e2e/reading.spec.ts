import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test("トークンを貼ってログインし、記事を読んで、スターを付ける", async ({ page, context }) => {
  const server = new FakeSendo();
  const folder = server.createFolder("Tech");
  const feed = server.subscribe({
    url: "https://blog.example/feed.xml",
    title: "Blog",
    folderId: folder.id,
  });
  server.deliver(feed.id, { title: "最初の記事", url: "https://blog.example/1" });
  const evil = server.deliver(feed.id, {
    title: "<img src=x onerror=alert(1)>",
    url: "javascript:alert(1)",
  });
  await routeFakeSendo(context, server);

  await page.goto("/");
  await signIn(page, "sendo_wrong");
  await expect(page.getByRole("alert")).toContainText("このトークンは使えません");
  await signIn(page);

  const list = page.locator(".article-list");
  await expect(list.getByText("最初の記事")).toBeVisible();
  await expect(page.locator("nav")).toContainText("Tech");
  await expect(page.locator("nav")).toContainText("Blog");

  await list.getByText("最初の記事").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("最初の記事");
  await page.getByRole("button", { name: "☆ スターを付ける" }).click();
  await expect(page.getByRole("button", { name: "★ スターを外す" })).toBeVisible();
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect
    .poll(() => [...server.inbox.values()].filter((a) => a.starredAt !== null).length)
    .toBe(1);

  // 記事のデータは HTML として出さず、http ／ https 以外の URL はリンクにしない
  await list.locator(".item", { hasText: "<img" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(evil.title ?? "");
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "元の記事を開く" })).toHaveCount(0);
});

test("フィードを探して購読し、フォルダに入れる", async ({ page, context }) => {
  const server = new FakeSendo();
  server.discoverable.set("https://blog.example/", [
    { url: "https://blog.example/feed.xml", title: "記事" },
  ]);
  server.fetchable.set("https://blog.example/feed.xml", "Blog");
  await routeFakeSendo(context, server);

  await page.goto("/");
  await signIn(page);
  await page.getByRole("link", { name: "購読の管理" }).click();
  await page.getByLabel("新しいフォルダの名前").fill("Tech");
  await page.getByRole("button", { name: "作る" }).click();
  await page.getByLabel("サイトかフィードの URL").fill("https://blog.example/");
  await page.getByRole("button", { name: "探す" }).click();
  await page.getByLabel("フォルダ", { exact: true }).selectOption({ label: "Tech" });
  await page.getByRole("button", { name: "購読する" }).click();

  await expect(page).toHaveURL(/\/feeds\//);
  await expect.poll(() => [...server.folders.values()].map((f) => f.name)).toEqual(["Tech"]);
  const [created] = [...server.folders.values()];
  await expect.poll(() => [...server.feeds.values()].map((f) => f.folderId)).toEqual([created?.id]);
});
