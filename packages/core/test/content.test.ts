import { describe, expect, test } from "vitest";
import { ApiError, type Table } from "../src";
import { MAX_CONTENT_LENGTH } from "../src/api/client";
import { setup } from "./helpers";

const contentRows = (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  db.all<{ article_id: string }>("select article_id from article_contents order by article_id");

async function seeded() {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://example.com/feed.xml" });
  return { ...context, feed };
}

describe("記事に本文があるか（hasContent）", () => {
  test("同期で届いたとおりに、手元に置く", async () => {
    const { server, core, feed } = await seeded();
    const full = server.deliver(feed.id, { content: "<p>本文</p>" });
    const summaryOnly = server.deliver(feed.id, { summary: "要約" });
    await core.sync();
    expect((await core.getArticle(full.id))?.hasContent).toBe(true);
    expect((await core.getArticle(summaryOnly.id))?.hasContent).toBe(false);
    expect((await core.listArticles()).map((article) => article.hasContent).sort()).toEqual([
      false,
      true,
    ]);
  });

  test("本文を配る前の版の sendo が相手でも、同期は止まらない（本文なしになる）", async () => {
    const { server, core, feed } = await seeded();
    server.omitHasContent = true;
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    expect((await core.getArticle(article.id))?.hasContent).toBe(false);
    expect(await core.getArticleContent(article.id)).toEqual({ status: "none" });
    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(server.contentRequests).toEqual([]);
  });
});

describe("本文を取る", () => {
  test("手元になければ sendo から取り、木にして返す。2 回目からは、手元から返す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, {
      content: '<p>本文 <a href="https://example.com/a">リンク</a></p>',
    });
    await core.sync();
    expect(await core.getArticleContent(article.id)).toEqual({ status: "missing" });

    const expected = {
      source: "feed",
      nodes: [
        {
          tag: "p",
          children: ["本文 ", { tag: "a", href: "https://example.com/a", children: ["リンク"] }],
        },
      ],
    };
    expect(await core.fetchArticleContent(article.id)).toEqual(expected);
    expect(await core.getArticleContent(article.id)).toEqual({
      status: "ready",
      content: expected,
    });
    expect(await core.fetchArticleContent(article.id)).toEqual(expected);
    expect(server.contentRequests).toEqual([article.id]);
  });

  test("一度取った本文は、届かなくても手元から返す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    await core.fetchArticleContent(article.id);
    server.failNext("network", "network");
    expect(await core.fetchArticleContent(article.id)).toMatchObject({ source: "feed" });
    expect((await core.getArticleContent(article.id)).status).toBe("ready");
  });

  test("届かなければ network で失敗し、手元は missing のまま（つながったら取れる）", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    server.failNext("network");
    await expect(core.fetchArticleContent(article.id)).rejects.toMatchObject({ kind: "network" });
    expect(await core.getArticleContent(article.id)).toEqual({ status: "missing" });
    expect(await core.fetchArticleContent(article.id)).not.toBeNull();
  });

  test("本文のない記事は、取りにいかない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { summary: "要約" });
    await core.sync();
    expect(await core.getArticleContent(article.id)).toEqual({ status: "none" });
    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(await core.fetchArticleContent("no-such-article")).toBeNull();
    expect(server.contentRequests).toEqual([]);
  });

  test("hasContent が true でも sendo に本文がなければ（no_content）、本文なしとして扱い、取り直さない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    server.contentGone.add(article.id);
    const changes: Table[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(changes).toEqual([["articles"]]);
    expect((await core.getArticle(article.id))?.hasContent).toBe(false);
    expect(await core.getArticleContent(article.id)).toEqual({ status: "none" });
    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(server.contentRequests).toEqual([article.id]);
  });

  test("記事が sendo から消えていても（not_found）、本文なしとして扱う", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    server.removeFromInbox(article.id);
    expect(await core.fetchArticleContent(article.id)).toBeNull();
  });

  test("出どころが知らない値でも、本文として返す", async () => {
    const { server, core, feed } = await seeded();
    server.contentSource = "page";
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    expect(await core.fetchArticleContent(article.id)).toEqual({
      source: "page",
      nodes: [{ tag: "p", children: ["本文"] }],
    });
  });

  test("同じ記事を同時に頼んでも、取りにいくのは 1 回", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    const [a, b] = await Promise.all([
      core.fetchArticleContent(article.id),
      core.fetchArticleContent(article.id),
    ]);
    expect(a).toEqual(b);
    expect(server.contentRequests).toEqual([article.id]);
  });

  test("スクリプトしかない本文は、本文なしとして扱う（要約を出す）", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<script>alert(1)</script><p> </p>" });
    await core.sync();
    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(await core.getArticleContent(article.id)).toEqual({ status: "none" });
  });

  test("決まりより大きい本文は、置かない（本文なしとして扱う）", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id, { content: "a".repeat(MAX_CONTENT_LENGTH + 1) });
    await core.sync();
    expect(await core.fetchArticleContent(article.id)).toBeNull();
    expect(await contentRows(db)).toEqual([]);
  });

  test("応答の形が違えば server で失敗し、置かない", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    (server as unknown as { contentSource: unknown }).contentSource = 1;
    await expect(core.fetchArticleContent(article.id)).rejects.toMatchObject({ kind: "server" });
    expect(await contentRows(db)).toEqual([]);
  });

  test("別のユーザーのセッションに替わっていたら、取りにいかず、そのユーザーに切り替える", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    const other = { id: "user-b", email: "b@example.com" };
    server.signInAs(other);

    await expect(core.fetchArticleContent(article.id)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    // 前のユーザーの記事を、別のユーザーのセッションで聞かない（404 を本文なしと取り違えない）
    expect(server.contentRequests).toEqual([]);
    expect(core.currentUser()).toEqual(other);
    expect(await core.listArticles()).toEqual([]);
  });

  test("セッションが切れていたら unauthorized で失敗し、手元は変えない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    server.expireSession();
    await expect(core.fetchArticleContent(article.id)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(await core.getArticleContent(article.id)).toEqual({ status: "missing" });
  });

  test("ログインしていなければ unauthorized", async () => {
    const { core } = await setup({ signIn: false });
    await expect(core.fetchArticleContent("a")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("元ページの全文", () => {
  test("要約だけの記事でも取得し、オフラインでは手元から返す。フィード本文とは混ぜない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { summary: "要約" });
    server.pageContents.set(article.id, "<p>元ページの全文</p>");
    await core.sync();
    expect(await core.getArticleContent(article.id, "page")).toEqual({ status: "missing" });
    const full = await core.fetchArticleContent(article.id, "page");
    expect(full).toEqual({
      source: "page",
      nodes: [{ tag: "p", children: ["元ページの全文"] }],
    });
    expect(await core.getArticleContent(article.id)).toEqual({ status: "none" });
    expect((await core.getArticle(article.id))?.hasContent).toBe(false);
    server.failNext("network");
    expect(await core.fetchArticleContent(article.id, "page")).toEqual(full);
    expect(await core.getArticleContent(article.id, "page")).toEqual({
      status: "ready",
      content: full,
    });
    expect(server.pageContentRequests).toEqual([article.id]);
    expect(server.contentRequests).toEqual([]);
  });

  test("同じ記事の全文は同時に 1 回だけ取得する。フィード本文の取得とは分ける", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>フィード本文</p>" });
    server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    const [a, b, feedContent] = await Promise.all([
      core.fetchArticleContent(article.id, "page"),
      core.fetchArticleContent(article.id, "page"),
      core.fetchArticleContent(article.id),
    ]);
    expect(a).toEqual(b);
    expect(a?.source).toBe("page");
    expect(feedContent?.source).toBe("feed");
    expect((await core.getArticleContent(article.id)).status).toBe("ready");
    expect((await core.getArticleContent(article.id, "page")).status).toBe("ready");
    expect(server.pageContentRequests).toEqual([article.id]);
    expect(server.contentRequests).toEqual([article.id]);
  });

  test("抽出に失敗してもフィード本文を消さず、あとで再取得できる", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>フィード本文</p>" });
    await core.sync();
    const original = await core.fetchArticleContent(article.id);
    expect(await core.fetchArticleContent(article.id, "page")).toBeNull();
    expect((await core.getArticle(article.id))?.hasContent).toBe(true);
    expect(await core.fetchArticleContent(article.id)).toEqual(original);
    server.pageContents.set(article.id, "<p>全文</p>");
    expect((await core.fetchArticleContent(article.id, "page"))?.source).toBe("page");
  });

  test("全文も安全な木にして返す。抽出した HTML を画面に渡さない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id);
    server.pageContents.set(
      article.id,
      '<script>evil()</script><p onclick="evil()">全文<a href="javascript:evil()">リンク</a><img src="https://evil.test/x"></p>',
    );
    await core.sync();
    expect(await core.fetchArticleContent(article.id, "page")).toEqual({
      source: "page",
      nodes: [{ tag: "p", children: ["全文リンク"] }],
    });
  });

  test.each(["削除", "ログアウト"] as const)("%s で保存済みの全文も消える", async (action) => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id);
    server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    await core.fetchArticleContent(article.id, "page");
    expect(await db.all("select article_id from article_page_contents")).toHaveLength(1);
    if (action === "削除") {
      server.removeFromInbox(article.id);
      await core.sync();
    } else {
      await core.signOut();
    }
    expect(await db.all("select article_id from article_page_contents")).toEqual([]);
  });

  test("取得中にログアウトしたら、全文を置かない", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id);
    await core.sync();
    server.failNext("hang");
    const fetching = core.fetchArticleContent(article.id, "page");
    await core.signOut();
    await expect(fetching).rejects.toBeInstanceOf(ApiError);
    expect(await db.all("select article_id from article_page_contents")).toEqual([]);
  });

  test("別のユーザーのセッションでは全文を取らない", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id);
    await core.sync();
    server.signInAs({ id: "other", email: "other@example.com" });
    await expect(core.fetchArticleContent(article.id, "page")).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(server.pageContentRequests).toEqual([]);
    expect(await db.all("select article_id from article_page_contents")).toEqual([]);
  });
});

