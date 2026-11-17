import { describe, expect, test } from "vitest";
import { compareArticles } from "../src";
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
  test("既読にした日時の新しい順に読み、同時刻の境界をまたいでも漏れや重複がない", async () => {
    const { core, server, articles, feeds } = await seeded();
    server.advance(1000);
    server.setArticleState(articles.a2.id, { read: true });
    server.setArticleState(articles.c1.id, { read: true });
    server.advance(1000);
    server.setArticleState(articles.b1.id, { read: true });
    await core.sync();
    const first = await core.listArticles({ state: "read", order: "recentlyRead", limit: 2 });
    expect(first.map((article) => article.title)).toEqual(["b1", "c1"]);
    const last = first.at(-1);
    if (last === undefined) throw new Error("記事がない");
    const rest = await core.listArticles({ state: "read", order: "recentlyRead", after: last });
    expect(rest.map((article) => article.title)).toEqual(["a2", "a1"]);
    const all = [...first, ...rest];
    for (const order of ["recentlyRead", "newest", "oldest"] as const) {
      expect([...all].sort((a, b) => compareArticles(a, b, order)).map((a) => a.id)).toEqual(
        (await core.listArticles({ state: "read", order })).map((a) => a.id),
      );
    }
    expect(
      (await core.listArticles({ feedId: feeds.a.id, state: "read", order: "recentlyRead" })).map(
        (a) => a.title,
      ),
    ).toEqual(["a2", "a1"]);
    await core.setRead(articles.b1.id, false);
    expect(
      (await core.listArticles({ state: "read", order: "recentlyRead" })).map((a) => a.title),
    ).toEqual(["c1", "a2", "a1"]);
    // 境界の記事を未読に戻しても、読んだときのカーソルから続きを取れる
    await core.setRead(last.id, false);
    expect(
      (await core.listArticles({ order: "recentlyRead", after: last })).map((a) => a.title),
    ).toEqual(["a2", "a1"]);
    await expect(
      core.listArticles({
        order: "recentlyRead",
        after: { id: last.id, publishedAt: last.publishedAt },
      }),
    ).rejects.toThrow("readAt");
  });

  test("既読順は未読を除外し、保存済みでなくても既読を出す", async () => {
    const { core, articles } = await seeded();
    expect((await core.listArticles({ state: "read" })).map((a) => a.id)).toEqual([articles.a1.id]);
    expect((await core.listArticles({ order: "recentlyRead" })).map((a) => a.id)).toEqual([
      articles.a1.id,
    ]);
    expect(await core.listArticles({ state: "unread", order: "recentlyRead" })).toEqual([]);
  });

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

  test("古い順にも並べられ、続きから読める", async () => {
    const { core } = await seeded();
    const first = await core.listArticles({ order: "oldest", limit: 2 });
    expect(first.map((article) => article.title)).toEqual(["a1", "b1"]);
    const last = first.at(-1);
    if (last === undefined) throw new Error("unreachable");
    const rest = await core.listArticles({
      order: "oldest",
      after: { publishedAt: last.publishedAt, id: last.id },
    });
    expect(rest.map((article) => article.title)).toEqual(["a2", "c1"]);
  });

  test("ある時刻からあとに既読にした記事を数える", async () => {
    const { core, server, articles } = await seeded();
    // a1 は、いま（server.now）既読にしてある
    expect(await core.countReadSince(server.now)).toBe(1);
    expect(await core.countReadSince(server.now + 1)).toBe(0);
    await core.setRead(articles.a2.id, true);
    await core.setRead(articles.c1.id, true);
    expect(await core.countReadSince(server.now)).toBe(3);
    await core.setRead(articles.c1.id, false);
    expect(await core.countReadSince(server.now)).toBe(2);
  });

  test("タイトル・要約・著者から、すべての言葉が入っている記事を探す", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://a.example/feed" });
    const t = server.now;
    server.deliver(feed.id, { title: "SQLite を OPFS で使う", publishedAt: t - 1000 });
    server.deliver(feed.id, {
      title: "同期の設計",
      summary: "カーソルと sqlite の話",
      publishedAt: t - 2000,
    });
    server.deliver(feed.id, { title: "100% 完了", author: "山田 太郎", publishedAt: t - 3000 });
    server.deliver(feed.id, { title: "under_score", publishedAt: t - 4000 });
    await core.sync();
    const titles = async (search: string) =>
      (await core.listArticles({ search })).map((article) => article.title);

    // 大文字と小文字は区別しない。要約と著者も探す
    expect(await titles("sqlite")).toEqual(["SQLite を OPFS で使う", "同期の設計"]);
    expect(await titles("山田")).toEqual(["100% 完了"]);
    // 空白（全角も）で区切った言葉は、すべて入っているものだけ
    expect(await titles("sqlite　カーソル")).toEqual(["同期の設計"]);
    expect(await titles("sqlite 山田")).toEqual([]);
    // % と _ は、そのままの文字として探す
    expect(await titles("100%")).toEqual(["100% 完了"]);
    expect(await titles("%")).toEqual(["100% 完了"]);
    expect(await titles("_")).toEqual(["under_score"]);
    // 空なら絞らない。ほかの条件とも組み合わせられる
    expect(await titles("  ")).toHaveLength(4);
    expect(
      (await core.listArticles({ search: "sqlite", order: "oldest" })).map((a) => a.title),
    ).toEqual(["同期の設計", "SQLite を OPFS で使う"]);
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
