import { expect, type Locator, type Page, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "../../../packages/core/src/web/protocol";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";
import { leading, openOtherVersion } from "./other-version";

/**
 * 版の違うタブが開いているときの知らせ（docs/decisions/local-first.md の 5）。版の違うタブの代表の
 * ワーカーは、同じオリジンの別のページで真似る（代表のロックを取り、番号を変えて、または番号を
 * 付けずに名乗る。届いた頼みには答えない）。
 */

const OTHER_TAB = "古い版の画面が、ほかのタブで開いています";
const THIS_TAB = "新しい版の画面が、ほかのタブで開いています";

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed", title: "Blog" });
  server.deliver(feed.id, { title: "最初の記事" });
  server.deliver(feed.id, { title: "二つめの記事" });
  return server;
}

/**
 * 真似たページに、もう一度名乗らせ、同期の様子を送らせる。番号の合わない代表の同期の様子では、
 * 知らせが消えないことを確かめる（届く順の保証はないので、少し待ってから確かめる。ワーカーで
 * 止めることは、core のテストが届く順の保証のある形で確かめている）
 */
async function announceAgain(other: Page, tab: Page): Promise<void> {
  await other.evaluate(() => (window as unknown as { announce: () => void }).announce());
  await tab.waitForTimeout(300);
}

/** ログインし、記事の一覧が出るまで待つ（手元の DB にログインしたユーザーと記事が入る） */
async function signInFirst(page: Page): Promise<void> {
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item", { hasText: "最初の記事" })).toBeVisible();
}

for (const [name, version] of [
  ["古い番号", PROTOCOL_VERSION - 1],
  ["番号のない（この決まりより前の版の）", null],
] as const) {
  test(`${name}代表がいるときに開くと、ほかのタブを読み込み直すか閉じるよう知らせ、そのタブを閉じれば使える`, async ({
    page,
    context,
  }) => {
    await routeFakeSendo(context, seed());
    await signInFirst(page);
    await page.close();
    const other = await openOtherVersion(context, version);
    await leading(other);

    const tab = await context.newPage();
    await tab.goto("/");
    const alert = tab.getByRole("alert");
    await expect(alert).toContainText(OTHER_TAB);
    await expect(alert.getByRole("button", { name: "Reload" })).toHaveCount(0);
    await expect(tab.getByText("Loading…")).toBeVisible();
    await announceAgain(other, tab);
    await expect(alert).toContainText(OTHER_TAB);

    await other.close();
    await expect(alert).toHaveCount(0);
    const item = tab.locator(".article-list .item", { hasText: "最初の記事" });
    await expect(item).toBeVisible();
    await item.click();
    await tab.keyboard.press("s");
    await expect(
      tab.locator(".article-view").getByRole("button", { name: "Unsave" }),
    ).toBeVisible();
  });
}

test("新しい番号の代表がいるときに開くと、このタブを読み込み直すよう知らせ、Reload を押すまで読み込み直さない", async ({
  page,
  context,
}) => {
  await routeFakeSendo(context, seed());
  await signInFirst(page);
  await page.close();
  const other = await openOtherVersion(context, PROTOCOL_VERSION + 1);
  await leading(other);

  const tab = await context.newPage();
  await tab.goto("/");
  const alert = tab.getByRole("alert");
  await expect(alert).toContainText(THIS_TAB);
  await tab.evaluate(() => Object.assign(window, { notReloaded: true }));
  // 知らせても、その場では読み込み直さない
  await tab.waitForTimeout(500);
  expect(await tab.evaluate(() => "notReloaded" in window)).toBe(true);

  await alert.getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => tab.evaluate(() => "notReloaded" in window)).toBe(false);
  await expect(tab.getByRole("alert")).toContainText(THIS_TAB);
});

test("使っている途中で版の違う代表に替わったら、操作の失敗で知らせ、そのタブを閉じれば続きから使える", async ({
  page: first,
  context,
}) => {
  await routeFakeSendo(context, seed());
  // 代表のタブ（版が合う）、代表のロックを待つ版の違うタブ、そのあとに開いたタブの順にする
  await signInFirst(first);
  const other = await openOtherVersion(context, null);
  const tab = await context.newPage();
  await tab.goto("/");
  await tab.locator(".article-list .item", { hasText: "最初の記事" }).click();
  const view = tab.locator(".article-view");
  const firstRow = tab.locator(".article-list .row", { hasText: "最初の記事" });
  const secondRow = tab.locator(".article-list .row", { hasText: "二つめの記事" });
  /** 記事の画面と、開いている記事の一覧の行の、スターのボタンの名前（Save か Unsave） */
  const saveButtons = (row: Locator) => async () => [
    await view.getByRole("button", { name: /^(Save|Unsave)$/ }).getAttribute("aria-label"),
    await row.getByRole("button", { name: /^(Save|Unsave)$/ }).getAttribute("aria-label"),
  ];
  await expect(view.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(tab.getByRole("alert")).toHaveCount(0);

  await first.close();
  await leading(other);
  await tab.keyboard.press("s");
  // 操作の失敗の表示（「保存できませんでした」）とは別に、どの画面でも出る知らせを出す
  const alert = tab.getByRole("alert").filter({ hasText: OTHER_TAB });
  await expect(alert).toBeVisible();
  // 失敗した操作は、記事の画面でも一覧でも、押す前の表示に戻る（読み直しもできないので、手元の
  // 表示で戻す）
  await expect.poll(saveButtons(firstRow)).toEqual(["Save", "Save"]);
  // 開いたときの既読も書けないので、一覧の行は未読に戻る
  await expect(secondRow).toHaveClass(/\bunread\b/);
  await secondRow.click();
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("二つめの記事");
  await expect(secondRow).toHaveClass(/\bunread\b/);

  // 版の違うタブを閉じたらすぐ押しても、押した向きに切り替わる
  await other.close();
  await expect(alert).toHaveCount(0);
  await tab.keyboard.press("s");
  await expect.poll(saveButtons(secondRow)).toEqual(["Unsave", "Unsave"]);
  await tab.reload();
  await expect(view.getByRole("button", { name: "Unsave", exact: true })).toBeVisible();
});

test("Google のログインから戻ったところで版の違う代表がいても、そのタブを閉じれば、ログインを済ませて使える", async ({
  page,
  context,
}) => {
  await routeFakeSendo(context, seed());
  await page.goto("/");
  const login = page.getByRole("button", { name: "Google でログイン" });
  await expect(login).toBeVisible();
  // このページが代表のうちに、版の違うタブがロックを待ち始める。ログインの画面へ移ると、このページの
  // ワーカーが閉じ、版の違うタブが代表になる
  const other = await openOtherVersion(context, null);
  await signIn(page);
  await leading(other);
  const alert = page.getByRole("alert").filter({ hasText: OTHER_TAB });
  await expect(alert).toBeVisible();

  // 戻ってきたときの、sendo のセッションを見る起動を、版の合う代表に替わってから続ける
  await other.close();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".article-list .item", { hasText: "最初の記事" })).toBeVisible();
});