describe("手元の本文を消す", () => {
  test("受信箱から消えた記録が届いたら、本文も一緒に消す", async () => {
    const { server, core, feed, db } = await seeded();
    const gone = server.deliver(feed.id, { content: "<p>消える</p>" });
    const kept = server.deliver(feed.id, { content: "<p>残る</p>" });
    await core.sync();
    await core.fetchArticleContent(gone.id);
    await core.fetchArticleContent(kept.id);

    server.removeFromInbox(gone.id);
    await core.sync();
    expect(await contentRows(db)).toEqual([{ article_id: kept.id }]);
  });

  test("既読やスターが変わって記事がもう一度届いても、本文は残る", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    await core.fetchArticleContent(article.id);
    server.setArticleState(article.id, { read: true, starred: true });
    await core.sync();
    expect((await core.getArticleContent(article.id)).status).toBe("ready");
    expect(server.contentRequests).toEqual([article.id]);
  });

  test("最初から同期し直すとき（invalid_cursor）は、手元の本文を捨てて、取り直す", async () => {
    const { server, core, feed, db } = await seeded();
    const folder = server.createFolder("Gone");
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    await core.fetchArticleContent(article.id);

    server.deleteFolder(folder.id);
    server.purgeTombstones();
    expect((await core.sync()).pull.reset).toBe(true);
    expect(await contentRows(db)).toEqual([]);
    expect(await core.getArticleContent(article.id)).toEqual({ status: "missing" });
    expect(await core.fetchArticleContent(article.id)).not.toBeNull();
    expect(server.contentRequests).toEqual([article.id, article.id]);
  });

  test("購読をやめて手元から記事を消したら、本文も消す", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    await core.fetchArticleContent(article.id);
    await core.unsubscribe(feed.id);
    expect(await contentRows(db)).toEqual([]);
  });

  test("ログアウトしたら、本文も消す", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    await core.fetchArticleContent(article.id);
    await core.signOut();
    expect(await contentRows(db)).toEqual([]);
  });

  test("取っている間にログアウトしたら、置かない", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    server.failNext("hang");
    const fetching = core.fetchArticleContent(article.id);
    await core.signOut();
    await expect(fetching).rejects.toBeInstanceOf(ApiError);
    expect(await contentRows(db)).toEqual([]);
  });
});

