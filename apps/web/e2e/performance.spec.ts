import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

/**
 * 速さの予算（docs/decisions/performance.md）。CI の機械は手元のスマホより速いので、CPU を 4 倍
 * 遅くして測る。
 */
const CPU_SLOWDOWN = 4;
const ARTICLES = 1000;

test.describe("速さの予算", () => {
  test.beforeEach(async ({ page, context }) => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    for (let i = 0; i < ARTICLES; i++) {
      server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: server.now - i * 60_000 });
    }
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    // すべての記事が手元に届き、Service Worker がページを受け持つまで待つ
    await expect(page.locator("nav a", { hasText: "未読" })).toContainText(String(ARTICLES), {
      timeout: 30_000,
    });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await expect(page.locator(".article-list .item").first()).toBeVisible();
  });

  test("キャッシュ済みの起動から記事の一覧が出るまで、1 秒以内（オフライン）", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

    await page.reload({ waitUntil: "commit" });
    const shownAt = await page
      .waitForFunction(
        () => (document.querySelector(".article-list .item") === null ? null : performance.now()),
        null,
        { polling: "raf", timeout: 10_000 },
      )
      .then((handle) => handle.jsonValue());
    console.log(`記事の一覧が出るまで：${Math.round(shownAt as number)}ms`);
    expect(shownAt).toBeLessThan(1000);
  });

  test("操作への反応は 100ms 以内（スターと既読）", async ({ page, context }) => {
    await page.locator(".article-list .item").first().click();
    await expect(page.getByRole("button", { name: "☆ スターを付ける" })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

    for (const [press, expected] of [
      ["☆ スターを付ける", "★ スターを外す"],
      ["未読に戻す", "既読にする"],
    ] as const) {
      const elapsed = await page.evaluate(
        ({ press, expected }) =>
          new Promise<number>((resolve) => {
            const find = (label: string) =>
              [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
            const start = performance.now();
            find(press)?.click();
            const check = () => {
              if (find(expected) !== undefined) resolve(performance.now() - start);
              else requestAnimationFrame(check);
            };
            check();
          }),
        { press, expected },
      );
      console.log(`「${press}」の反応：${Math.round(elapsed)}ms`);
      expect(elapsed).toBeLessThan(100);
    }
  });
});
