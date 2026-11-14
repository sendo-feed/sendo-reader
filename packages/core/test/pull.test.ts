import { describe, expect, test } from "vitest";
import { ApiError, LOCAL_RETENTION_MS, ReaderCore } from "../src";
import { DAY, openMemoryDb, setup } from "./helpers";

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("最初の同期", () => {
  test("フォルダ、購読、未読・スター・直近 30 日の記事だけを手元に置く", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Tech");
    const feed = server.subscribe({ url: "https://example.com/feed.xml", folderId: folder.id });

    const oldRead = server.deliver(feed.id, { title: "old read" });
    server.setArticleState(oldRead.id, { read: true });
    const oldStarred = server.deliver(feed.id, { title: "old starred" });
    server.setArticleState(oldStarred.id, { read: true, starred: true });
    const oldUnread = server.deliver(feed.id, { title: "old unread" });
    server.advance(31 * DAY);
    const recentRead = server.deliver(feed.id, { title: "recent read" });
    server.setArticleState(recentRead.id, { read: true });

    const result = await core.sync();
    expect(result.pull.reset).toBe(false);
    expect(await core.listFolders()).toEqual([
      { id: folder.id, name: "Tech", createdAt: folder.createdAt },
    ]);
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id, folderId: folder.id }]);
    expect(ids(await core.listArticles())).toEqual(ids([oldStarred, oldUnread, recentRead]));
  });

  test("最初の同期でも、消した印の行は送られず、手元にも残らない", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Gone");
    server.deleteFolder(folder.id);
    await core.sync();
    expect(await core.listFolders()).toEqual([]);
  });

  test("ページに分かれても、すべての行を取り、最初の同期の範囲を守る", async () => {
    const { server, core } = await setup();
    server.pageSize = 3;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const expected = [];
    for (let i = 0; i < 5; i++) {
      const old = server.deliver(feed.id, { title: `old ${i}` });
      server.setArticleState(old.id, { read: true });
    }
    server.advance(31 * DAY);
    for (let i = 0; i < 7; i++) expected.push(server.deliver(feed.id, { title: `new ${i}` }));

    const result = await core.sync();
    expect(result.pull.pages).toBeGreaterThan(1);
    expect(ids(await core.listArticles({ limit: 200 }))).toEqual(ids(expected));
    expect(server.requests.filter((r) => r.startsWith("GET /sync"))).toHaveLength(
      result.pull.pages,
    );
  });
});

describe("差分の同期", () => {
  test("あとから届いた記事と、別の端末での既読・スターの変更を取り込む", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const first = server.deliver(feed.id, { title: "first" });
    await core.sync();

    server.advance(1000);
    const second = server.deliver(feed.id, { title: "second" });
    server.setArticleState(first.id, { read: true, starred: true });
    await core.sync();

    const articles = await core.listArticles();
    expect(articles.map((a) => a.title)).toEqual(["second", "first"]);
    expect(articles[1]).toMatchObject({ readAt: server.now, starredAt: server.now });
    expect(articles[0]).toMatchObject({ id: second.id, readAt: null, starredAt: null });
  });

  test("2 回目からは、前のカーソルを送り、変わった行だけを受け取る", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    server.requests.length = 0;

    await core.sync();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatch(/^GET \/sync\?cursor=/);
    expect(await core.listArticles()).toHaveLength(1);
  });

  test("消したフォルダは手元から消え、入っていたフィードはフォルダなしになる", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Tech");
    const feed = server.subscribe({ url: "https://example.com/feed.xml", folderId: folder.id });
    await core.sync();

    server.deleteFolder(folder.id);
    await core.sync();
    expect(await core.listFolders()).toEqual([]);
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id, folderId: null }]);
  });

  test("購読をやめたフィードは消え、記事はスターを付けたものだけが残る", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/a.xml" });
    const other = server.subscribe({ url: "https://example.com/b.xml" });
    const plain = server.deliver(feed.id);
    const starred = server.deliver(feed.id);
    server.setArticleState(starred.id, { starred: true });
    const otherArticle = server.deliver(other.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(3);

    server.unsubscribe(feed.id);
    await core.sync();
    expect(ids(await core.listFeeds())).toEqual([other.id]);
    expect(ids(await core.listArticles())).toEqual(ids([starred, otherArticle]));
    expect(await core.getArticle(plain.id)).toBeNull();
  });

  test("カーソルが古すぎると言われたら、手元を作り直して最初から同期する", async () => {
    const { server, core } = await setup();
    const keep = server.createFolder("Keep");
    const gone = server.createFolder("Gone");
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    await core.sync();

    server.deleteFolder(gone.id);
    server.purgeTombstones();
    const result = await core.sync();

    expect(result.pull.reset).toBe(true);
    expect(ids(await core.listFolders())).toEqual([keep.id]);
    expect(ids(await core.listArticles())).toEqual([article.id]);
    // 作り直したあとは、ふつうの差分の同期に戻る
    expect((await core.sync()).pull.reset).toBe(false);
  });

  test("ページの途中で届かなくなっても、書き込んだページまでは残り、次はその続きから取る", async () => {
    const { server, core } = await setup();
    server.pageSize = 2;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const articles = [1, 2, 3, 4, 5].map((i) => server.deliver(feed.id, { title: `a${i}` }));

    // 1 ページめ（フィード 1 ＋ 記事 1）は届き、2 ページめで届かなくなる
    server.failNext(null, "network");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(await core.listArticles()).toHaveLength(1);

    await core.sync();
    expect(ids(await core.listArticles())).toEqual(ids(articles));
  });

  test("トークンが取り消されていたら unauthorized で失敗し、手元は変えない", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();

    server.token = "sendo_rotated";
    server.deliver(feed.id);
    const error = await core.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("unauthorized");
    expect(await core.listArticles()).toHaveLength(1);
  });

  test("サーバーの不具合（5xx）は server として失敗する", async () => {
    const { server, core } = await setup();
    server.failNext(503);
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("server");
  });

  test("同時に呼んでも、同期は 1 つだけ走る", async () => {
    const { server, core } = await setup();
    server.subscribe({ url: "https://example.com/feed.xml" });
    const [a, b] = await Promise.all([core.sync(), core.sync()]);
    expect(a).toBe(b);
    expect(server.requests.filter((r) => r.startsWith("GET /sync"))).toHaveLength(1);
  });
});