describe("全文を先に取っておく", () => {
  test("未読の新しい記事の全文を、新しい順に数を絞って取る。フィード本文と、既読の記事は取らない", async () => {
    const { server, core, feed } = await seeded();
    const t = server.now;
    const read = server.deliver(feed.id, { content: "<p>既読</p>", publishedAt: t - 1 });
    server.setArticleState(read.id, { read: true });
    const newest = server.deliver(feed.id, { content: "<p>1</p>", publishedAt: t - 2 });
    const summaryOnly = server.deliver(feed.id, { summary: "要約だけ", publishedAt: t - 3 });
    const stored = server.deliver(feed.id, { publishedAt: t - 4 });
    const oldest = server.deliver(feed.id, { publishedAt: t - 5 });
    for (const article of [read, newest, summaryOnly, stored, oldest]) {
      server.pageContents.set(article.id, `<p>全文 ${article.id}</p>`);
    }
    await core.sync();
    await core.fetchArticleContent(stored.id, "page");
    server.pageContentRequests.length = 0;

    // 1 回に取るのは 2 件まで。手元に全文がある記事は数えない
    expect(await core.prefetchArticleContents(2)).toBe(2);
    expect(server.pageContentRequests).toEqual([newest.id, summaryOnly.id]);
    expect(server.contentRequests).toEqual([]);
    // 開くと、通信を待たずに全文が出る
    const requested = server.requests.length;
    expect(await core.getArticleContent(newest.id, "page")).toMatchObject({ status: "ready" });
    expect(server.requests).toHaveLength(requested);
    // 残りは次に取る。既読の記事は取らない
    expect(await core.prefetchArticleContents(2)).toBe(1);
    expect(server.pageContentRequests).toEqual([newest.id, summaryOnly.id, oldest.id]);
    // 取るものがなければ、sendo に何も聞かない
    const before = server.requests.length;
    expect(await core.prefetchArticleContents(2)).toBe(0);
    expect(server.requests).toHaveLength(before);
  });

  test("全文が取れなかった記事は、フィード本文があれば代わりに取り、先読みでは取り直さない", async () => {
    const { server, core, feed } = await seeded();
    const withFeed = server.deliver(feed.id, { content: "<p>フィード本文</p>" });
    const summaryOnly = server.deliver(feed.id, { summary: "要約だけ" });
    await core.sync();

    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.contentRequests).toEqual([withFeed.id]);
    expect(await core.getArticleContent(withFeed.id)).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(summaryOnly.id)).toEqual({ status: "none" });
    expect(server.pageContentRequests.sort()).toEqual([withFeed.id, summaryOnly.id].sort());

    // 次の先読みでは、取れなかった記事を sendo に頼み直さない
    server.pageContents.set(withFeed.id, "<p>全文</p>");
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.pageContentRequests).toHaveLength(2);
    // 開いたときは、これまでどおり取りにいく
    expect((await core.fetchArticleContent(withFeed.id, "page"))?.source).toBe("page");
    expect(server.pageContentRequests).toHaveLength(3);
  });

  test("全文が取れず、代わりのフィード本文が届かなかった記事は、次はフィード本文だけを取りにいく", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>フィード本文</p>" });
    await core.sync();
    // ユーザーの確認と全文は届き（全文はない）、フィード本文が届かない
    server.failNext(null, null, "network");
    await expect(core.prefetchArticleContents(10)).rejects.toMatchObject({ kind: "network" });
    expect(await core.getArticleContent(article.id)).toEqual({ status: "missing" });

    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(await core.getArticleContent(article.id)).toMatchObject({ status: "ready" });
    expect(server.pageContentRequests).toEqual([article.id]);
    // 置けたら、もう取りにいかない
    const before = server.requests.length;
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.requests).toHaveLength(before);
  });

  test("届かなくなったら、そこでやめる", async () => {
    const { server, core, feed } = await seeded();
    for (let i = 0; i < 3; i++) {
      const article = server.deliver(feed.id);
      server.pageContents.set(article.id, "<p>全文</p>");
    }
    await core.sync();
    // ユーザーの確認と 1 件めは届き、2 件めが届かない
    server.failNext(null, null, "network");
    await expect(core.prefetchArticleContents(10)).rejects.toMatchObject({ kind: "network" });
    // 届いたのは 1 件めだけ。3 件めは取りにいかない。届かなかった記事に、取れなかった印は置かない
    expect(server.pageContentRequests).toHaveLength(1);
    expect(await core.prefetchArticleContents(10)).toBe(2);
  });
});

