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

describe("本文を先に取っておく", () => {
  test("未読の新しい記事のうち、本文があって手元にないものだけを、数を絞って取る", async () => {
    const { server, core, feed, db } = await seeded();
    const t = server.now;
    const read = server.deliver(feed.id, { content: "<p>既読</p>", publishedAt: t - 1 });
    server.setArticleState(read.id, { read: true });
    server.deliver(feed.id, { summary: "要約だけ", publishedAt: t - 2 });
    const newest = server.deliver(feed.id, { content: "<p>1</p>", publishedAt: t - 3 });
    const second = server.deliver(feed.id, { content: "<p>2</p>", publishedAt: t - 4 });
    const third = server.deliver(feed.id, { content: "<p>3</p>", publishedAt: t - 5 });
    await core.sync();
    await core.fetchArticleContent(second.id);
    server.contentRequests.length = 0;

    // 未読の新しい 3 件（要約だけ、1、2）のうち、取るのは 1 だけ
    expect(await core.prefetchArticleContents(3)).toBe(1);
    expect(server.contentRequests).toEqual([newest.id]);
    // もう一度呼んでも、取り直さない（取るものがなければ、sendo に何も聞かない）
    const before = server.requests.length;
    expect(await core.prefetchArticleContents(3)).toBe(0);
    expect(server.requests).toHaveLength(before);
    expect(await core.prefetchArticleContents(4)).toBe(1);
    expect(await contentRows(db)).toEqual(
      [newest.id, second.id, third.id].sort().map((id) => ({ article_id: id })),
    );
  });

  test("届かなくなったら、そこでやめる", async () => {
    const { server, core, feed } = await seeded();
    for (let i = 0; i < 3; i++) server.deliver(feed.id, { content: "<p>本文</p>" });
    await core.sync();
    // ユーザーの確認と 1 件めは届き、2 件めが届かない
    server.failNext(null, null, "network");
    await expect(core.prefetchArticleContents(10)).rejects.toMatchObject({ kind: "network" });
    // 届いたのは 1 件め だけ。3 件めは、取りにいかない
    expect(server.contentRequests).toHaveLength(1);
  });
});
