import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

test.describe("モバイルの保存表示", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme}: 保存の有無・既読・画像によらず、しおりの位置と行の高さを保つ`, async ({
      page,
      context,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      const server = new FakeSendo();
      const feed = server.subscribe({
        url: "https://blog.example/feed.xml",
        title: "フィード名が長くても、時刻と保存状態を確かめられる",
        iconUrl: server.imageUrl("https://blog.example/icon.png"),
      });
      const now = Date.now();
      const deliver = (image: boolean, i: number) =>
        server.deliver(feed.id, {
          title: i === 1 ? "保存していない記事" : "保存した記事の長いタイトル。".repeat(6),
          thumbnailUrl: image ? server.imageUrl(`https://blog.example/${i}.png`) : null,
          publishedAt: now - i * 1000,
        });
      const articles = [deliver(true, 0), deliver(false, 1), deliver(true, 2)] as const;
      server.setArticleState(articles[0].id, { starred: true });
      server.setArticleState(articles[2].id, { starred: true, read: true });
      await routeFakeSendo(context, server);
      await page.goto("/");
      await signIn(page);
      const list = page.locator(".article-list");
      await expect(list.locator(".row")).toHaveCount(2);
      await list.getByRole("button", { name: "Unread only" }).click();
      await expect(list.locator(".row")).toHaveCount(3);
      await expect(list.locator(".thumb img")).toHaveCount(2);
      await expect(list.getByText("Saved", { exact: true })).toHaveCount(2);
      await expect(list.locator(".actions").first()).toBeHidden();
      const mark = list.locator(".saved-status").first();
      const accent = await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "All", exact: true })
        .evaluate((node) => getComputedStyle(node).color);
      await expect(mark).toHaveCSS("color", accent);
      await expect(list.locator(".saved-status").last()).toHaveCSS("color", accent);
      await expect(mark.locator("svg")).toHaveCSS("fill", accent);

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const positions = await list.locator(".row").evaluateAll((rows) =>
          rows.map((row) => {
            const slot = row.querySelector(".saved-status");
            const feed = row.querySelector(".feed-icon");
            const time = row.querySelector(".time");
            const thumbnail = row.querySelector(".thumb");
            if (!slot || !feed || !time) throw new Error("情報行がない");
            const a = slot.getBoundingClientRect();
            const b = feed.getBoundingClientRect();
            const c = time.getBoundingClientRect();
            return {
              height: row.getBoundingClientRect().height,
              left: a.left,
              feedLeft: b.left,
              inMeta: a.right <= b.left,
              timeVisible:
                c.right <=
                (thumbnail?.getBoundingClientRect().left ?? row.getBoundingClientRect().right),
            };
          }),
        );
        expect(new Set(positions.map((p) => p.height)).size).toBe(1);
        expect(new Set(positions.map((p) => p.left)).size).toBe(1);
        expect(new Set(positions.map((p) => p.feedLeft)).size).toBe(1);
        expect(positions.every((p) => p.inMeta && p.timeVisible)).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath(`saved-${colorScheme}.png`) });

      // 通信できなくても保存・解除を即時に反映し、文字の開始位置を動かさない。
      const row = list.locator(`[data-article="${articles[1].id}"]`);
      const feedBefore = await row.locator(".feed").boundingBox();
      await context.setOffline(true);
      await row.locator(".item").click();
      const view = page.locator(".article-view");
      await view.getByRole("button", { name: "Save", exact: true }).click();
      await expect(view.getByRole("button", { name: "Unsave", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(row.getByText("Saved", { exact: true })).toHaveCount(1);
      await expect
        .poll(async () => (await row.locator(".feed").boundingBox())?.x)
        .toBe(feedBefore?.x);
      await row.locator(".item").click();
      await view.getByRole("button", { name: "Unsave", exact: true }).click();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(row.locator(".saved-status svg")).toHaveCount(0);
      await expect
        .poll(async () => (await row.locator(".feed").boundingBox())?.x)
        .toBe(feedBefore?.x);
    });
  }
});
