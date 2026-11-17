import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn, USER } from "./fake-sendo";

test("Google でログインし、記事を読んで、スターを付ける", async ({ page, context }) => {
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
  // 許可していないメールなら、sendo は理由を付けて戻す。理由は分かる言葉で出し、URL から消す
  server.loginUser = null;
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("このメールアドレスでは使えません");
  await expect(page).not.toHaveURL(/login_error/);
  server.loginUser = USER;
  await signIn(page);

  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  await expect(list.getByText("最初の記事")).toBeVisible();
  await expect(page.locator("nav.sidebar")).toContainText("Tech");
  await expect(page.locator("nav.sidebar")).toContainText("Blog");

  await list.getByText("最初の記事").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("最初の記事");
  const titleLink = view.getByRole("heading", { level: 1 }).getByRole("link");
  await expect(titleLink).toBeVisible();
  await expect(titleLink).toHaveAttribute("href", "https://blog.example/1");
  await expect(titleLink).toHaveAttribute("target", "_blank");
  await expect(titleLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(view.locator(".read-on")).toHaveCount(0);
  await context.route("https://blog.example/1", (route) => route.fulfill({ body: "Original" }));
  const opened = context.waitForEvent("page");
  await titleLink.click();
  const original = await opened;
  await expect(original).toHaveURL("https://blog.example/1");
  await original.close();
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("button", { name: "Unsave" })).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect
    .poll(() => [...server.inbox.values()].filter((a) => a.starredAt !== null).length)
    .toBe(1);

  // 記事のデータは HTML として出さず、http ／ https 以外の URL はリンクにしない
  await list.locator(".item", { hasText: "<img" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(evil.title ?? "");
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open original" })).toHaveCount(0);
  await expect(view.getByRole("heading", { level: 1 }).getByRole("link")).toHaveCount(0);
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
  await page.getByRole("link", { name: "Manage feeds" }).click();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Folder name", { exact: true }).fill("Tech");
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await page.getByRole("button", { name: "Add feed", exact: true }).click();
  await page.getByLabel("Website or feed URL").fill("https://blog.example/");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByLabel("Folder", { exact: true }).selectOption({ label: "Tech" });
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();

  await expect(page.getByRole("dialog", { name: "Add feed", exact: true })).not.toBeVisible();
  await expect(page).toHaveURL(/\/manage$/);
  await expect(
    page.getByRole("region", { name: "Tech", exact: true }).locator(".feed-row"),
  ).toContainText("Blog");
  await expect.poll(() => [...server.folders.values()].map((f) => f.name)).toEqual(["Tech"]);
  const [created] = [...server.folders.values()];
  await expect.poll(() => [...server.feeds.values()].map((f) => f.folderId)).toEqual([created?.id]);
});

test("セッションが切れたらログインし直しを促し、ログインし直したら続きから送る。ログアウトで sendo のセッションも消す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, { title: "記事" });
  await routeFakeSendo(context, server);

  await page.goto("/");
  await signIn(page);
  await expect(page.locator("nav.sidebar")).toContainText(USER.email);
  await page.locator(".article-list").getByText("記事").click();

  // セッションが切れた（期限切れ、取り消し）。手元では読み書きでき、ログインし直しを促す
  server.sessions.clear();
  const view = page.locator(".article-view");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByText("Session expired")).toBeVisible();
  await expect(view.getByRole("button", { name: "Unsave" })).toBeVisible();

  // ログインし直すと、開いていた記事に戻り、まだ送っていなかったスターを送る。Service Worker が
  // ページを受け持っていても、ログインの入口（/api/v1/auth/...）へのページの移動は横取りしない
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(new RegExp(`article=${article.id}`));
  await expect.poll(() => server.inbox.get(article.id)?.starredAt ?? null).not.toBeNull();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  await expect.poll(() => server.sessions.size).toBe(0);
  // 手元のデータも消えている（開き直しても、ログインの画面のまま）
  await page.reload();
  await expect(page.getByRole("button", { name: "Google でログイン" })).toBeVisible();
});
