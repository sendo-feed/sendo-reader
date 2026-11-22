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
      server.deliver(feed.id, {
        title: `記事 ${i}`,
        publishedAt: server.now - i * 60_000,
        // 先頭の記事は訳し済み（訳文と原文の切り替えを測る）
        ...(i === 0 && {
          translation: {
            language: "en",
            status: "translated",
            title: `訳した記事 ${i}`,
            summary: null,
            translatedAt: new Date(server.now).toISOString(),
          },
        }),
      });
    }
    await routeFakeSendo(context, server);
    await page.goto("/");
    await signIn(page);
    // すべての記事が手元に届き、Service Worker がページを受け持つまで待つ
    await expect(page.locator("nav.sidebar a", { hasText: "All" })).toContainText(
      String(ARTICLES),
      {
        timeout: 30_000,
      },
    );
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
    const view = page.locator(".article-view");
    await expect(view.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.locator('.article-list .item[aria-current="true"]')).not.toHaveClass(
      /\bunread\b/,
    );
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

    // スターは記事のバーのボタンで、既読はキーボード（m）で切り替え、開いている記事の行に出るまで
    for (const [press, expected] of [
      ["Save", '.article-view button[aria-label="Unsave"]'],
      ["m", '.article-list .item.unread[aria-current="true"]'],
    ] as const) {
      const elapsed = await page.evaluate(
        ({ press, expected }) =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            if (press === "m") {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
            } else {
              document
                .querySelector<HTMLButtonElement>(`.article-view button[aria-label="${press}"]`)
                ?.click();
            }
            const check = () => {
              if (document.querySelector(expected) !== null) resolve(performance.now() - start);
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

  test("訳文と原文の切り替え（t）は 100ms 以内", async ({ page, context }) => {
    await page.locator(".article-list .item").first().click();
    const heading = page.locator(".article-view").getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("訳した記事 0");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

    for (const expected of ["記事 0", "訳した記事 0"]) {
      const elapsed = await page.evaluate(
        (expected) =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
            const check = () => {
              if (document.querySelector(".article-view h1")?.textContent?.trim() === expected) {
                resolve(performance.now() - start);
              } else requestAnimationFrame(check);
            };
            check();
          }),
        expected,
      );
      console.log(`「t」の反応（${expected}）：${Math.round(elapsed)}ms`);
      expect(elapsed).toBeLessThan(100);
    }
  });
});
