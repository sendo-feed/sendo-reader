import { expect, test } from "@playwright/test";
import { FakeSendo, routeFakeSendo, signIn } from "./fake-sendo";
import { type FakeUpdates, startFakeUpdates } from "./fake-updates";

/**
 * sendo の通知（WebSocket の /api/v1/sync/updates）を受けたら、すぐ同期する
 * （docs/decisions/local-first.md の 3）。本番のビルドと本番の CSP のまま、DB のワーカーから
 * vite preview の中継を通って、偽の通知のサーバーにつなぐ。
 */

let updates: FakeUpdates;
test.beforeEach(async () => {
  updates = await startFakeUpdates();
});
test.afterEach(async () => {
  await updates.stop();
});

function seed() {
  const server = new FakeSendo();
  const feed = server.subscribe({ url: "https://blog.example/feed", title: "Blog" });
  server.deliver(feed.id, { title: "最初の記事" });
  return { server, feed };
}

test("知らせを受けたら、定期同期を待たずに新着を出す。差分が空の知らせでは何も変わらない", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  await routeFakeSendo(context, server);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.goto("/");
  await signIn(page);
  const list = page.locator(".article-list");
  await expect(list.locator(".item", { hasText: "最初の記事" })).toBeVisible();
  await expect.poll(() => updates.connections.length).toBe(1);
  const [ws] = updates.connections;
  if (ws === undefined) throw new Error("通知につながなかった");
  // 同じオリジンから、ブラウザのセッションのクッキーを付けてつなぐ
  expect(ws.request.headers.origin).toBe("http://localhost:4173");
  expect(ws.request.headers.cookie).toContain("sendo_session=");

  // 自分の変更の知らせなど、差分が空でも困らない
  const syncs = () => server.requests.filter((path) => path.startsWith("GET /sync")).length;
  const before = syncs();
  ws.send(JSON.stringify({ type: "sync_required" }));
  await expect.poll(syncs).toBeGreaterThan(before);
  await expect(list.locator(".item")).toHaveCount(1);

  // 取得のジョブが配った新着が、すぐに知らされる（一覧は読んでいる位置を動かさず、新着の数を出す）
  server.deliver(feed.id, { title: "通知で届いた記事" });
  ws.send(JSON.stringify({ type: "sync_required" }));
  await list.getByRole("button", { name: "1 new" }).click({ timeout: 3000 });
  await expect(list.locator(".item", { hasText: "通知で届いた記事" })).toBeVisible();
  // 知らない形の知らせは無視する
  ws.send(JSON.stringify({ type: "something_new" }));
  ws.send("not json");
  await expect(list.locator(".item")).toHaveCount(2);
  expect(violations).toEqual([]);
});

test("タブが 2 つでも、通知の接続は 1 本", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".article-list .item")).toHaveCount(1);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.locator(".article-list .item")).toHaveCount(1);
  await expect.poll(() => updates.connections.length).toBe(1);
  await page.waitForTimeout(1000);
  expect(updates.connections).toHaveLength(1);
});

test("sendo が 1001 で閉じたら、少し待ってつなぎ直し、つないだときに同期する", async ({
  page,
  context,
}) => {
  const { server, feed } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect.poll(() => updates.connections.length).toBe(1);
  updates.connections[0]?.close(1001);
  // 切れている間に届いた新着も、つなぎ直したときの同期で出る
  server.deliver(feed.id, { title: "切れている間の記事" });
  await expect.poll(() => updates.connections.length, { timeout: 10_000 }).toBe(2);
  const list = page.locator(".article-list");
  await list.getByRole("button", { name: "1 new" }).click({ timeout: 3000 });
  await expect(list.locator(".item", { hasText: "切れている間の記事" })).toBeVisible();
});

test("ログアウトしたら閉じ、つなぎ直さない", async ({ page, context }) => {
  const { server } = seed();
  await routeFakeSendo(context, server);
  await page.goto("/");
  await signIn(page);
  await expect.poll(() => updates.connections.length).toBe(1);
  await page.locator("nav.sidebar").getByRole("button", { name: "Sign out" }).click();
  // ふつうに閉じる（1000）。sendo が閉じたのではないので、つなぎ直さない
  expect(await updates.connections[0]?.closedByBrowser).toBe(1000);
  await page.waitForTimeout(3000);
  expect(updates.connections).toHaveLength(1);
});
