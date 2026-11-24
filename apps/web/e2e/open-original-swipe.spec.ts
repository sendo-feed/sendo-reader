import { type CDPSession, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
test.use(phone);

const originalUrl = "https://blog.example/article";

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.deliver(feed.id, {
    title: "リンクのある記事",
    url: originalUrl,
    content: `<p>選択できる本文</p><pre>${"long line ".repeat(30)}</pre>${"<p>縦に読む本文</p>".repeat(45)}`,
  });
  server.deliver(feed.id, { title: "リンクのない記事", url: null });
  server.deliver(feed.id, { title: "HTTP 以外の URL の記事", url: "ftp://blog.example/article" });
  return server;
}

async function openReading(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading", exact: true }).click();
}

async function openArticle(page: Page, title: string) {
  await page.locator(".article-list").getByText(title, { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.locator(".article-view")).toHaveCSS("transform", "none");
}

async function centerY(element: Locator) {
  const box = await element.boundingBox();
  if (box === null) throw new Error("スワイプの起点が見つからない");
  return Math.round(box.y + box.height / 2);
}

async function drag(cdp: CDPSession, x: number, y: number, dx: number, dy = 0) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (const step of [1 / 3, 2 / 3, 1]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + dx * step, y: y + dy * step }],
    });
  }
}

function release(cdp: CDPSession) {
  return cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("記事の左右スワイプで元のタブに記事を残してリンクを開く", async ({ page, context }) => {
  const server = seed();
  await routeFakeSendo(context, server);
  await context.route(originalUrl, (route) => route.fulfill({ body: "Original" }));
  await page.goto("/");
  await signIn(page);
  await openReading(page);
  const left = page.getByLabel("Article: swipe left");
  const right = page.getByLabel("Article: swipe right");
  await expect(left).toHaveValue("none");
  await expect(right).toHaveValue("back");
  await left.selectOption({ label: "Open original" });
  await right.selectOption({ label: "Open original" });
  await expect(
    page.getByLabel("List: swipe left").getByRole("option", { name: "Open original" }),
  ).toHaveCount(0);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All" }).click();
  await openArticle(page, "リンクのある記事");
  const cdp = await context.newCDPSession(page);
  const view = page.locator(".article-view");
  const hint = view.locator(".swipe-hint");
  const articleUrl = page.url();
  const y = await centerY(view.getByText("選択できる本文", { exact: true }));
  await drag(cdp, 190, y, -50);
  await expect(hint).toHaveText("Open original");
  await expect(hint).not.toHaveClass(/armed/);
  // 指を止めて離すと、距離が足りないスワイプははじいた扱いにならない
  await page.waitForTimeout(150);
  await release(cdp);
  await expect(view).not.toHaveClass(/moved/);
  expect(context.pages()).toEqual([page]);

  for (const dx of [-145, 145]) {
    await drag(cdp, 190, y, dx);
    await expect(hint).toHaveText("Open original");
    await expect(hint).toHaveClass(/armed/);
    await expect(view).toHaveCSS("--drag", dx < 0 ? "-112px" : "112px");
    const opened = context.waitForEvent("page");
    await release(cdp);
    const original = await opened;
    await expect(original).toHaveURL(originalUrl);
    await original.close();
    await expect(view).not.toHaveClass(/moved/);
    await expect(hint).toHaveCount(0);
    await expect(page).toHaveURL(articleUrl);
  }
});

test("Open original の左右の設定を別のスマホに引き継ぐ", async ({ browser, page, context }) => {
  const server = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await openReading(page);
  await page.getByLabel("Article: swipe left").selectOption({ label: "Open original" });
  await page.getByLabel("Article: swipe right").selectOption({ label: "Open original" });
  await expect
    .poll(() => server.settingsOf("mobile"))
    .toMatchObject({
      "reader.swipe.articleLeft": "open",
      "reader.swipe.articleRight": "open",
    });
  const other = await browser.newContext({ ...phone, baseURL: new URL(page.url()).origin });
  try {
    await routeFakeSendo(other, server);
    const device = await other.newPage();
    await device.goto("/");
    await signIn(device);
    await openReading(device);
    await expect(device.getByLabel("Article: swipe left")).toHaveValue("open");
    await expect(device.getByLabel("Article: swipe right")).toHaveValue("open");
  } finally {
    await other.close();
  }
});

test("スワイプの途中で割り当てが同期されても、次のスワイプから適用する", async ({
  page,
  context,
}) => {
  const server = seed();
  // 別のスマホが預けた設定を同期してから使う
  server.putSetting("mobile", "reader.swipe.articleLeft", "star");
  server.putSetting("mobile", "reader.theme", "light");
  await routeFakeSendo(context, server);
  await context.route(originalUrl, (route) => route.fulfill({ body: "Original" }));
  await page.goto("/");
  await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openArticle(page, "リンクのある記事");
  const cdp = await context.newCDPSession(page);
  const view = page.locator(".article-view");
  const y = await centerY(view.getByText("選択できる本文", { exact: true }));
  await drag(cdp, 190, y, -145);
  await expect(view.locator(".swipe-hint")).toHaveText("Save");

  server.putSetting("mobile", "reader.swipe.articleLeft", "open");
  server.putSetting("mobile", "reader.theme", "dark");
  await page.keyboard.press("r");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await release(cdp);
  await expect(view.getByRole("button", { name: "Unsave" })).toBeVisible();
  await expect(view).not.toHaveClass(/moved/);
  expect(context.pages()).toEqual([page]);

  await drag(cdp, 190, y, -145);
  await expect(view.locator(".swipe-hint")).toHaveText("Open original");
  const opened = context.waitForEvent("page");
  await release(cdp);
  const original = await opened;
  await expect(original).toHaveURL(originalUrl);
  await original.close();
});

test("記事の切り替えで本文が差し替わったら、進行中のスワイプを取り消す", async ({
  page,
  context,
}) => {
  const server = new FakeSendo();
  server.putSetting("mobile", "reader.swipe.articleLeft", "open");
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  server.deliver(feed.id, {
    title: "次の記事",
    url: "https://blog.example/second",
    publishedAt: server.now - 1000,
  });
  server.deliver(feed.id, {
    title: "元の記事",
    url: originalUrl,
    content: "<p>選択できる本文</p>",
  });
  await routeFakeSendo(context, server);
  await context.route("https://blog.example/**", (route) => route.fulfill({ body: "Original" }));
  await page.goto("/");
  await signIn(page);
  await openArticle(page, "元の記事");
  const cdp = await context.newCDPSession(page);
  const view = page.locator(".article-view");
  const y = await centerY(view.getByText("選択できる本文", { exact: true }));
  await drag(cdp, 190, y, -145);
  await expect(view.locator(".swipe-hint")).toHaveClass(/armed/);
  await page.keyboard.press("j");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("次の記事");
  await release(cdp);
  await expect(view).not.toHaveClass(/moved/);
  await expect(view.locator(".swipe-hint")).toHaveCount(0);
  expect(context.pages()).toEqual([page]);
});

test("要約が全文に差し替わっても、同じ記事のスワイプを完了できる", async ({ page, context }) => {
  const server = new FakeSendo();
  server.putSetting("mobile", "reader.swipe.articleLeft", "open");
  const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const article = server.deliver(feed.id, {
    title: "要約付きの記事",
    url: originalUrl,
    summary: "短い要約",
  });
  server.pageContents.set(article.id, "<p>要約にない全文の続き</p>");
  const contentReady = Promise.withResolvers<void>();
  server.onRequest = (path) =>
    path.endsWith("/content") ? contentReady.promise : Promise.resolve();
  await routeFakeSendo(context, server);
  await context.route(originalUrl, (route) => route.fulfill({ body: "Original" }));
  await page.goto("/");
  await signIn(page);
  await openArticle(page, "要約付きの記事");
  const cdp = await context.newCDPSession(page);
  const view = page.locator(".article-view");
  const summary = view.getByText("短い要約", { exact: true });
  const y = await centerY(summary);
  const hint = view.locator(".swipe-hint");
  await drag(cdp, 190, y, -50);
  await expect(hint).toHaveText("Open original");
  await expect(hint).not.toHaveClass(/armed/);

  contentReady.resolve();
  await expect(view.getByText("要約にない全文の続き", { exact: true })).toBeVisible();
  await expect(summary).toHaveCount(0);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 45, y }] });
  await expect(hint).toHaveClass(/armed/);
  const opened = context.waitForEvent("page");
  await release(cdp);
  const original = await opened;
  await expect(original).toHaveURL(originalUrl);
  await original.close();
  await expect(view).not.toHaveClass(/moved/);
  await expect(hint).toHaveCount(0);
});

