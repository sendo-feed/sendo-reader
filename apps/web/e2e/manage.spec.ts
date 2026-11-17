import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  const folder = server.createFolder("Tech");
  server.createFolder("Empty folder");
  const blog = server.subscribe({
    url: "https://blog.example/feed.xml",
    title: "Blog",
    folderId: folder.id,
  });
  const news = server.subscribe({ url: "https://news.example/rss", title: "News" });
  return { server, folder, blog, news };
}

test("フォルダと中身を一緒に表示し、検索中は畳んだフィードも見つかる", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const manage = page.getByRole("main");
  const tech = manage.getByRole("region", { name: "Tech", exact: true });
  const empty = manage.getByRole("region", { name: "Empty folder", exact: true });
  const loose = manage.getByRole("region", { name: "No folder", exact: true });
  await expect(tech.locator(".feed-row")).toContainText("Blog");
  await expect(loose.locator(".feed-row")).toContainText("News");
  await expect(empty).toContainText("このフォルダにはフィードがありません。");
  await expect(manage.getByLabel("Website or feed URL")).toHaveCount(0);

  await context.setOffline(true);
  const requests = server.requests.length;
  const toggle = tech.getByRole("button", { name: /^Tech/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(tech.locator(".feed-row")).not.toBeVisible();
  const search = manage.getByRole("searchbox", { name: "Find a feed", exact: true });
  await search.fill("BLOG.EXAMPLE");
  await expect(tech.locator(".feed-row")).toBeVisible();
  await expect(loose).toHaveCount(0);
  await search.fill("does-not-exist");
  await expect(manage).toContainText("一致するフィードがありません。");
  await search.fill("");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(empty).toBeVisible();
  expect(server.requests.length).toBe(requests);
});

test("移動・フォルダの作成と名前変更・削除・購読解除はオフラインでも反映され、あとで同期する", async ({
  page,
  context,
}) => {
  const { server, folder, blog, news } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const manage = page.getByRole("main");
  await expect(manage.locator(".feed-row")).toHaveCount(2);
  await context.setOffline(true);
  await manage
    .getByRole("region", { name: "Tech", exact: true })
    .getByRole("button", { name: /^Tech/ })
    .click();
  await manage
    .getByRole("combobox", { name: "Move News to folder", exact: true })
    .selectOption(folder.id);
  const tech = manage.getByRole("region", { name: "Tech", exact: true });
  await expect(tech.locator(".feed-row")).toHaveCount(2);
  await expect(tech.getByText("News", { exact: true })).toBeVisible();
  expect(server.feeds.get(news.id)?.folderId).toBeNull();

  await manage.getByRole("button", { name: "New folder", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name", { exact: true }).fill("Design");
  await dialog.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(manage.getByRole("region", { name: "Design", exact: true })).toBeVisible();
  await manage.getByRole("button", { name: "Folder options: Design", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name", { exact: true }).fill("Reading");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(manage.getByRole("region", { name: "Reading", exact: true })).toBeVisible();

  await manage.getByRole("button", { name: "Folder options: Tech", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete folder…", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("購読は続きます");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tech.locator(".feed-row")).toHaveCount(2);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete folder…", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete folder", exact: true })
    .click();
  const loose = manage.getByRole("region", { name: "No folder", exact: true });
  await expect(loose.locator(".feed-row")).toHaveCount(2);
  await expect(tech).toHaveCount(0);

  await manage.getByRole("button", { name: "Feed options: Blog", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unsubscribe…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(manage.locator(".feed-row")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "Unsubscribe…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unsubscribe", exact: true }).click();
  await expect(loose.locator(".feed-row")).toHaveCount(1);
  await page.reload();
  await expect(manage.locator(".feed-row")).toHaveCount(1);
  await expect(manage.getByRole("region", { name: "Reading", exact: true })).toBeVisible();

  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect.poll(() => server.feeds.get(blog.id)?.deletedAt).not.toBeNull();
  await expect.poll(() => server.folders.get(folder.id)?.deletedAt).not.toBeNull();
  await expect
    .poll(() => [...server.folders.values()].some((f) => f.name === "Reading"))
    .toBe(true);
  await expect.poll(() => server.feeds.get(news.id)?.folderId).toBeNull();
});

test("追加の候補は URL を変えたら消し、購読したフィードを管理画面に表示する。OPML は必要なときに開く", async ({
  page,
  context,
}) => {
  const { server } = seed();
  server.discoverable.set("https://new.example/", [
    { url: "https://new.example/feed", title: "New feed" },
  ]);
  server.fetchable.set("https://new.example/feed", "New feed");
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const manage = page.getByRole("main");
  await expect(manage.locator(".feed-row")).toHaveCount(2);
  await manage
    .getByRole("region", { name: "Tech", exact: true })
    .getByRole("button", { name: /^Tech/ })
    .click();
  await manage.getByRole("searchbox").fill("no match");
  await manage.getByRole("button", { name: "Add feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add feed", exact: true });
  await dialog.getByLabel("Website or feed URL").fill("https://new.example/");
  await dialog.getByRole("button", { name: "Find", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Subscribe", exact: true })).toBeVisible();
  await dialog.getByLabel("Website or feed URL").fill("https://other.example/");
  await expect(dialog.getByRole("button", { name: "Subscribe", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Website or feed URL").fill("https://new.example/");
  await dialog.getByRole("button", { name: "Find", exact: true }).click();
  await dialog.getByLabel("Folder", { exact: true }).selectOption({ label: "Tech" });
  await dialog.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/manage$/);
  await expect(
    manage
      .getByRole("region", { name: "Tech", exact: true })
      .getByText("New feed", { exact: true }),
  ).toBeVisible();

  await manage.getByRole("button", { name: "Import OPML", exact: true }).click();
  const importing = page.getByRole("dialog", { name: "Import OPML", exact: true });
  await importing.getByLabel("OPML file").setInputFiles({
    name: "feeds.opml",
    mimeType: "text/x-opml",
    buffer: Buffer.from('<opml><body><outline xmlUrl="https://opml.example/feed"/></body></opml>'),
  });
  await expect(importing).toContainText("1 件の登録を受け付けました。");
  expect(server.opmlImports).toHaveLength(1);
});

test("狭い画面で長い名前・URL も収まり、メニューをキーボードで閉じられる", async ({
  page,
  context,
}) => {
  const { server, folder } = seed();
  const title = "LongFeedTitle".repeat(20);
  server.createFolder("LongFolder".repeat(10));
  server.subscribe({
    url: "https://untrusted.example/feed",
    title: "<img src=x onerror=alert(1)>",
  });
  server.subscribe({
    url: `https://long.example/${"long".repeat(80)}`,
    title,
    folderId: folder.id,
  });
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/manage");
  await signIn(page);
  const manage = page.getByRole("main");
  await expect(manage.locator(".feed-row")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(manage.locator("img")).toHaveCount(0);
  await manage.getByRole("button", { name: `Feed options: ${title}`, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
