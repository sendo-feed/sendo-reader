import { expect, type Page, test } from "@playwright/test";
import type { TabMessage, WorkerMessage } from "../../../packages/core/src/web/protocol";
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

for (const width of [390, 1200]) {
  test(`一覧の末尾を越えて指を動かした分だけ完了欄がついてきて、離すと戻る（幅${width}）`, async ({
    page,
    context,
  }) => {
    const { server } = seed(20);
    await routeFakeSendo(context, server);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    await expect(list.locator(".row")).toHaveCount(20);
    await scroll(page, 100_000);
    await scroll(page, -120);

    const footer = list.locator(".end-content");
    const remaining = () =>
      list.evaluate((node, narrow) => {
        const root = narrow ? (document.scrollingElement ?? node) : node;
        return root.scrollHeight - root.clientHeight - root.scrollTop;
      }, width === 390);
    const offset = () =>
      footer.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m42);
    const x = await list.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return Math.round(rect.left + rect.width / 2);
    });
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: y === undefined ? [] : [{ x, y }],
      });

    expect(await remaining()).toBeGreaterThan(100);
    await touch("touchStart", 520);
    await touch("touchMove", 460);
    await expect.poll(remaining).toBeLessThan(100);
    expect(await remaining()).toBeGreaterThan(1);
    expect(await offset()).toBe(0);

    const endY = 460 - Math.ceil(await remaining()) - 16;
    await touch("touchMove", endY);
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    expect(await offset()).toBeGreaterThan(-7);
    await touch("touchMove", endY - 120);
    await expect.poll(offset).toBeLessThan(-5);
    expect(await offset()).toBeGreaterThanOrEqual(-24);
    expect(await remaining()).toBeLessThanOrEqual(1);

    await touch("touchEnd");
    await expect.poll(offset).toBe(0);
    expect(await remaining()).toBeLessThanOrEqual(1);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await touch("touchStart", 520);
    await touch("touchMove", 300);
    expect(await offset()).toBe(0);
    await touch("touchEnd");
  });
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

test("一部をスクロールで読んだあと、残りが別端末で既読になっても祝わない", async ({
  page,
  context,
}) => {
  const { server } = seed(20);
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".row.unread")).toHaveCount(20);
  await page.waitForTimeout(400);
  await scroll(page, 220);
  await expect.poll(() => list.locator(".row.unread").count()).toBeLessThan(20);
  expect(await list.locator(".row.unread").count()).toBeGreaterThan(0);
  for (const article of server.inbox.values()) server.setArticleState(article.id, { read: true });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(list.locator(".row.unread")).toHaveCount(0);
  await expect(page.locator(".read-celebration")).toHaveCount(0);
  await expect(list.locator(".end").getByRole("status")).toHaveCount(0);
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

test("スマホの All を押し直すと、手元の未読だけで開き直す", async ({ page, context }) => {
  const { server } = seed(20);
  await routeFakeSendo(context, server);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  const rows = list.locator(".row");
  const all = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All" });
  await expect(rows).toHaveCount(20);
  await context.setOffline(true);
  await scroll(page, 220);
  await expect.poll(() => list.locator(".row.unread").count()).toBeLessThan(20);
  const unread = await list.locator(".row.unread").count();
  expect(unread).toBeGreaterThan(0);

  await all.click();
  await expect(rows).toHaveCount(unread);
  await expect(list.locator(".row.unread")).toHaveCount(unread);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await readToEnd(page);
  await expect(page.locator(".read-celebration")).toBeVisible();

  await all.click();
  await expect(rows).toHaveCount(0);
  await expect(list.getByText("すべて読み終えました。")).toBeVisible();
});

declare global {
  interface Window {
    holdNextListPage: boolean;
    heldListPages: ((fail?: boolean) => void)[];
  }
}

/** ワーカーで実際に一覧を読み、指定した応答だけを画面に返す前に止める。 */
async function holdListPageResults(page: Page) {
  await page.addInitScript(() => {
    window.holdNextListPage = false;
    window.heldListPages = [];
    window.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const held = new Set<number>();
        const post = this.postMessage.bind(this);
        this.postMessage = (
          message: TabMessage,
          options: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          if (
            window.holdNextListPage &&
            message.type === "call" &&
            message.method === "listArticles" &&
            (message.args[0] as { after?: unknown }).after === undefined
          ) {
            window.holdNextListPage = false;
            held.add(message.id);
          }
          if (Array.isArray(options)) post(message, options);
          else post(message, options);
        };
        this.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
          const reply = event.data;
          if (reply.type !== "result" || !held.delete(reply.id)) return;
          event.stopImmediatePropagation();
          window.heldListPages.push((fail = false) => {
            const data: WorkerMessage = fail
              ? {
                  type: "result",
                  id: reply.id,
                  result: {
                    ok: false,
                    error: { name: "Error", message: "一覧を読み出せなかった" },
                  },
                }
              : reply;
            this.dispatchEvent(new MessageEvent("message", { data }));
          });
        });
      }
    };
  });
}

