import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 読み込み直しても、戻る・進むでも、同じ画面の同じ位置に戻る（docs/decisions/ui.md の 1）。
 * どの画面かは URL に、どこを見ていたかは履歴の項目に持つ
 */

function seed(settings: Record<string, unknown> = {}, count = 40) {
  const server = new FakeSendo();
  // 最初の同期で届くように、開く前に預けておく
  for (const [name, value] of Object.entries(settings)) {
    server.putSetting("mobile", name, value);
    server.putSetting("desktop", name, value);
  }
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < count; i++) {
    server.deliver(feed.id, {
      title: `記事 ${i}`,
      summary: "本文。".repeat(200),
      publishedAt: Date.now() - (i + 1) * 60_000,
    });
  }
  return { server, feed };
}

/** 一覧の見出しのすぐ下に出ている記事の題 */
function topTitle(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector(".article-list");
    const bottom = list?.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    const x = (list?.getBoundingClientRect().left ?? 0) + 100;
    return document
      .elementFromPoint(x, bottom + 4)
      ?.closest(".item")
      ?.querySelector(".title")?.textContent;
  });
}

/**
 * 見出しから 200px 下の行の記事を開く（見出しのすぐ下の記事とは別の記事。開くと既読になり、
 * 未読だけの一覧からは、読み込み直すと消える）
 */
async function openBelow(page: Page): Promise<string> {
  const title = await page.evaluate(() => {
    const list = document.querySelector(".article-list");
    const bottom = list?.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    const x = (list?.getBoundingClientRect().left ?? 0) + 100;
    const row = document.elementFromPoint(x, bottom + 200)?.closest(".item");
    return row?.querySelector(".title")?.textContent ?? "";
  });
  expect(title).toMatch(/^記事 \d+$/);
  await page
    .locator(".article-list .item", { hasText: new RegExp(`^${title}\\b`) })
    .first()
    .click();
  await expect(page.locator(".article-view").getByRole("heading", { level: 1 })).toHaveText(title);
  return title;
}

/** 位置を書くのは、動かし終えて少ししてから */
const settle = (page: Page) => page.waitForTimeout(500);

test("狭い画面：読み込み直しても、別の画面から戻っても、一覧と記事の位置に戻る", async ({
  page,
  context,
}) => {
  const { server } = seed({ "reader.markReadOnScroll": false });
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);
  const scrollY = () => page.evaluate(() => window.scrollY);

  await page.evaluate(() => window.scrollTo({ top: 1500 }));
  await settle(page);
  const title = await topTitle(page);
  expect(title).toMatch(/^記事 \d+$/);
  expect(title).not.toBe("記事 0");

  // 読み込み直しても、同じ位置に戻る
  await page.reload();
  await expect(list.locator(".item")).toHaveCount(40);
  await expect.poll(() => topTitle(page)).toBe(title);

  // 別の画面に移ると先頭から出し、戻ると、前の画面の位置に戻る
  const tabs = page.getByRole("navigation", { name: "Main" });
  await tabs.getByRole("link", { name: "Saved" }).click();
  await expect(page).toHaveURL(/\/starred$/);
  await expect.poll(scrollY).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => topTitle(page)).toBe(title);

  // 記事を読み進めてから読み込み直すと、記事の同じ位置に戻る（戻したあとに上の部分の高さが
  // 変わっても、ブラウザーが見た目の位置を保つので、少しずれる）
  const opened = await openBelow(page);
  await page.evaluate(() => window.scrollTo({ top: 600 }));
  await settle(page);
  const articleTop = await scrollY();
  expect(articleTop).toBeGreaterThan(300);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(opened);
  await expect.poll(async () => Math.abs((await scrollY()) - articleTop)).toBeLessThan(16);

  // 記事から戻ると、開く前の一覧の位置に戻る（読み込み直す前に覚えていた位置）
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).not.toHaveURL(/article=/);
  await expect.poll(() => topTitle(page)).toBe(title);
});

