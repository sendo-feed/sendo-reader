import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * ページが bfcache に入るときに DB のワーカーを止め、戻ったら読み込み直す（Issue #250）。
 * Safari は、ワーカーごとページを止めて残し、代表のロックを持ったままにする。Chromium は、ロックを
 * 持つページを bfcache に入れず、Playwright は bfcache を切っているので、bfcache に入る・戻る
 * ときのイベント（persisted が true の pagehide ／ pageshow）を、ページに起こして真似る。
 */

const LEADER_LOCK = "sendo-reader:leader";

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed", title: "Blog" });
  server.deliver(feed.id, { title: "最初の記事" });
  return server;
}

/** 代表のロックを持っているクライアントの数 */
function heldLeaderLocks(page: Page): Promise<number> {
  return page.evaluate(
    async (name) => (await navigator.locks.query()).held?.filter((l) => l.name === name).length,
    LEADER_LOCK,
  ) as Promise<number>;
}

function firePageTransition(page: Page, type: "pagehide" | "pageshow"): Promise<void> {
  return page.evaluate(
    (type) => void window.dispatchEvent(new PageTransitionEvent(type, { persisted: true })),
    type,
  );
}

test("bfcache に入るときに代表のロックを離して、次に開いたページが動き、戻ったら読み込み直す", async ({
  page,
  context,
}) => {
  await routeFakeSendo(context, seed());
  await page.goto("/");
  await signIn(page);
  const item = (p: Page) => p.locator(".article-list .item", { hasText: "最初の記事" });
  await expect(item(page)).toBeVisible();
  expect(await heldLeaderLocks(page)).toBe(1);

  // ログインへ移るなどして、bfcache に入る
  await firePageTransition(page, "pagehide");
  await expect.poll(() => heldLeaderLocks(page)).toBe(0);

  // 次に開いたページ（ログインから戻ったページ）は、代表になって、Loading… で止まらない
  const next = await context.newPage();
  await next.goto("/");
  await expect(item(next)).toBeVisible();
  expect(await heldLeaderLocks(next)).toBe(1);

  // 「戻る」で bfcache から戻ると、ワーカーがいないので読み込み直し、動く画面を出す
  const reloaded = page.waitForEvent("load");
  await firePageTransition(page, "pageshow");
  await reloaded;
  await expect(item(page)).toBeVisible();
  await item(page).click();
  await page.keyboard.press("s");
  await expect(page.locator(".article-view").getByRole("button", { name: "Unsave" })).toBeVisible();
});

test("bfcache に入らないとき（persisted が false）は、ワーカーを止めない", async ({
  page,
  context,
}) => {
  await routeFakeSendo(context, seed());
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item", { hasText: "最初の記事" })).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  });
  await page.waitForTimeout(300);
  expect(await heldLeaderLocks(page)).toBe(1);
  await page.locator(".article-list .item", { hasText: "最初の記事" }).click();
  await page.keyboard.press("s");
  await expect(page.locator(".article-view").getByRole("button", { name: "Unsave" })).toBeVisible();
});