for (const overlap of [false, true]) {
  test(`スマホの All の読み直しが失敗しても、スクロール既読を続けられる（読み直しの重なり=${overlap}）`, async ({
    page,
    context,
  }) => {
    const { server, feed } = seed(20);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await holdListPageResults(page);
    await routeFakeSendo(context, server);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    const rows = list.locator(".row");
    const unreadRows = list.locator(".row.unread");
    const count = list.locator("header .to-top .count");
    const all = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All" });
    await expect(unreadRows).toHaveCount(20);
    await expect(count).toHaveText("20");

    if (overlap) {
      server.deliver(feed.id, { title: "新着の記事", publishedAt: Date.now() + 1000 });
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("button", { name: "Sync now", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(list.getByRole("button", { name: "1 new", exact: true })).toBeVisible();
      await expect(count).toHaveText("21");
    }
    await context.setOffline(true);

    async function reloadAndHold(total: number) {
      await page.evaluate(() => {
        window.holdNextListPage = true;
      });
      await all.click();
      await expect.poll(() => page.evaluate(() => window.heldListPages.length)).toBe(total);
    }

    async function passSeveralRows() {
      for (let i = 0; i < 4; i++) {
        await scroll(page, 100);
        await page.waitForTimeout(60);
      }
    }

    await reloadAndHold(1);
    if (overlap) await reloadAndHold(2);
    await page.evaluate(() => window.heldListPages[0]?.(true));
    await expect(rows).toHaveCount(20);

    if (overlap) {
      // あとから始めた読み出しが終わるまでは、行を通り過ぎても既読にしない
      await passSeveralRows();
      await page.waitForTimeout(400);
      await expect(unreadRows).toHaveCount(20);
      await expect(count).toHaveText("21");
      await page.evaluate(() => window.heldListPages[1]?.());
      await expect(unreadRows).toHaveCount(21);
      await expect(rows.first()).toContainText("新着の記事");
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    }

    const before = overlap ? 21 : 20;
    await passSeveralRows();
    await expect.poll(() => unreadRows.count()).toBeLessThan(before);
    await expect.poll(async () => Number(await count.textContent())).toBeLessThan(before);
    await expect(rows).toHaveCount(before);
    expect(errors).toEqual([]);
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`表示中の記事を読み切り、末尾の次のスワイプで新着を開く（動きの設定=${reducedMotion}）`, async ({
    page,
    context,
  }) => {
    const { server, feed } = seed(6);
    await routeFakeSendo(context, server);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    await signIn(page);
    const list = page.locator(".article-list");
    const rows = list.locator(".row");
    await expect(rows).toHaveCount(6);
    server.deliver(feed.id, { title: "新着の記事", publishedAt: Date.now() + 1000 });
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    await page.keyboard.press("Escape");
    const fresh = list.getByRole("button", { name: "1 new", exact: true });
    await expect(fresh).toBeVisible();
    await expect(rows).toHaveCount(6);

    await context.setOffline(true);
    await readToEnd(page);
    const status = list.getByRole("status");
    await expect(status).toHaveText("表示中の記事を読み終えました。");
    await expect(page.locator(".read-celebration")).toHaveCount(
      reducedMotion === "no-preference" ? 1 : 0,
    );
    await expect(rows).toHaveCount(6);
    await expect(list.getByRole("button", { name: "Load new articles" })).toBeVisible();

    // 最後の行が見出しを通過した後にも、指に合わせて進める通常のスクロール領域がある
    await scroll(page, 100_000);
    await scroll(page, -56);
    const remaining = () =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
      );
    expect(await remaining()).toBe(56);
    const tail = await rows.last().boundingBox();
    const header = await list.locator("header").boundingBox();
    expect(tail?.y).toBeLessThan((header?.y ?? 0) + (header?.height ?? 0));

    const touch = (type: "touchStart" | "touchMove" | "touchCancel" | "touchEnd", y?: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: y === undefined ? [] : [{ x: 195, y }],
      });
    await touch("touchStart", 560);
    await touch("touchMove", 460);
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await touch("touchMove", 330);
    await touch("touchCancel");
    await expect(rows).toHaveCount(6);

    await touch("touchStart", 560);
    await touch("touchMove", 440);
    await touch("touchMove", 310);
    await expect(rows).toHaveCount(6);
    await touch("touchEnd");

    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("新着の記事");
    await expect(rows).toHaveClass(/\bunread\b/);
    await expect(fresh).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
}