test("広い画面：記事を開いたまま読み込み直しても、一覧と記事の位置に戻る", async ({
  page,
  context,
}) => {
  const { server } = seed({ "reader.markReadOnScroll": false });
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const view = page.locator(".article-view");
  await expect(list.locator(".item")).toHaveCount(40);

  await list.evaluate((el) => el.scrollBy({ top: 1200 }));
  await settle(page);
  const title = await topTitle(page);
  expect(title).toMatch(/^記事 \d+$/);
  expect(title).not.toBe("記事 0");
  const opened = await openBelow(page);
  await view.evaluate((el) => el.scrollTo({ top: 500 }));
  await settle(page);
  const articleTop = await view.evaluate((el) => el.scrollTop);
  expect(articleTop).toBeGreaterThan(100);

  await page.reload();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(opened);
  await expect.poll(() => topTitle(page)).toBe(title);
  await expect
    .poll(async () => Math.abs((await view.evaluate((el) => el.scrollTop)) - articleTop))
    .toBeLessThan(16);
});

test("続きのページの記事にも戻る。戻すときに飛び越えた記事は、既読にしない", async ({
  page,
  context,
}) => {
  // 既読も出す一覧で、通り過ぎた記事を既読にする。見ていた記事は、2 ページ目（51 件目から）に
  // 置く（読み込み直すと、1 ページ目を出してから続きを読み、そのあとで位置に戻す）
  const { server } = seed({ "reader.unreadOnly": false }, 80);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(50);
  await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list.locator(".item")).toHaveCount(80);
  await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight - el.clientHeight - 400 }));
  await settle(page);
  const title = await topTitle(page);
  expect(Number(title?.replace("記事 ", ""))).toBeGreaterThanOrEqual(50);
  await expect.poll(() => list.locator(".row:not(.unread)").count()).toBeGreaterThan(0);
  const read = await list.locator(".row:not(.unread)").count();

  await page.reload();
  await expect.poll(() => topTitle(page)).toBe(title);
  await page.waitForTimeout(800);
  await expect(list.locator(".row:not(.unread)")).toHaveCount(read);
  await expect(page).toHaveTitle(`(${80 - read}) All - Sendo`);
});

test("未読だけの一覧で、見ていた記事まで読んで消えていたら、先頭の未読から出す", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);

  // 動かして通り過ぎた記事は既読になる（見出しのすぐ下の記事も、上の端が隠れたので既読）
  await list.evaluate((el) => el.scrollBy({ top: 600 }));
  await settle(page);
  const title = await topTitle(page);
  await expect.poll(() => list.locator(".row:not(.unread)").count()).toBeGreaterThan(0);
  const read = await list.locator(".row:not(.unread)").count();

  await page.reload();
  await expect(list.locator(".item")).toHaveCount(40 - read);
  await page.waitForTimeout(800);
  expect(await list.locator(".title").first().textContent()).not.toBe(title);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
});

test("記事を動かしてすぐ戻っても、進むで開き直すと、その位置に戻る", async ({ page, context }) => {
  const { server } = seed({ "reader.markReadOnScroll": false });
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(40);
  const heading = page.getByRole("heading", { level: 1 });
  const scrollY = () => page.evaluate(() => window.scrollY);
  const opened = await openBelow(page);

  // 画面の Back のボタンで閉じる（位置を書く前に、履歴を戻る）
  await page.evaluate(() => window.scrollTo({ top: 600 }));
  const first = await scrollY();
  expect(first).toBeGreaterThan(300);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).not.toHaveURL(/article=/);
  await page.goForward();
  await expect(heading).toHaveText(opened);
  await expect.poll(async () => Math.abs((await scrollY()) - first)).toBeLessThan(16);

  // ブラウザーの戻るで閉じる
  await page.evaluate(() => window.scrollTo({ top: 300 }));
  const second = await scrollY();
  await page.goBack();
  await expect(page).not.toHaveURL(/article=/);
  await page.goForward();
  await expect(heading).toHaveText(opened);
  await expect.poll(async () => Math.abs((await scrollY()) - second)).toBeLessThan(16);
});
