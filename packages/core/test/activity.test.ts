import { expect, test } from "vitest";
import { ReaderCore } from "../src";
import { openMemoryDb, setup } from "./helpers";

test("開封の記録を 50 件ずつ送り、既読の操作では増やさない", async () => {
  const { core, server } = await setup();
  const feed = server.subscribe({ url: "https://example.com/feed" });
  const article = server.deliver(feed.id);
  await core.sync();

  await core.setRead(article.id, true);
  await core.sync();
  expect(server.activityRequests).toEqual([]);

  for (let i = 0; i < 52; i += 1) {
    await core.recordArticleOpen(article.id);
    server.advance(1000);
  }
  expect(await core.countPending()).toBe(2);
  await core.sync();

  expect(server.activityRequests.map((request) => request.length)).toEqual([50, 2]);
  expect(server.articleOpens.size).toBe(52);
  expect(await core.countPending()).toBe(0);
});

test("書き込みの直後に応答を失っても、同じ ID と開封時刻で再送する", async () => {
  const { server } = await setup();
  const feed = server.subscribe({ url: "https://example.com/feed" });
  const article = server.deliver(feed.id);
  let loseReply = true;
  const db = await openMemoryDb();
  const options = {
    db,
    baseUrl: "https://sendo.test/api/v1",
    now: () => server.now,
    fetch: (async (input, init) => {
      const response = await server.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/v1/activity" && loseReply) {
        loseReply = false;
        throw new TypeError("response was lost");
      }
      return response;
    }) satisfies typeof fetch,
  };
  const core = await ReaderCore.open(options);
  await core.restoreSession();
  await core.sync();
  const id = crypto.randomUUID();
  const occurredAt = new Date(server.now).toISOString();
  await core.recordArticleOpen(article.id, id);
  expect(server.activityRequests).toEqual([]);
  server.advance(40_000);

  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(server.articleOpens.size).toBe(1);
  // 起動し直しても、未送信のバッチが DB に残る。
  const reopened = await ReaderCore.open(options);
  expect(await reopened.countPending()).toBe(1);
  await reopened.sync();

  const event = { id, articleId: article.id, occurredAt };
  expect(server.activityRequests).toEqual([[event], [event]]);
  expect(server.articleOpens.size).toBe(1);
  expect(await reopened.countPending()).toBe(0);
});