test("既定の左スワイプや、リンクがない記事や本文を操作するときのスワイプでは開かない", async ({
  page,
  context,
}) => {
  const server = seed();
  await routeFakeSendo(context, server);
  await context.route(originalUrl, (route) => route.fulfill({ body: "Original" }));
  await page.goto("/");
  await signIn(page);
  await page.getByRole("button", { name: "Unread only" }).click();
  await openArticle(page, "リンクのある記事");
  const cdp = await context.newCDPSession(page);
  const view = page.locator(".article-view");
  const content = view.getByText("選択できる本文", { exact: true });
  const articleUrl = page.url();
  await drag(cdp, 190, await centerY(content), -145);
  await expect(view).not.toHaveClass(/moved/);
  await release(cdp);
  await expect(page).toHaveURL(articleUrl);
  expect(context.pages()).toEqual([page]);
  await view.getByRole("button", { name: "Back", exact: true }).click();

  await openReading(page);
  await page.getByLabel("Article: swipe left").selectOption({ label: "Open original" });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All" }).click();

  for (const title of ["リンクのない記事", "HTTP 以外の URL の記事"]) {
    await openArticle(page, title);
    await drag(cdp, 190, 280, -145);
    await expect(view).not.toHaveClass(/moved/);
    await release(cdp);
    await expect(view.getByRole("heading", { level: 1 })).toHaveText(title);
    await view.getByRole("button", { name: "Back", exact: true }).click();
  }
  await openArticle(page, "リンクのある記事");
  await expect(content).toBeVisible();
  await drag(cdp, 190, 420, -55, -180);
  await release(cdp);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);

  const code = view.locator("pre");
  await code.scrollIntoViewIfNeeded();
  await drag(cdp, 190, await centerY(code), -145);
  await expect(view).not.toHaveClass(/moved/);
  await release(cdp);
  await expect.poll(() => code.evaluate((pre) => pre.scrollLeft)).toBeGreaterThan(0);

  await content.scrollIntoViewIfNeeded();
  // Touch CDP でスワイプを始める前に、選択済みの本文を作る
  await content.evaluate((paragraph) => getSelection()?.selectAllChildren(paragraph));
  await drag(cdp, 190, await centerY(content), -145);
  await expect(view).not.toHaveClass(/moved/);
  await release(cdp);
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("リンクのある記事");
  expect(context.pages()).toEqual([page]);
});
