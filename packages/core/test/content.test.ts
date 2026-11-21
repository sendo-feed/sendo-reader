import { describe, expect, test } from "vitest";
import { ApiError, type Table } from "../src";
import { MAX_CONTENT_LENGTH } from "../src/api/client";
import { EVICTABLE_CONTENTS_SQL } from "../src/db/content";
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

  test("選んでから順番が来るまでに開いて取った記事は、取り直さずに続ける", async () => {
    const { server, core, feed } = await seeded();
    const first = server.deliver(feed.id, { publishedAt: server.now });
    const second = server.deliver(feed.id, { publishedAt: server.now - 1 });
    for (const article of [first, second]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    // 1 件めを取っている間に、2 件めを開いて取る
    server.onRequest = async (path) => {
      if (path.includes(`/articles/${first.id}/content`)) {
        server.onRequest = null;
        await core.fetchArticleContent(second.id, "page");
      }
    };
    // 置けたのは 1 件め（2 件めは開いたときに置いたので、数えない）
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.pageContentRequests).toEqual([second.id, first.id]);
    expect(await core.getArticleContent(second.id, "page")).toMatchObject({ status: "ready" });
  });

  test("1 件の記事で sendo が失敗しても、その記事を飛ばして続ける。続けて失敗したらやめる", async () => {
    const { server, core, feed } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    await core.sync();
    // ユーザーの確認は通り、1 件めの全文が 500 を返す
    server.failNext(null, 500);
    expect(await core.prefetchArticleContents(2)).toBe(1);
    expect(await core.getArticleContent(ids[1] as string, "page")).toMatchObject({
      status: "ready",
    });
    // 飛ばした記事は、次にまた頼む。3 件続けて失敗したら、その回はやめる
    server.failNext(null, 500, 503, 500);
    server.pageContentRequests.length = 0;
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.pageContentRequests).toEqual([]);
    expect(await core.prefetchArticleContents(10)).toBe(5);
  });

  test("同じ記事で sendo が 3 回失敗したら、しばらく頼まず、古い記事の先読みを止めない。時間がたてば頼み直す", async () => {
    const { server, core, feed } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    await core.sync();
    const oldest = ids[3] as string;
    // 新しい 3 件が、同期のたびに 500 を返す（3 件続けて失敗するので、その回はやめる）
    for (let round = 0; round < 3; round++) {
      server.failNext(null, 500, 500, 500);
      expect(await core.prefetchArticleContents(10)).toBe(0);
    }
    expect(server.pageContentRequests).toEqual([]);
    // 3 回失敗した記事は頼まず、古い記事を取る
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.pageContentRequests).toEqual([oldest]);
    // sendo が直っても、しばらくは頼まない。6 時間たてば頼み直す
    expect(await core.prefetchArticleContents(10)).toBe(0);
    server.now += 6 * 60 * 60 * 1000;
    expect(await core.prefetchArticleContents(10)).toBe(3);
    expect(server.pageContentRequests).toEqual([oldest, ...ids.slice(0, 3)]);
  });

  test("先読みが終わる間際に頼まれても、件数が残っていれば、取りこぼさずに同じ回の続きを回す", async () => {
    // 2 件まで取る先読みを走らせ、始まりから delay マイクロタスク後に、既読だった later を未読に
    // 戻して、また頼む（画面では、同期のあとに頼む）。どの間合いでも later を取る
    async function run(delay: number | null) {
      const { server, core, feed } = await seeded();
      const first = server.deliver(feed.id, { publishedAt: server.now });
      const later = server.deliver(feed.id, { publishedAt: server.now - 1 });
      for (const article of [first, later]) server.pageContents.set(article.id, "<p>全文</p>");
      await core.sync();
      await core.setRead(later.id, true);
      let done = false;
      const running = core.prefetchArticleContents(2).finally(() => {
        done = true;
      });
      let ticks = 0;
      const requested: Promise<unknown>[] = [];
      while (!done) {
        if (ticks === delay) {
          requested.push(core.setRead(later.id, false));
          requested.push(core.prefetchArticleContents(2));
        }
        ticks += 1;
        await Promise.resolve();
      }
      await running;
      await Promise.all(requested);
      return { core, later, ticks };
    }
    // 先読みが終わるまでのマイクロタスクの数を測り、終わる間際をすべて確かめる
    const { ticks } = await run(null);
    for (let delay = Math.max(0, ticks - 40); delay < ticks; delay++) {
      const { core, later } = await run(delay);
      // 回し直した先読みが終わるのを待つ
      await expect
        .poll(() => core.getArticleContent(later.id, "page"), { timeout: 1000 })
        .toMatchObject({ status: "ready" });
    }
  });

  test("全文が取れなかった記事も、開いて全文が取れたら印を消し、未読に戻せば先読みで取り直す", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id);
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(0);
    const misses = () => db.all("select article_id from article_page_misses");
    expect(await misses()).toEqual([{ article_id: article.id }]);

    // あとで全文が抜けるようになり、開いて取る
    server.pageContents.set(article.id, "<p>全文</p>");
    await core.setRead(article.id, true);
    await core.recordArticleOpen(article.id);
    expect((await core.fetchArticleContent(article.id, "page"))?.source).toBe("page");
    expect(await misses()).toEqual([]);

    // 全文を手元から消して未読に戻すと、先読みは全文を頼む
    await db.run("delete from article_page_contents where article_id = ?", [article.id]);
    await core.setRead(article.id, false);
    server.pageContentRequests.length = 0;
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.pageContentRequests).toEqual([article.id]);
  });

  test("先読みの途中で同期して届いた記事も、走っている先読みが終わったあとに取る", async () => {
    const { server, core, feed } = await seeded();
    const first = server.deliver(feed.id, { publishedAt: server.now - 10 });
    server.pageContents.set(first.id, "<p>全文</p>");
    await core.sync();
    const later = server.deliver(feed.id, { publishedAt: server.now });
    server.pageContents.set(later.id, "<p>全文</p>");
    // 1 件めを取っている間に同期し、同期のあとの先読みを頼む（画面では同期のたびに頼む）
    let second: Promise<number> | undefined;
    server.onRequest = async (path) => {
      if (path.includes(`/articles/${first.id}/content`)) {
        server.onRequest = null;
        await core.sync();
        second = core.prefetchArticleContents(10);
      }
    };
    const fetched = await core.prefetchArticleContents(10);
    expect(fetched).toBe(2);
    expect(await second).toBe(2);
    expect(server.pageContentRequests).toEqual([first.id, later.id]);
  });

  test("リンクのない記事には全文を頼まず、フィード本文があればそれを取る", async () => {
    const { server, core, feed } = await seeded();
    const noLink = server.deliver(feed.id, { url: null, publishedAt: server.now });
    const noLinkWithFeed = server.deliver(feed.id, {
      url: null,
      content: "<p>フィード本文</p>",
      publishedAt: server.now - 1,
    });
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.pageContentRequests).toEqual([]);
    expect(server.contentRequests).toEqual([noLinkWithFeed.id]);
    expect(await core.getArticleContent(noLink.id)).toEqual({ status: "none" });
  });

  test("先読みの途中にこの端末で既読にした記事は、取りにいかない", async () => {
    const { server, core, feed } = await seeded();
    const first = server.deliver(feed.id, { publishedAt: server.now });
    const read = server.deliver(feed.id, { publishedAt: server.now - 1 });
    const last = server.deliver(feed.id, { publishedAt: server.now - 2 });
    for (const article of [first, read, last]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    // 1 件めを取っている間に、2 件めを読む
    server.onRequest = async (path) => {
      if (path.includes(`/articles/${first.id}/content`)) {
        server.onRequest = null;
        await core.setRead(read.id, true);
      }
    };
    expect(await core.prefetchArticleContents(10)).toBe(2);
    expect(server.pageContentRequests).toEqual([first.id, last.id]);
  });

  test("先読みの途中に、ほかの端末で既読にした記事が同期で届いたら、取りにいかない", async () => {
    // 本番と同じく、同期のたびに先読みを頼む
    const context = await setup({ prefetchContents: 10 });
    const { server, core } = context;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const first = server.deliver(feed.id, { publishedAt: server.now });
    const read = server.deliver(feed.id, { publishedAt: server.now - 1 });
    for (const article of [first, read]) server.pageContents.set(article.id, "<p>全文</p>");
    let running: Promise<number> | undefined;
    server.onRequest = async (path) => {
      if (path.includes(`/articles/${first.id}/content`)) {
        server.onRequest = null;
        running = core.prefetchArticleContents(10);
        server.setArticleState(read.id, { read: true });
        await core.sync();
      }
    };
    // 同期のあとに、先読みが始まる
    await core.sync();
    await expect.poll(() => running).toBeDefined();
    await running;
    expect(server.pageContentRequests).toEqual([first.id]);
  });

  test("先読みの途中に届いた記事も同じ回で取り、途中の同期があっても頼むのは決めた件数まで", async () => {
    // 本番と同じく、同期のたびに先読みを頼む（途中の同期のあとの頼みは、同じ回に合流する）
    const context = await setup({ prefetchContents: 2 });
    const { server, core } = context;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const first = server.deliver(feed.id, { publishedAt: server.now - 10 });
    const older = server.deliver(feed.id, { publishedAt: server.now - 20 });
    const oldest = server.deliver(feed.id, { publishedAt: server.now - 30 });
    for (const article of [first, older, oldest]) {
      server.pageContents.set(article.id, "<p>全文</p>");
    }
    let arrived: { id: string } | undefined;
    let running: Promise<number> | undefined;
    server.onRequest = async (path) => {
      if (path.includes(`/articles/${first.id}/content`)) {
        server.onRequest = null;
        running = core.prefetchArticleContents(2);
        arrived = server.deliver(feed.id, { publishedAt: server.now });
        server.pageContents.set(arrived.id, "<p>全文</p>");
        await core.sync();
      }
    };
    await core.sync();
    await expect.poll(() => running).toBeDefined();
    await running;
    // 届いた記事（いちばん新しい）を、残っていた older より先に取り、2 件で止まる
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.pageContentRequests).toEqual([first.id, arrived?.id]);
  });

  test("先読みの途中の同期のあとに回し直しても、失敗した記事を頼み直さない", async () => {
    const context = await setup({ prefetchContents: 10 });
    const { server, core } = context;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const failing = server.deliver(feed.id, { publishedAt: server.now });
    const ok = server.deliver(feed.id, { publishedAt: server.now - 1 });
    for (const article of [failing, ok]) server.pageContents.set(article.id, "<p>全文</p>");
    let running: Promise<number> | undefined;
    server.onRequest = async (path) => {
      // failing の全文は 500 を返す（何度頼まれても）
      if (path.includes(`/articles/${failing.id}/content`)) server.failNext(500);
      if (path.includes(`/articles/${ok.id}/content`) && running === undefined) {
        // ok を取っている間に同期し、同期のあとの頼みが同じ回に合流する
        running = core.prefetchArticleContents(10);
        await core.sync();
      }
    };
    await core.sync();
    await expect.poll(() => running).toBeDefined();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asked = server.requests.filter((request) =>
      request.includes(`/articles/${failing.id}/content`),
    );
    expect(asked).toHaveLength(1);
    expect(server.pageContentRequests).toEqual([ok.id]);
  });

  test("先読みで sendo が失敗した記事は、同じ回では頼み直さない", async () => {
    const { server, core, feed } = await seeded();
    const failing = server.deliver(feed.id, { publishedAt: server.now });
    const ok = server.deliver(feed.id, { publishedAt: server.now - 1 });
    for (const article of [failing, ok]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    // ユーザーの確認は通り、failing の全文が 500 を返す
    server.failNext(null, 500);
    expect(await core.prefetchArticleContents(10)).toBe(1);
    const asked = server.requests.filter((request) =>
      request.includes(`/articles/${failing.id}/content`),
    );
    expect(asked).toHaveLength(1);
    expect(server.pageContentRequests).toEqual([ok.id]);
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

  test("超えたら、既読でスターのない記事の本文から、読んだのが古い順に消す。未読・スター・最後に開いた記事は残す", async () => {
    const { server, core, feed, db } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    const [readFirst, readSecond, starred, unread, latest, opened] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(6);
    for (const id of ids) await inflate(db, id, 15 * MB);
    // 読んだ順：readFirst → starred → readSecond → latest
    for (const id of [readFirst, starred, readSecond, latest]) {
      server.now += 1000;
      await core.setRead(id, true);
    }
    await core.setStarred(starred, true);
    await core.recordArticleOpen(latest);

    // 90MB を 50MB に。既読でスターのない、読んだのが古い記事から消す。最後に開いた latest は
    // 消さないので、収まらずに超えたまま
    expect(await core.setContentStorageLimit(50 * MB)).toEqual({ limit: 50 * MB, used: 60 * MB });
    expect(await pageIds(db)).toEqual([starred, unread, latest, opened].sort());

    // 別の記事を開くと、latest は最後に開いた記事でなくなり、消せる
    server.now += 1000;
    await core.setRead(opened, true);
    await core.recordArticleOpen(opened);
    expect(await core.setContentStorageLimit(50 * MB)).toEqual({ limit: 50 * MB, used: 45 * MB });
    expect(await pageIds(db)).toEqual([starred, unread, opened].sort());
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

    // 開いたときに取った本文は、上限を超えていても置く（画面と同じく、既読にし、開封の記録を積んでから取る）
    const opened = server.deliver(feed.id, { publishedAt: server.now - 2 });
    server.pageContents.set(opened.id, "<p>全文</p>");
    await core.sync();
    await core.setRead(opened.id, true);
    await core.recordArticleOpen(opened.id);
    expect((await core.fetchArticleContent(opened.id, "page"))?.source).toBe("page");
    // 先に取るための空き作りでも、最後に開いた記事（いま開いている記事）の本文は消さない
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(await core.getArticleContent(opened.id, "page")).toMatchObject({ status: "ready" });

    // 上限を上げれば、続きを取る
    await core.setContentStorageLimit(100 * MB);
    await core.prefetchArticleContents(10);
    expect(await pageIds(db)).toEqual([first.id, next.id, opened.id].sort());
  });

  test("未読で上限が埋まっていても、開いて取った本文は残し、前に開いた記事の分から消す", async () => {
    const { server, core, feed, db } = await seeded();
    const unread = server.deliver(feed.id, { publishedAt: server.now });
    server.pageContents.set(unread.id, "<p>未読の全文</p>");
    const first = server.deliver(feed.id, { content: "<p>1</p>", publishedAt: server.now - 1 });
    const second = server.deliver(feed.id, { content: "<p>2</p>", publishedAt: server.now - 2 });
    for (const article of [first, second]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    await core.setContentStorageLimit(50 * MB);
    await core.fetchArticleContent(unread.id, "page");
    await inflate(db, unread.id, 50 * MB);

    // 画面と同じ順：既読にし、開封の記録を積んでから、フィード本文と全文を取る
    const open = async (id: string) => {
      server.now += 1000;
      await core.setRead(id, true);
      await core.recordArticleOpen(id);
      await core.fetchArticleContent(id);
      await core.fetchArticleContent(id, "page");
    };
    await open(first.id);
    expect(await core.getArticleContent(first.id)).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(first.id, "page")).toMatchObject({ status: "ready" });

    // 次に開いた記事の本文は残り、前に開いた記事（読んだのが古い）の分から消える
    await open(second.id);
    expect(await core.getArticleContent(second.id)).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(second.id, "page")).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(first.id)).toEqual({ status: "missing" });
    expect(await core.getArticleContent(first.id, "page")).toEqual({ status: "missing" });
    expect(await pageIds(db)).toEqual([unread.id, second.id].sort());
  });

  test("上限ちょうどまで置いてあっても、既読の分を消して先読みを続ける", async () => {
    const { server, core, feed, db } = await seeded();
    const older = server.deliver(feed.id, { publishedAt: server.now });
    const latest = server.deliver(feed.id, { publishedAt: server.now - 1 });
    for (const article of [older, latest]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(2);
    await core.setRead(older.id, true);
    server.now += 1000;
    await core.setRead(latest.id, true);
    await inflate(db, older.id, 10 * MB);
    await inflate(db, latest.id, 40 * MB);
    await core.setContentStorageLimit(50 * MB);
    expect((await core.getContentStorage()).used).toBe(50 * MB);

    const next = server.deliver(feed.id, { publishedAt: server.now - 2 });
    server.pageContents.set(next.id, "<p>全文</p>");
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(await pageIds(db)).toEqual([latest.id, next.id].sort());
  });

  test("記事を開いたあとの先読みは、開いた記事の本文を消さず、ほかの既読の分を古い順に消して続ける", async () => {
    const { server, core, feed, db } = await seeded();
    const unread = server.deliver(feed.id, { publishedAt: server.now });
    const older = server.deliver(feed.id, { publishedAt: server.now - 1 });
    const opened = server.deliver(feed.id, { publishedAt: server.now - 2 });
    for (const article of [unread, older, opened]) {
      server.pageContents.set(article.id, "<p>全文</p>");
    }
    await core.sync();
    await core.setContentStorageLimit(50 * MB);
    await core.fetchArticleContent(unread.id, "page");
    await core.fetchArticleContent(older.id, "page");
    await core.setRead(older.id, true);
    await inflate(db, unread.id, 40 * MB);
    await inflate(db, older.id, 10 * MB);

    // 画面と同じ順：既読にし、開封の記録を積んでから取る
    server.now += 1000;
    await core.setRead(opened.id, true);
    await core.recordArticleOpen(opened.id);
    await core.fetchArticleContent(opened.id, "page");
    await inflate(db, opened.id, 5 * MB);

    // 開いたあとの同期で届いた記事を先に取る。older を消して空け、opened は残す
    const next = server.deliver(feed.id, { publishedAt: server.now - 3 });
    server.pageContents.set(next.id, "<p>全文</p>");
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(await pageIds(db)).toEqual([unread.id, opened.id, next.id].sort());

    // ほかの既読を消しても空かないときは、開いた記事の本文を消さずに、先に取るのをやめる
    await inflate(db, next.id, 6 * MB);
    const more = server.deliver(feed.id, { publishedAt: server.now - 4 });
    server.pageContents.set(more.id, "<p>全文</p>");
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(await pageIds(db)).toEqual([unread.id, opened.id, next.id].sort());
  });

  test("A を開いて全文を待つ間に B を開き、あとで A の全文が届いても、B の本文は消えない", async () => {
    const { server, core, feed, db } = await seeded();
    const unread = server.deliver(feed.id, { publishedAt: server.now });
    const a = server.deliver(feed.id, { content: "<p>A</p>", publishedAt: server.now - 1 });
    const b = server.deliver(feed.id, { content: "<p>B</p>", publishedAt: server.now - 2 });
    for (const article of [unread, a, b]) server.pageContents.set(article.id, "<p>全文</p>");
    await core.sync();
    await core.setContentStorageLimit(50 * MB);
    await core.fetchArticleContent(unread.id, "page");
    await inflate(db, unread.id, 50 * MB);

    // A を開いてフィード本文を取る（全文はまだ届かない）
    server.now += 1000;
    await core.setRead(a.id, true);
    await core.recordArticleOpen(a.id);
    await core.fetchArticleContent(a.id);
    // B を開いて、フィード本文を取る
    server.now += 1000;
    await core.setRead(b.id, true);
    await core.recordArticleOpen(b.id);
    await core.fetchArticleContent(b.id);
    // 遅れて A の全文が届く
    await core.fetchArticleContent(a.id, "page");
    expect(await core.getArticleContent(b.id)).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(a.id, "page")).toMatchObject({ status: "ready" });
  });

  test("既読の記事を開き直したときも、開いたまますべて既読にしたときも、開いている記事の本文は消えない", async () => {
    const { server, core, feed, db } = await seeded();
    const unread = server.deliver(feed.id, { publishedAt: server.now });
    const reopened = server.deliver(feed.id, { publishedAt: server.now - 1 });
    const other = server.deliver(feed.id, { publishedAt: server.now - 2 });
    for (const article of [unread, reopened, other]) {
      server.pageContents.set(article.id, "<p>全文</p>");
    }
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(3);
    await core.setContentStorageLimit(50 * MB);
    await inflate(db, unread.id, 40 * MB);
    await inflate(db, reopened.id, 5 * MB);
    await inflate(db, other.id, 5 * MB);
    // reopened を先に、other をあとに読んでおく
    await core.setRead(reopened.id, true);
    server.now += 1000;
    await core.setRead(other.id, true);

    // Recently Read から reopened を開き直す（既読の時刻は変わらない）
    server.now += 1000;
    await core.setRead(reopened.id, true);
    await core.recordArticleOpen(reopened.id);
    const next = server.deliver(feed.id, { publishedAt: server.now - 3 });
    server.pageContents.set(next.id, "<p>全文</p>");
    await core.sync();
    // 空き作りは、読んだのが古い reopened ではなく、other を消す
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(await pageIds(db)).toEqual([unread.id, reopened.id, next.id].sort());

    // 開いたまま、すべて既読にする。最後に読んだ記事はほかに移るが、開いている reopened は残る
    server.now += 1000;
    await core.markAllRead({ all: true });
    await inflate(db, next.id, 10 * MB);
    expect((await core.setContentStorageLimit(50 * MB)).used).toBeLessThanOrEqual(50 * MB);
    expect(await pageIds(db)).toContain(reopened.id);
  });

  test("既読の時刻がほかの記事と同じでも、開いている記事の本文は消えない", async () => {
    const { server, core, feed, db } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    await core.sync();
    expect(await core.prefetchArticleContents(10)).toBe(3);
    for (const id of ids) await inflate(db, id, 20 * MB);
    // 3 件を同じ時刻に既読にし、消す順で先頭に来る（ID が一番小さい）記事を開く
    await core.setReadMany(ids, true);
    const first = [...ids].sort()[0] as string;
    await core.recordArticleOpen(first);
    expect((await core.setContentStorageLimit(50 * MB)).used).toBe(40 * MB);
    expect(await pageIds(db)).toContain(first);
  });

  test("最後に開いた記事は手元だけに覚え、ログアウトで消える", async () => {
    const { server, core, feed, db } = await seeded();
    const article = server.deliver(feed.id);
    await core.sync();
    await core.recordArticleOpen(article.id);
    const opened = () => db.all("select value from settings where key = 'content.lastOpened'");
    expect(await opened()).toEqual([{ value: article.id }]);
    await core.signOut();
    expect(await opened()).toEqual([]);
  });

  test("消す本文は、既読の索引の順に読み、並べ替えない", async () => {
    const { db } = await seeded();
    const plan = await db.all<{ detail: string }>(`explain query plan ${EVICTABLE_CONTENTS_SQL}`, [
      -1,
      "",
      "[]",
      64,
    ]);
    expect(plan.some((row) => row.detail.includes("articles_read_idx"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  });

  test("上限を大きく下げると、何回かに分けて、上限以下になるまで読んだのが古い順に消す", async () => {
    const { server, core, feed, db } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    await core.sync();
    await core.setContentStorageLimit(1024 * MB);
    expect(await core.prefetchArticleContents(200)).toBe(150);
    for (const id of ids) await inflate(db, id, 1 * MB);
    // 読んだ順に 1 件ずつ既読にし、途中の 1 件にスターを付け、最後に読んだ 1 件を開く
    for (const id of ids) {
      server.now += 1000;
      await core.setRead(id, true);
    }
    const starred = ids[10] as string;
    await core.setStarred(starred, true);
    const opened = ids[149] as string;
    await core.recordArticleOpen(opened);

    // 150MB を 50MB に。読んだのが古い順に、スターと開いた記事をよけて 100 件消す
    expect((await core.setContentStorageLimit(50 * MB)).used).toBe(50 * MB);
    const kept = await pageIds(db);
    expect(kept).toHaveLength(50);
    expect(kept).toContain(starred);
    expect(kept).toContain(opened);
    const expected = [starred, ...ids.filter((id) => id !== starred).slice(-49)];
    expect(kept).toEqual([...expected].sort());
  });

  test("まとめて既読にして同じ既読の時刻が並んでも、選ぶまとまりの境目をまたいで、古い順に消す", async () => {
    const { server, core, feed, db } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const article = server.deliver(feed.id, { publishedAt: server.now - i });
      server.pageContents.set(article.id, "<p>全文</p>");
      ids.push(article.id);
    }
    await core.sync();
    await core.setContentStorageLimit(1024 * MB);
    expect(await core.prefetchArticleContents(200)).toBe(150);
    for (const id of ids) await inflate(db, id, 1 * MB);
    // 先に 1 件だけ読み、残りの 149 件をまとめて既読にする（同じ既読の時刻が 64 件を超えて並ぶ）
    const first = ids[0] as string;
    await core.setRead(first, true);
    server.now += 1000;
    await core.markAllRead({ all: true });
    const opened = ids[149] as string;
    await core.recordArticleOpen(opened);

    // 150MB を 50MB に。先に読んだ 1 件と、同じ時刻の中から ID の順に 99 件を消す
    expect((await core.setContentStorageLimit(50 * MB)).used).toBe(50 * MB);
    const kept = await pageIds(db);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain(first);
    expect(kept).toContain(opened);
    const sameTime = ids.filter((id) => id !== first && id !== opened).sort();
    expect(kept).toEqual([...sameTime.slice(99), opened].sort());
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
    // 同期を終えても、sendo には預けない
    await core.sync();
    expect(server.settingsRequests).toEqual([]);
    expect([...server.settings.keys()]).toEqual([]);
    const before = server.requests.length;
    await core.signOut();
    expect(
      server.requests.slice(before).filter((request) => request.includes("/settings")),
    ).toEqual([]);
    expect((await core.getContentStorage()).limit).toBe(500 * MB);
  });
});