describe("手元に置く本文の量の上限", () => {
  const MB = 1024 * 1024;

  /** 本文の大きさだけを大きく見せる（何十 MB の本文を作らずに、上限を確かめる） */
  async function inflate(
    db: Awaited<ReturnType<typeof setup>>["db"],
    articleId: string,
    bytes: number,
  ) {
    await db.run("update article_content_sizes set bytes = ? where article_id = ?", [
      bytes,
      articleId,
    ]);
  }

  const pageIds = (db: Awaited<ReturnType<typeof setup>>["db"]) =>
    db
      .all<{ article_id: string }>("select article_id from article_page_contents")
      .then((rows) => rows.map((row) => row.article_id).sort());

  test("既定は 200MB。置いた本文の大きさ（UTF-8 のバイト数）を、全文とフィード本文の合計で返す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { content: "<p>あ</p>" });
    server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    expect(await core.getContentStorage()).toEqual({ limit: 200 * MB, used: 0 });
    await core.fetchArticleContent(article.id);
    await core.fetchArticleContent(article.id, "page");
    expect(await core.getContentStorage()).toEqual({
      limit: 200 * MB,
      used: new TextEncoder().encode("<p>あ</p><p>全文</p>").byteLength,
    });
  });

  test("超えたら、既読でスターのない記事の本文から、読んだのが古い順に消す。未読とスターは残す", async () => {
    const { server, core, feed, db } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    const [readFirst, readSecond, starred, unread, opened] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(5);
    for (const id of ids) await inflate(db, id, 15 * MB);
    // 読んだ順：readFirst → starred → readSecond
    await core.setRead(readFirst, true);
    server.now += 1000;
    await core.setRead(starred, true);
    await core.setStarred(starred, true);
    server.now += 1000;
    await core.setRead(readSecond, true);

    // 75MB を 50MB に。既読でスターのない、読んだのが古い記事から 2 件を消す
    expect(await core.setContentStorageLimit(50 * MB)).toEqual({ limit: 50 * MB, used: 45 * MB });
    expect(await pageIds(db)).toEqual([starred, unread, opened].sort());

    // あとから既読にした記事の分は、次に本文を置いたときに消す
    await core.setRead(opened, true);
    const late = server.deliver(feed.id, { publishedAt: server.now - 10 });
    server.pageContents.set(late.id, "<p>全文</p>");
    await core.sync();
    await inflate(db, starred, 40 * MB);
    await core.fetchArticleContent(late.id, "page");
    expect(await pageIds(db)).toEqual([starred, unread, late.id].sort());
  });

  test("未読とスターの本文で上限に届いたら、先読みをやめる", async () => {
    const { server, core, feed, db } = await seeded();
    const first = server.deliver(feed.id, { publishedAt: server.now });
    server.pageContents.set(first.id, "<p>全文</p>");
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(1);
    await inflate(db, first.id, 60 * MB);
    await core.setContentStorageLimit(50 * MB);

    const next = server.deliver(feed.id, { publishedAt: server.now - 1 });
    server.pageContents.set(next.id, "<p>全文</p>");
    await core.sync();
    server.pageContentRequests.length = 0;
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.pageContentRequests).toEqual([]);

    // 開いたときに取った本文は、上限を超えていても置く
    const opened = server.deliver(feed.id, { publishedAt: server.now - 2 });
    server.pageContents.set(opened.id, "<p>全文</p>");
    await core.sync();
    expect((await core.fetchArticleContent(opened.id, "page"))?.source).toBe("page");

    // 上限を上げれば、続きを取る
    await core.setContentStorageLimit(100 * MB);
    await core.prefetchArticleContents(10);
    expect(await pageIds(db)).toEqual([first.id, next.id, opened.id].sort());
  });

  test("Off なら先に取らず、消しもしない。開いたときは取る", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id);
    server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    expect(await core.setContentStorageLimit(0)).toEqual({ limit: 0, used: 0 });
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.pageContentRequests).toEqual([]);
    await core.setRead(article.id, true);
    expect((await core.fetchArticleContent(article.id, "page"))?.source).toBe("page");
    expect(await core.getArticleContent(article.id, "page")).toMatchObject({ status: "ready" });
  });

  test("決めた値のほかは受け付けない。選んだ値はこの端末にだけ置き、ログアウトしても残る", async () => {
    const { server, core } = await seeded();
    await expect(core.setContentStorageLimit(123)).rejects.toBeInstanceOf(RangeError);
    await core.setContentStorageLimit(500 * MB);
    const before = server.requests.length;
    await core.signOut();
    expect(
      server.requests.slice(before).filter((request) => request.includes("/settings")),
    ).toEqual([]);
    expect((await core.getContentStorage()).limit).toBe(500 * MB);
  });
});
