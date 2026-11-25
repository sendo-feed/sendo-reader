import { expect, test } from "vitest";
import { setup } from "./helpers";

test("Saved はワークスペースを絞った後で同じ URL をまとめ、代表のスターを外すと次の記事を返す", async () => {
  const { core, server } = await setup();
  server.workspacesSupported = true;
  const chosen = server.createWorkspace("Public");
  const other = server.createWorkspace("Personal");
  const publicFeed = server.subscribe({
    url: "https://public.example/feed",
    workspaceId: chosen.id,
  });
  const personal = server.subscribe({ url: "https://private.example/feed", workspaceId: other.id });
  const url = "https://example.com/one";
  const older = server.deliver(publicFeed.id, { url, publishedAt: 1 });
  const latest = server.deliver(publicFeed.id, { url, publishedAt: 2 });
  const hidden = server.deliver(personal.id, { url, publishedAt: 3 });
  for (const article of [older, latest, hidden])
    server.setArticleState(article.id, { starred: true });
  await core.sync();
  const query = { state: "starred", workspaceIds: [chosen.id] } as const;
  expect((await core.listArticles(query)).map((article) => article.id)).toEqual([latest.id]);
  await core.setStarred(latest.id, false);
  expect((await core.listArticles(query)).map((article) => article.id)).toEqual([older.id]);
  expect(await core.getArticle(hidden.id, [chosen.id])).toBeNull();
});

test("旧サーバーの空の差分を挟んでも、既知の購読の所属は使える", async () => {
  const { core, server } = await setup();
  server.workspacesSupported = true;
  const chosen = server.createWorkspace("Public");
  const feed = server.subscribe({ url: "https://public.example/feed", workspaceId: chosen.id });
  const article = server.deliver(feed.id);
  await core.sync();
  server.workspacesSupported = false;
  await core.sync();
  expect(await core.workspacesAvailable()).toBe(false);
  expect(await core.getArticle(article.id, [chosen.id])).not.toBeNull();
  expect(await core.listArticles({ workspaceIds: [] })).toEqual([]);
});
