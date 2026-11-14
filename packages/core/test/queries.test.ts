import { describe, expect, test } from "vitest";
import { setup } from "./helpers";

async function seeded() {
  const context = await setup();
  const { server, core } = context;
  const tech = server.createFolder("Tech");
  const news = server.createFolder("News");
  const a = server.subscribe({
    url: "https://a.example/feed",
    title: "b-title",
    folderId: tech.id,
  });
  const b = server.subscribe({
    url: "https://b.example/feed",
    title: "A-title",
    folderId: news.id,
  });
  const c = server.subscribe({ url: "https://c.example/feed" });

  const t = server.now;
  const a1 = server.deliver(a.id, { title: "a1", publishedAt: t - 3000 });
  const a2 = server.deliver(a.id, { title: "a2", publishedAt: t - 1000 });
  const b1 = server.deliver(b.id, { title: "b1", publishedAt: t - 2000 });
  const c1 = server.deliver(c.id, { title: "c1", publishedAt: t - 1000, id: "zzz" });
  server.setArticleState(a1.id, { read: true });
  server.setArticleState(b1.id, { starred: true });
  await core.sync();
  return { ...context, folders: { tech, news }, feeds: { a, b, c }, articles: { a1, a2, b1, c1 } };
}

describe("記事の一覧", () => {
  test("新しい順（同じ時刻なら id の大きい順）に並べる", async () => {
    const { core } = await seeded();
    const titles = (await core.listArticles()).map((article) => article.title);
    expect(titles).toEqual(["c1", "a2", "b1", "a1"]);
  });

  test("フィード、フォルダ、未読、スターで絞り込む", async () => {
    const { core, feeds, folders } = await seeded();
    const titles = async (query: Parameters<typeof core.listArticles>[0]) =>
      (await core.listArticles(query)).map((article) => article.title);

    expect(await titles({ feedId: feeds.a.id })).toEqual(["a2", "a1"]);
    expect(await titles({ folderId: folders.news.id })).toEqual(["b1"]);
    expect(await titles({ state: "unread" })).toEqual(["c1", "a2", "b1"]);
    expect(await titles({ state: "starred" })).toEqual(["b1"]);
    expect(await titles({ feedId: feeds.a.id, state: "unread" })).toEqual(["a2"]);
  });

  test("最後に読んだ記事の続きから読める", async () => {
    const { core } = await seeded();
    const first = await core.listArticles({ limit: 2 });
    expect(first.map((article) => article.title)).toEqual(["c1", "a2"]);
    const last = first.at(-1);
    if (last === undefined) throw new Error("unreachable");
    const rest = await core.listArticles({ after: { publishedAt: last.publishedAt, id: last.id } });
    expect(rest.map((article) => article.title)).toEqual(["b1", "a1"]);
  });

  test("数は 1〜200 に収める", async () => {
    const { core } = await seeded();
    expect(await core.listArticles({ limit: 0 })).toHaveLength(1);
    expect(await core.listArticles({ limit: 1000 })).toHaveLength(4);
  });

  test("記事を 1 件読む。ないなら null", async () => {
    const { core, articles } = await seeded();
    expect(await core.getArticle(articles.b1.id)).toMatchObject({ title: "b1", readAt: null });
    expect(await core.getArticle("missing")).toBeNull();
  });
});

describe("フォルダとフィード", () => {
  test("フォルダは名前の順、フィードはタイトル（なければ URL）の順に並べる", async () => {
    const { core } = await seeded();
    expect((await core.listFolders()).map((folder) => folder.name)).toEqual(["News", "Tech"]);
    expect((await core.listFeeds()).map((feed) => feed.title ?? feed.url)).toEqual([
      "A-title",
      "b-title",
      "https://c.example/feed",
    ]);
  });
});

describe("未読の数", () => {
  test("全体、フィードごと、フォルダごとに数える（未読のないものは含まない）", async () => {
    const { core, feeds, folders } = await seeded();
    const counts = await core.countUnread();
    expect(counts.total).toBe(3);
    expect(Object.fromEntries(counts.feeds)).toEqual({
      [feeds.a.id]: 1,
      [feeds.b.id]: 1,
      [feeds.c.id]: 1,
    });
    expect(Object.fromEntries(counts.folders)).toEqual({
      [folders.tech.id]: 1,
      [folders.news.id]: 1,
    });
  });
});

describe("記事をまとめて読む", () => {
  test("渡した ID の記事を返し、見つからない ID は飛ばす", async () => {
    const { core, articles } = await seeded();
    const found = await core.getArticles([articles.a1.id, "missing", articles.c1.id]);
    expect(found.map((article) => article.id).sort()).toEqual(
      [articles.a1.id, articles.c1.id].sort(),
    );
    expect(await core.getArticles([])).toEqual([]);
  });
});
