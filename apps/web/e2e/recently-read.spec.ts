import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed(count = 3) {
  const server = new FakeSendo();
  const day = 86_400_000;
  server.now = Date.now() - day;
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const articles = [];
  for (let i = 0; i < count; i++) {
    const article = server.deliver(feed.id, {
      title: `読んだ記事 ${i}`,
      // 公開日時の順とは逆に読む。古い記事でも、最近読めば先頭に来る
      publishedAt: server.now - i * day,
    });
    server.setArticleState(article.id, { read: true });
    articles.push(article);
    server.advance(1000);
  }
  server.deliver(feed.id, { title: "未読の記事", publishedAt: server.now });
  server.putSetting("desktop", "reader.markReadOnScroll", false);
  server.putSetting("mobile", "reader.markReadOnScroll", false);
  return { server, articles };
}

async function openRecent(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .locator("nav.sidebar")
    .getByRole("link", { name: "Recently Read", exact: true })
    .click();
  await expect(page).toHaveURL(/\/recently-read$/);
}

for (const mobile of [false, true]) {
  test.describe(mobile ? "スマホ" : "PC", () => {
    test.use({
      viewport: { width: mobile ? 390 : 1280, height: 844 },
      hasTouch: mobile,
      isMobile: mobile,
    });

    test("All と Saved の間から既読順で開き、未読フィルタはオフのまま保つ", async ({
      page,
      context,
    }) => {
      const { server } = seed();
      // 全体や、この一覧に以前同期した設定があっても Recently Read の条件を変えない
      for (const device of ["mobile", "desktop"]) {
        server.putSetting(device, "reader.oldestFirst", true);
        server.putSetting(device, "reader.list:/recently-read", {
          unreadOnly: true,
          oldestFirst: true,
        });
      }
      await routeFakeSendo(context, server);
      await page.goto("/");
      await signIn(page);
      const list = page.locator(".article-list");
      await expect(list.locator(".title")).toHaveText(["未読の記事"]);
      const names = page.locator("nav.sidebar .views a .name");
      await expect(names).toHaveText(["All", "Recently Read", "Saved", "Search"]);
      await context.setOffline(true);
      await openRecent(page);
      await expect(list.locator(".title")).toHaveText([
        "読んだ記事 2",
        "読んだ記事 1",
        "読んだ記事 0",
      ]);
      await expect(list.locator("h3")).toHaveText(["Yesterday"]);
      await expect(list.getByRole("button", { name: "Unread only", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(list.getByRole("button", { name: "Unread only", exact: true })).toBeDisabled();
      await expect(list.getByRole("button", { name: "Oldest first", exact: true })).toHaveCount(0);

      await list.locator(".item").first().click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("読んだ記事 2");
      await page
        .locator(".article-view")
        .getByRole("button", { name: "Mark as unread", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(list.locator(".title")).toHaveText(["読んだ記事 1", "読んだ記事 0"]);

      // All の未読だけの設定は変わらない。読んだ記事は Recently Read の先頭へ加わる
      if (mobile) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.locator("nav.sidebar").getByRole("link", { name: /^All/ }).click();
      await expect(list.getByRole("button", { name: "Unread only", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await list.locator(".item", { hasText: "未読の記事" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("未読の記事");
      await page.keyboard.press("Escape");
      await openRecent(page);
      await expect(list.locator(".title")).toHaveText([
        "未読の記事",
        "読んだ記事 1",
        "読んだ記事 0",
      ]);
    });
  });
}

test("続きのページを既読順で読み、再読み込みや戻るでも同じ位置へ戻る", async ({
  page,
  context,
}) => {
  const { server } = seed(80);
  await routeFakeSendo(context, server);
  await page.goto("/recently-read");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(50);
  await list.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  await expect(list.locator(".item")).toHaveCount(80);
  await expect(list.locator(".title")).toHaveText(
    Array.from({ length: 80 }, (_, i) => `読んだ記事 ${79 - i}`),
  );
  await list.evaluate((node) => node.scrollTo({ top: 6500 }));
  const topTitle = () =>
    page.evaluate(() => {
      const list = document.querySelector(".article-list");
      const header = list?.querySelector("header")?.getBoundingClientRect();
      if (!list || !header) return null;
      return document
        .elementFromPoint(list.getBoundingClientRect().left + 100, header.bottom + 4)
        ?.closest(".item")
        ?.querySelector(".title")?.textContent;
    });
  await expect.poll(topTitle).toMatch(/^読んだ記事 \d+$/);
  const title = await topTitle();
  await expect
    .poll(() => page.evaluate(() => history.state?.list?.anchor?.readAt))
    .toEqual(expect.any(Number));
  await page.reload();
  await expect.poll(topTitle).toBe(title);
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect.poll(topTitle).toBe(title);
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/starred$/);
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page).toHaveURL(/\/recently-read$/);
});

test("既読がなければ案内を出し、読んだ記事を同期で受けると一覧に出す", async ({
  page,
  context,
}) => {
  const { server } = seed(0);
  await routeFakeSendo(context, server);
  await page.goto("/recently-read");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.getByText("まだ読んだ記事はありません。", { exact: true })).toBeVisible();
  const article = [...server.inbox.values()][0];
  if (!article) throw new Error("記事がない");
  server.setArticleState(article.id, { read: true });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(list.locator(".title")).toHaveText(["未読の記事"]);
});

test("出しているページがすべて未読に戻っても、その先の既読の記事を読み出す", async ({
  page,
  context,
}) => {
  const { server, articles } = seed(80);
  await routeFakeSendo(context, server);
  await page.goto("/recently-read");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(50);
  for (const article of articles.slice(30)) server.setArticleState(article.id, { read: false });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(list.locator(".title")).toHaveText(
    Array.from({ length: 30 }, (_, i) => `読んだ記事 ${29 - i}`),
  );
});
