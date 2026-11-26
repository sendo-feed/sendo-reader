import { expect, type Page, type Route, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";

function seed() {
  const server = new FakeSendo();
  const blog = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  const news = server.subscribe({ url: "https://news.example/rss", title: "News" });
  return { server, blog, news };
}

function bell(page: Page, name: string) {
  return page.getByRole("main").getByRole("button", { name: `Bell: ${name}`, exact: true });
}

async function syncNow(page: Page) {
  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.click();
  await expect(sync).toBeEnabled();
}

test("ベルは既定で外れていて、押すとすぐ付き、同期で sendo にベルができる", async ({
  page,
  context,
}) => {
  const { server, blog, news } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const blogBell = bell(page, "Blog");
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");
  await expect(bell(page, "News")).toHaveAttribute("aria-pressed", "false");

  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  await syncNow(page);
  expect(server.activeBells()).toMatchObject([{ feedId: blog.id, words: null }]);
  expect(server.activeBells().some((row) => row.feedId === news.id)).toBe(false);

  // 読み込み直しても、付けたまま
  await page.reload();
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");
  await syncNow(page);
  expect(server.activeBells()).toEqual([]);
});

test("オフラインで押しても表示はすぐ変わり、オンラインに戻ると送られる", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const blogBell = bell(page, "Blog");
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");

  // setOffline はワーカーの通信を止めないので、sendo への通信も断つ
  const offline = (route: Route) => route.abort("internetdisconnected");
  await context.setOffline(true);
  await context.route("**/api/v1/**", offline);
  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  // 書き込みのあとの同期（少し待ってから）も、届かずに終わる
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveAttribute("title", /Offline/);
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  expect(server.bellRequests).toEqual([]);

  await context.unroute("**/api/v1/**", offline);
  await context.setOffline(false);
  // 届かなかった同期は、間をおいてやり直す（最初は 5 秒あと）
  await expect
    .poll(() => server.activeBells().map((row) => row.feedId), { timeout: 15_000 })
    .toEqual([blog.id]);
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
});

test("購読がほかの端末で消されていて送れなかったら、ベルの表示が戻る", async ({
  page,
  context,
}) => {
  const { server, blog } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const blogBell = bell(page, "Blog");
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");

  server.unsubscribe(blog.id);
  // 購読をやめた差分が届く前に、送ったベルが断られて戻るところを見る（差分を取らせない）
  const isSync = (url: URL) => url.pathname === "/api/v1/sync";
  await context.route(isSync, (route) => route.abort("failed"));
  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => server.bellRequests.length).toBe(1);
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");
  expect(server.activeBells()).toEqual([]);

  // 差分が届くと、購読ごと消える
  await context.unroute(isSync);
  await syncNow(page);
  await expect(blogBell).toHaveCount(0);
});

test("押してすぐもう一度押すと、最後の状態が sendo に残る", async ({ page, context }) => {
  const { server, blog } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  const blogBell = bell(page, "Blog");
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");

  await blogBell.click();
  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");
  await syncNow(page);
  expect(server.activeBells()).toEqual([]);
  await expect(blogBell).toHaveAttribute("aria-pressed", "false");

  await blogBell.click();
  await blogBell.click();
  await blogBell.click();
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
  await syncNow(page);
  expect(server.activeBells().map((row) => row.feedId)).toEqual([blog.id]);
  await expect(blogBell).toHaveAttribute("aria-pressed", "true");
});

test("ほかの端末で付けたベルが、同期のあと、この端末の画面にも出る", async ({
  browser,
  page,
  context,
}) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/manage");
  await signIn(page);
  await expect(bell(page, "News")).toHaveAttribute("aria-pressed", "false");

  const otherContext = await browser.newContext();
  try {
    await routeFakeSendo(otherContext, server);
    const other = await otherContext.newPage();
    await other.goto("/manage");
    await signIn(other);
    await bell(other, "News").click();
    await expect(bell(other, "News")).toHaveAttribute("aria-pressed", "true");
    await syncNow(other);
  } finally {
    await otherContext.close();
  }

  await syncNow(page);
  await expect(bell(page, "News")).toHaveAttribute("aria-pressed", "true");
  await expect(bell(page, "Blog")).toHaveAttribute("aria-pressed", "false");
});
