import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed(count: number, enabled = true) {
  const server = new FakeSendo();
  for (const device of ["desktop", "mobile"]) {
    server.putSetting(device, "reader.markReadOnScroll", enabled);
  }
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < count; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: Date.now() - i * 60_000 });
  }
  return { server, feed };
}

async function scroll(page: Page, top: number) {
  await page.locator(".article-list").evaluate((node, top) => {
    if (matchMedia("(max-width: 56rem)").matches) window.scrollBy({ top });
    else node.scrollBy({ top });
  }, top);
}

async function readToEnd(page: Page) {
  const list = page.locator(".article-list");
  // 実際の流し読みと同じく、行を見てから通過する。ページの続きも自動で読み出す
  for (let i = 0; i < 100; i++) {
    if ((await list.locator(".row.unread").count()) === 0) return;
    await scroll(page, 220);
    await page.waitForTimeout(60);
  }
}

for (const [width, count] of [
  [1200, 1],
  [390, 1],
  [1200, 61],
  [390, 20],
] as const) {
  test(`スクロールだけで最後まで既読にし、一度だけ祝う（幅${width}・${count}件）`, async ({
    page,
    context,
  }) => {
    const { server } = seed(count);
    await routeFakeSendo(context, server);
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    await expect(list.locator(".row")).toHaveCount(Math.min(count, 50));
    // 一画面より短い一覧も、出しただけでは読んだことにしない
    await page.waitForTimeout(400);
    await expect(list.locator(".row.unread")).toHaveCount(Math.min(count, 50));
    await expect(page.locator(".read-celebration")).toHaveCount(0);
    await context.setOffline(true);
    await readToEnd(page);
    await expect(list.locator(".row")).toHaveCount(count);
    await expect(list.locator(".row.unread")).toHaveCount(0);
    await expect(list.getByRole("status")).toHaveText("すべて読み終えました。");
    const status = await list.getByRole("status").boundingBox();
    const header = await list.locator("header").boundingBox();
    expect(status?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
    const confetti = page.locator(".read-celebration");
    await expect(confetti).toBeVisible();
    expect(await confetti.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
    const bounds = await confetti.boundingBox();
    expect(bounds?.width).toBe(width);
    expect(bounds?.height).toBe(700);
    // 演出中も操作でき、上に戻って読み直しても繰り返さない
    await list.getByTitle("Back to top").click();
    await expect(confetti).toHaveCount(0);
    await readToEnd(page);
    await scroll(page, 100_000);
    await page.waitForTimeout(400);
    await expect(confetti).toHaveCount(0);
    await expect(list.locator(".row.unread")).toHaveCount(0);
    // オフラインの既読が手元に残る
    await page.reload();
    await expect(list.getByText("すべて読み終えました。")).toBeVisible();
    await expect(confetti).toHaveCount(0);
  });
}

test("動きを減らす設定では紙吹雪を出さず、完了だけを知らせる", async ({ page, context }) => {
  const { server } = seed(3);
  await routeFakeSendo(context, server);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".row.unread")).toHaveCount(3);
  await readToEnd(page);
  await expect(page.locator(".end").getByRole("status")).toHaveText("すべて読み終えました。");
  await expect(page.locator(".read-celebration")).toHaveCount(0);
});

for (const alreadyRead of [false, true]) {
  test(`末尾が既読でも、残りの未読をスクロールで読み切ったら祝う（最初から既読=${alreadyRead}）`, async ({
    page,
    context,
  }) => {
    const { server } = seed(3);
    if (alreadyRead) {
      const tail = [...server.inbox.values()].at(-1);
      if (tail === undefined) throw new Error("末尾の記事がありません");
      server.setArticleState(tail.id, { read: true });
      for (const device of ["desktop", "mobile"]) {
        server.putSetting(device, "reader.unreadOnly", false);
      }
    }
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    await expect(list.locator(".row")).toHaveCount(3);
    if (!alreadyRead) {
      await list.locator(".row").last().hover();
      await list
        .locator(".row")
        .last()
        .getByRole("button", { name: "Mark as read", exact: true })
        .click();
    }
    await expect(list.locator(".row.unread")).toHaveCount(2);
    await expect(page.locator(".read-celebration")).toHaveCount(0);
    await context.setOffline(true);
    await readToEnd(page);
    await expect(list.locator(".row.unread")).toHaveCount(0);
    await expect(list.getByRole("status")).toHaveText("すべて読み終えました。");
    await expect(page.locator(".read-celebration")).toBeVisible();
  });
}

test("スクロール既読を切っているときは、末尾でも未読を残す", async ({ page, context }) => {
  const { server } = seed(3, false);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".row.unread")).toHaveCount(3);
  await scroll(page, 100_000);
  await page.waitForTimeout(600);
  await expect(page.locator(".row.unread")).toHaveCount(3);
  await expect(
    page.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".read-celebration")).toHaveCount(0);
});

test("途中のページでは祝わず、別の一覧へ移っても完了を持ち越さない", async ({ page, context }) => {
  const { server, feed } = seed(61);
  await routeFakeSendo(context, server);
  await page.goto(`/feeds/${feed.id}`);
  await signIn(page);
  await expect(page.locator(".row")).toHaveCount(50);
  for (let i = 0; i < 12; i++) {
    await scroll(page, 220);
    await page.waitForTimeout(60);
  }
  await expect(page.locator(".row.unread").first()).toBeVisible();
  await expect(page.locator(".read-celebration")).toHaveCount(0);
  await readToEnd(page);
  await expect(page.locator(".read-celebration")).toBeVisible();
  await page.locator("nav.sidebar").getByRole("link", { name: "All", exact: true }).click();
  await expect(page.locator(".read-celebration")).toHaveCount(0);
  await expect(page.locator(".article-list").getByText("すべて読み終えました。")).toBeVisible();
});