describe("手元に置く範囲", () => {
  test("受信箱に入って 30 日を過ぎた既読の記事は、スターがなければ手元から消す", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const read = server.deliver(feed.id);
    const starred = server.deliver(feed.id);
    const unread = server.deliver(feed.id);
    server.setArticleState(read.id, { read: true });
    server.setArticleState(starred.id, { read: true, starred: true });
    await core.sync();
    expect(await core.listArticles()).toHaveLength(3);

    server.advance(LOCAL_RETENTION_MS + 1);
    await core.sync();
    expect(ids(await core.listArticles())).toEqual(ids([starred, unread]));
  });
});

describe("変更の通知", () => {
  test("ページを書き込むたびに、変わった表を知らせる", async () => {
    const { server, core } = await setup();
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));

    await core.sync();
    expect(changes).toEqual([]);

    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(changes).toEqual([["articles", "feeds"]]);
  });

  test("やめたら知らせない。知らせる先が投げても、ほかには届く", async () => {
    const { server, core } = await setup();
    const received: number[] = [];
    const stop = core.onChange(() => received.push(1));
    core.onChange(() => {
      throw new Error("listener failed");
    });
    core.onChange(() => received.push(2));
    stop();

    server.subscribe({ url: "https://example.com/feed.xml" });
    await core.sync();
    expect(received).toEqual([2]);
  });
});

describe("フォルダの削除の通知と、応答の形", () => {
  test("フォルダを消した印だけのページでも、入っていたフィードが変わったことを知らせる", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Tech");
    server.subscribe({ url: "https://example.com/feed.xml", folderId: folder.id });
    await core.sync();

    // sendo はフィードの行より先に、フォルダを消した印を返すことがある（別のページ）
    server.pageSize = 1;
    server.deleteFolder(folder.id);
    server.failNext(null, "network");
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));
    await core.sync().catch(() => undefined);

    expect(changes[0]).toEqual(["feeds", "folders"]);
    expect(await core.listFeeds()).toMatchObject([{ folderId: null }]);
  });

  test("応答の形が違えば server として失敗し、手元は変えない", async () => {
    const { core } = await setup({ signIn: false });
    const bad = await setupWithResponse({ cursor: "c", hasMore: false, folders: [{ id: 1 }] });
    const error = await bad.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("server");
    expect((error as ApiError).message).toContain("folders[0].id");
    expect(await bad.listFolders()).toEqual([]);
    expect(core.isSignedIn()).toBe(false);
  });
});

/** /sync が決まった本文を返す sendo につないだ ReaderCore */
async function setupWithResponse(body: unknown) {
  const db = await openMemoryDb();
  const core = await ReaderCore.open({
    db,
    baseUrl: "https://sendo.test/api/v1",
    fetch: async (input) => {
      const url = new URL((input as Request).url);
      return new Response(JSON.stringify(url.pathname.endsWith("/sync") ? body : { items: [] }));
    },
  });
  await core.signIn("sendo_x");
  return core;
}
