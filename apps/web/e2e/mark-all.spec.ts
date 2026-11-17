import { expect, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  for (const device of ["desktop", "mobile"]) {
    server.putSetting(device, "reader.markReadOnScroll", false);
  }
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  for (let i = 0; i < 20; i++) {
    server.deliver(feed.id, { title: `記事 ${i}`, publishedAt: Date.now() - i * 60_000 });
  }
  return { server, feed };
}

for (const width of [1200, 390]) {
  test(`一覧の末尾でまとめて既読にすると、オフラインでも空になり、取り消すと戻る（幅 ${width}）`, async ({
    page,
    context,
  }) => {
    const { server, feed } = seed();
    await routeFakeSendo(context, server);
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/feeds/${feed.id}`);
    await signIn(page);
    const list = page.locator(".article-list");
    await expect(list.locator(".item")).toHaveCount(20);
    await context.setOffline(true);
    const end = list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true });
    await end.scrollIntoViewIfNeeded();
    const scrollTop = () =>
      width === 390
        ? page.evaluate(() => window.scrollY)
        : list.evaluate((element) => element.scrollTop);
    await expect.poll(scrollTop).toBeGreaterThan(0);
    await end.click();
    await expect(list.locator(".item")).toHaveCount(0);
    await expect(list.getByText("すべて読み終えました。")).toBeVisible();
    await expect.poll(scrollTop).toBe(0);
    await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
    await expect(list.locator(".row.unread")).toHaveCount(20);
    await expect.poll(scrollTop).toBe(0);
  });
}

test("既読も出す一覧では、末尾で既読にしたあとも記事を残し、先頭に戻る", async ({
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(20);
  await list.getByRole("button", { name: "Unread only", exact: true }).click();
  await list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect(list.locator(".item")).toHaveCount(20);
  await expect(list.locator(".row.unread")).toHaveCount(0);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(list.locator(".row.unread")).toHaveCount(20);
});

test("スマートフォンで記事を読んでいる間に取り消しても、本文のスクロール位置を保つ", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  server.deliver(feed.id, {
    title: "長い記事",
    summary: "長い本文。".repeat(800),
    publishedAt: Date.now() + 1000,
  });
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/feeds/${feed.id}`);
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(21);
  await list.getByRole("button", { name: "Unread only", exact: true }).click();
  await list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("21 件を既読にしました。");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await list.locator(".item", { hasText: "長い記事" }).click();
  await expect(page.locator(".article-view").getByRole("heading", { level: 1 })).toHaveText(
    "長い記事",
  );
  await page.evaluate(() => window.scrollTo({ top: 900 }));
  const top = await page.evaluate(() => window.scrollY);
  expect(top).toBeGreaterThan(500);
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status")).toContainText("21 件を未読に戻しました。");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(top);
  await expect(list).toBeHidden();
});

declare global {
  interface Window {
    markAllHeld: boolean;
    releaseMarkAll: () => void;
  }
}

/** 実際の DB の既読化は済ませ、画面への完了通知だけを遅らせて、競合の順序を確定する。 */
async function holdMarkAllResult(page: Page) {
  await page.addInitScript(() => {
    window.markAllHeld = false;
    window.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let markAllId: number | null = null;
        const post = this.postMessage.bind(this);
        this.postMessage = (
          message: unknown,
          options: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          const call = message as { type: string; method?: string; id?: number };
          if (call.type === "call" && call.method === "markAllRead") markAllId = call.id ?? null;
          if (Array.isArray(options)) post(message, options);
          else post(message, options);
        };
        this.addEventListener("message", (event) => {
          if (event.data.type !== "result" || event.data.id !== markAllId) return;
          event.stopImmediatePropagation();
          markAllId = null;
          window.markAllHeld = true;
          window.releaseMarkAll = () => {
            this.dispatchEvent(new MessageEvent("message", { data: event.data }));
          };
        });
      }
    };
  });
}

test("末尾での既読化中に同期した新着は、読み直した一覧に出し、取り消しでも残す", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  await holdMarkAllResult(page);
  await routeFakeSendo(context, server);
  await page.goto(`/feeds/${feed.id}`);
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(20);
  await list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.markAllHeld)).toBe(true);
  server.deliver(feed.id, { title: "処理中に届いた新着", publishedAt: Date.now() + 1000 });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(list.getByRole("button", { name: "1 new" })).toBeVisible();
  await page.evaluate(() => window.releaseMarkAll());
  await expect(list.locator(".title")).toHaveText(["処理中に届いた新着"]);
  await expect(list.locator(".row.unread")).toHaveCount(1);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(list.locator(".row.unread")).toHaveCount(21);
});

test("末尾で既読にしている間に別の一覧へ移っても、移動先の位置を戻さない", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  const other = server.subscribe({ url: "https://other.example/feed.xml", title: "Other" });
  for (let i = 0; i < 20; i++) server.deliver(other.id, { title: `別の記事 ${i}` });
  await holdMarkAllResult(page);
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 1200, height: 700 });
  // 全フィードの一覧には「次のフィード」がない
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item")).toHaveCount(40);
  await list.locator(".end").getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.markAllHeld)).toBe(true);
  await page.locator("nav.sidebar").getByRole("link", { name: "Blog", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/feeds/${feed.id}$`));
  // 既読も出して、移動先の途中まで読む
  await list.getByRole("button", { name: "Unread only", exact: true }).click();
  await expect(list.locator(".item")).toHaveCount(20);
  await list.evaluate((element) => element.scrollTo({ top: 400 }));
  const top = await list.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.evaluate(() => window.releaseMarkAll());
  await expect(page.getByRole("status")).toContainText("40 件を既読にしました。");
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(top);
});
