import { expect, test } from "vitest";
import { ReaderCore } from "../src";
import { openMemoryDb, setup } from "./helpers";

test("オフラインで保存し、同期した端末と新しい端末にも保存と解除が届く", async () => {
  const { server, core } = await setup();
  // 保存を配る前のカーソルを持った端末でも、保存の差分が届く。
  server.savedPagesSupported = false;
  await core.sync();
  server.savedPagesSupported = true;
  const other = await ReaderCore.open({
    db: await openMemoryDb(),
    baseUrl: "https://sendo.test/api/v1",
    fetch: server.fetch,
    now: () => server.now,
  });
  await other.restoreSession();

  const url = "https://x.com/example/status/19876543?view=full#text";
  const page = await core.savePage(url);
  expect(await core.listSavedPages()).toEqual([page]);
  expect(await other.listSavedPages()).toEqual([]);
  expect(await core.countPending()).toBe(1);
  expect(server.requests).not.toContain("PUT /saved");

  server.failNext("network");
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(await core.listSavedPages()).toEqual([page]);
  await core.sync();
  await other.sync();
  expect(await other.listSavedPages()).toEqual([page]);

  await other.unsavePage(page.id);
  expect(await other.listSavedPages()).toEqual([]);
  await other.sync();
  await core.sync();
  expect(await core.listSavedPages()).toEqual([]);
});

test("同じ URL の保存は重複せず、解除して保存し直すと新しい内容になる", async () => {
  const { server, core } = await setup();
  const first = await core.savePage(" https://EXAMPLE.com:443/page#one ", " First ");
  expect(await core.savePage("https://example.com/page#one", "Other")).toEqual(first);
  expect(await core.countPending()).toBe(1);
  await core.unsavePage(first.id);
  server.advance(100);
  const second = await core.savePage("https://example.com/page#one", "Second");
  expect(second).toEqual({ ...first, title: "Second", savedAt: server.now });

  await core.sync();
  expect(await core.countPending()).toBe(0);
  expect(await core.listSavedPages()).toEqual([second]);
  await expect(core.savePage("https://user:password@example.com/article")).rejects.toMatchObject({
    kind: "invalid",
  });
});

test("同期で断られた保存を取り消し、受け付けられた保存は残す", async () => {
  const { server, core } = await setup();
  server.maxSavedPages = 1;
  const keep = await core.savePage("https://example.com/first");
  const rejected = await core.savePage("https://example.com/second");
  expect(await core.listSavedPages()).toHaveLength(2);

  const result = await core.sync();
  expect(result.push.rejected).toMatchObject([
    { op: { id: rejected.id }, error: { code: "saved_limit_reached" } },
  ]);
  expect(await core.countPending()).toBe(0);
  expect(await core.listSavedPages()).toEqual([keep]);
});

test("スターと保存リンクが重なっても、どちらか片方だけ解除できる", async () => {
  const { server, core } = await setup();
  const feed = server.subscribe({ url: "https://example.com/feed" });
  const article = server.deliver(feed.id, { url: "https://EXAMPLE.com:443/article" });
  const page = await core.savePage("https://example.com/article");
  await core.sync();
  expect(await core.listSavedPages(true)).toEqual([page]);
  await core.setStarred(article.id, true);
  expect(await core.listSavedPages(true)).toEqual([]);
  expect(await core.getSavedPageForUrl(article.url ?? "")).toEqual(page);
  await core.unsavePage(page.id);
  expect(await core.listArticles({ state: "starred" })).toMatchObject([{ id: article.id }]);
  expect(await core.listSavedPages()).toEqual([]);
});

test("アカウントが切り替わると、保存リンクと未送信の操作を消す", async () => {
  const { server, core } = await setup();
  await core.savePage("https://example.com/synced");
  await core.sync();
  await core.savePage("https://example.com/pending");
  server.signInAs({ id: "other", email: "other@example.com" });
  await core.sync();

  expect(await core.listSavedPages()).toEqual([]);
  expect(await core.countPending()).toBe(0);
});
