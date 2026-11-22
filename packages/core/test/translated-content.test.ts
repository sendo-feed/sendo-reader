import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../src";
import { setup } from "./helpers";

/*
 * 訳した本文を取って、手元に置く（docs/decisions/translation.md の 8）
 */

const T1 = Date.parse("2026-11-22T05:00:00.000Z");
const T2 = Date.parse("2026-11-22T06:00:00.000Z");

const translated = (at: number) => ({
  language: "en",
  status: "translated",
  title: "訳したタイトル",
  summary: "訳した要約",
  translatedAt: new Date(at).toISOString(),
});

const MB = 1024 * 1024;

async function seeded(at = T1) {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://example.com/feed.xml" });
  const article = context.server.deliver(feed.id, {
    title: "Original",
    content: "<p>Original body</p>",
    translation: translated(at),
  });
  await context.core.sync();
  return { ...context, feed, article };
}

const translationRows = (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  db.all<{ article_id: string; html: string | null; translated_at: number }>(
    "select article_id, html, translated_at from article_translation_contents order by article_id",
  );

describe("訳した本文を取る", () => {
  test("手元になければ sendo から取り、木にして返す。2 回目からは、手元から返す", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳した<strong>本文</strong></p>");
    expect(await core.getTranslatedContent(article.id, T1)).toEqual({ status: "missing" });

    const fetched = await core.fetchTranslatedContent(article.id, T1);
    expect(fetched).toEqual({
      status: "ready",
      content: {
        nodes: [{ tag: "p", children: ["訳した", { tag: "strong", children: ["本文"] }] }],
        source: "page",
      },
    });
    expect(server.translationContentRequests).toEqual([article.id]);

    // 手元から返す（取りにいかない）。届かなくても読める
    server.failNext("network");
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual(fetched);
    expect(await core.getTranslatedContent(article.id, T1)).toEqual(fetched);
    expect(server.translationContentRequests).toEqual([article.id]);
  });

  test("訳の中のタグの文字列は、文字のまま返す。スクリプトは通さない", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(
      article.id,
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><script>alert(2)</script>",
    );
    const fetched = await core.fetchTranslatedContent(article.id, T1);
    expect(fetched).toEqual({
      status: "ready",
      content: {
        nodes: [{ tag: "p", children: ["<script>alert(1)</script>"] }],
        source: "page",
      },
    });
  });

  test("本文を訳さなかった応答は none にし、印を置いて取り直さない", async () => {
    const { server, core, db, article } = await seeded();
    server.translatedContents.set(article.id, null);
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "none" });
    expect(await core.getTranslatedContent(article.id, T1)).toEqual({ status: "none" });
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "none" });
    expect(server.translationContentRequests).toEqual([article.id]);
    // 印は大きさに数えない
    expect(await translationRows(db)).toEqual([
      { article_id: article.id, html: null, translated_at: T1 },
    ]);
    expect((await core.getContentStorage()).used).toBe(0);
  });

  test("出すもののない訳した本文は none（原文の本文を出す）", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<script>alert(1)</script>");
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "none" });
  });

  test("訳し直して訳した時刻が替わったら、古い本文を使わず取り直す", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<p>古い訳</p>");
    await core.fetchTranslatedContent(article.id, T1);

    server.setTranslation(article.id, translated(T2));
    server.translatedContents.set(article.id, "<p>新しい訳</p>");
    await core.sync();
    expect(await core.getTranslatedContent(article.id, T2)).toEqual({ status: "missing" });
    expect(await core.fetchTranslatedContent(article.id, T2)).toMatchObject({
      status: "ready",
      content: { nodes: [{ tag: "p", children: ["新しい訳"] }] },
    });
    expect(server.translationContentRequests).toEqual([article.id, article.id]);
  });

  test("sendo の訳文が頼んだ時刻のものでなければ stale。新しい本文は置いておき、同期で時刻が届いたら手元から使う", async () => {
    const { server, core, article } = await seeded();
    // 同期の前に、sendo で訳し直した
    server.setTranslation(article.id, translated(T2));
    server.translatedContents.set(article.id, "<p>新しい訳</p>");
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "stale" });
    expect(await core.getTranslatedContent(article.id, T1)).toEqual({ status: "missing" });

    await core.sync();
    expect(await core.getTranslatedContent(article.id, T2)).toMatchObject({
      status: "ready",
      content: { nodes: [{ tag: "p", children: ["新しい訳"] }] },
    });
    expect(server.translationContentRequests).toEqual([article.id]);
  });

  test("あとから古い訳文が返っても、手元の新しい本文を上書きしない", async () => {
    const { server, core, db, article } = await seeded(T2);
    server.translatedContents.set(article.id, "<p>新しい訳</p>");
    await core.fetchTranslatedContent(article.id, T2);

    // 古い時刻の訳文を返す（遅れて返った応答と同じ）。頼んだ時刻のものなので返すが、置かない
    server.setTranslation(article.id, translated(T1));
    server.translatedContents.set(article.id, "<p>古い訳</p>");
    expect(await core.fetchTranslatedContent(article.id, T1)).toMatchObject({
      status: "ready",
      content: { nodes: [{ tag: "p", children: ["古い訳"] }] },
    });
    expect(await translationRows(db)).toEqual([
      { article_id: article.id, html: "<p>新しい訳</p>", translated_at: T2 },
    ]);
    expect(await core.getTranslatedContent(article.id, T2)).toMatchObject({ status: "ready" });
  });

  test("前の時刻の取得の途中で新しい時刻を頼んだら、前の取得が古い訳文を返しても、取り直して新しい本文を返す", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<p>古い訳</p>");
    let release = () => {};
    server.translationResponseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 開いた記事の T1 の本文を取っている。偽の sendo は、受けたその場で T1 の応答を作る
    const first = core.fetchTranslatedContent(article.id, T1);
    await vi.waitFor(() => expect(server.translationContentRequests).toHaveLength(1));
    // 取っている間に sendo で訳し直し、同期で T2 が届いた。画面は T2 の本文を頼む
    server.setTranslation(article.id, translated(T2));
    server.translatedContents.set(article.id, "<p>新しい訳</p>");
    await core.sync();
    const second = core.fetchTranslatedContent(article.id, T2);
    // 前の取得は、T1 の訳文を返す
    release();
    expect(await first).toMatchObject({ content: { nodes: [{ children: ["古い訳"] }] } });
    expect(await second).toMatchObject({
      status: "ready",
      content: { nodes: [{ tag: "p", children: ["新しい訳"] }] },
    });
    expect(server.translationContentRequests).toEqual([article.id, article.id]);
    expect(await core.getTranslatedContent(article.id, T2)).toMatchObject({ status: "ready" });
  });

  test("sendo に訳文がなければ（404）stale にし、何も置かない", async () => {
    const { server, core, db, article } = await seeded();
    server.setTranslation(article.id, { ...translated(T1), status: "queued", translatedAt: null });
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "stale" });
    expect(await translationRows(db)).toEqual([]);
  });

  test("届かなければ network で失敗し、手元は missing のまま。つながったら取れる", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳</p>");
    server.failNext("network");
    await expect(core.fetchTranslatedContent(article.id, T1)).rejects.toMatchObject({
      kind: "network",
    });
    expect(await core.getTranslatedContent(article.id, T1)).toEqual({ status: "missing" });
    expect(await core.fetchTranslatedContent(article.id, T1)).toMatchObject({ status: "ready" });
  });

  test("応答の形が違えば server で失敗し、置かない", async () => {
    const { server, core, db, article } = await seeded();
    server.translatedContents.set(article.id, 1 as unknown as string);
    const error = await core.fetchTranslatedContent(article.id, T1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "server" });
    expect(await translationRows(db)).toEqual([]);
  });

  test("同じ記事を同時に頼んでも、取りにいくのは 1 回", async () => {
    const { server, core, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳</p>");
    const [a, b] = await Promise.all([
      core.fetchTranslatedContent(article.id, T1),
      core.fetchTranslatedContent(article.id, T1),
    ]);
    expect(a).toEqual(b);
    expect(server.translationContentRequests).toEqual([article.id]);
  });

  test("取っている間にログアウトしたら、置かない", async () => {
    const { server, core, db, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳</p>");
    server.failNext("hang");
    const fetching = core.fetchTranslatedContent(article.id, T1);
    await core.signOut();
    await expect(fetching).rejects.toBeInstanceOf(ApiError);
    expect(await translationRows(db)).toEqual([]);
  });

  test("取っている間に記事が手元から消えたら、置かない", async () => {
    const { server, core, db, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳</p>");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.onRequest = async (path) => {
      if (!path.endsWith("/translation")) return;
      entered();
      await gate;
    };
    const fetching = core.fetchTranslatedContent(article.id, T1);
    await requested;
    server.removeFromInbox(article.id);
    await core.sync();
    release();
    await fetching;
    expect(await translationRows(db)).toEqual([]);
    expect((await core.getContentStorage()).used).toBe(0);
  });

  test("ログインしていなければ unauthorized", async () => {
    const { core, article } = await seeded();
    await core.signOut();
    await expect(core.fetchTranslatedContent(article.id, T1)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

describe("手元の訳した本文を消す", () => {
  test("受信箱から消えた記録が届いたら、訳した本文も一緒に消す", async () => {
    const { server, core, db, article } = await seeded();
    server.translatedContents.set(article.id, "<p>訳</p>");
    await core.fetchTranslatedContent(article.id, T1);
    server.removeFromInbox(article.id);
    await core.sync();
    expect(await translationRows(db)).toEqual([]);
    expect((await core.getContentStorage()).used).toBe(0);
  });

  test("訳した本文を置いて上限を超えたら、既読の古い記事から消す。いま置いた記事と最後に開いた記事は残す", async () => {
    const { server, core, db, feed } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const article = server.deliver(feed.id, {
        publishedAt: server.now - i,
        translation: translated(T1),
      });
      server.translatedContents.set(article.id, "<p>訳</p>");
      ids.push(article.id);
    }
    const [old, opened, fresh] = ids as [string, string, string];
    await core.sync();
    await core.setContentStorageLimit(50 * MB);
    for (const id of [old, opened]) await core.fetchTranslatedContent(id, T1);
    // 本文の大きさだけを大きく見せ、ちょうど上限にする（超えていないので、まだ消さない）
    await db.run("update article_content_sizes set bytes = ?", [25 * MB]);
    for (const id of [old, opened]) {
      server.now += 1000;
      await core.setRead(id, true);
    }
    await core.recordArticleOpen(opened);
    expect((await core.getContentStorage()).used).toBe(50 * MB);

    // 置いて上限を超えたので、既読の古い記事の分を消す
    expect(await core.fetchTranslatedContent(fresh, T1)).toMatchObject({ status: "ready" });
    expect((await translationRows(db)).map((row) => row.article_id)).toEqual(
      [opened, fresh].sort(),
    );
  });

  test("訳した本文は本文の量に数え、上限を超えたら、原文の本文と同じく既読の古い記事から消す", async () => {
    const { server, core, db, feed } = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const article = server.deliver(feed.id, {
        publishedAt: server.now - i,
        translation: translated(T1),
      });
      server.translatedContents.set(article.id, "<p>訳</p>");
      ids.push(article.id);
    }
    const [readFirst, readSecond, unread, opened] = ids as [string, string, string, string];
    await core.sync();
    for (const id of ids) await core.fetchTranslatedContent(id, T1);
    const bytes = new TextEncoder().encode("<p>訳</p>").byteLength;
    expect((await core.getContentStorage()).used).toBe(bytes * 4);

    // 本文の大きさだけを大きく見せる（何十 MB の本文を作らずに、上限を確かめる）
    await db.run("update article_content_sizes set bytes = ?", [20 * MB]);
    for (const id of [readFirst, readSecond, opened]) {
      server.now += 1000;
      await core.setRead(id, true);
    }
    await core.recordArticleOpen(opened);

    // 80MB を 50MB に。既読の古い記事から消し、未読と最後に開いた記事は残す
    expect(await core.setContentStorageLimit(50 * MB)).toEqual({ limit: 50 * MB, used: 40 * MB });
    expect((await translationRows(db)).map((row) => row.article_id)).toEqual(
      [unread, opened].sort(),
    );
    // 消した記事は、開けばまた取れる
    expect(await core.fetchTranslatedContent(readFirst, T1)).toMatchObject({ status: "ready" });
  });
});

describe("訳した本文を先に取る", () => {
  test("訳文のある未読の記事は、全文ではなく訳した本文を取る。訳文のない記事は全文。選ぶ順と件数は同じ", async () => {
    const { server, core, feed, article: first } = await seeded();
    const t = server.now;
    // seeded の記事（訳文あり）より新しい記事を 2 つ。片方は訳文なし
    const plain = server.deliver(feed.id, { publishedAt: t + 2 });
    const second = server.deliver(feed.id, { publishedAt: t + 1, translation: translated(T1) });
    for (const article of [first, plain, second]) {
      server.pageContents.set(article.id, "<p>全文</p>");
      server.translatedContents.set(article.id, `<p>訳 ${article.id}</p>`);
    }
    await core.sync();

    // 1 回に取るのは 2 件まで。新しい順に選ぶ
    expect(await core.prefetchArticleContents(2)).toBe(2);
    expect(server.pageContentRequests).toEqual([plain.id]);
    expect(server.translationContentRequests).toEqual([second.id]);
    expect(await core.prefetchArticleContents(2)).toBe(1);
    expect(server.translationContentRequests).toEqual([second.id, first.id]);
    expect(server.pageContentRequests).toEqual([plain.id]);

    // 開くと、通信を待たずに訳した本文が出る
    const requested = server.requests.length;
    expect(await core.getTranslatedContent(first.id, T1)).toMatchObject({
      status: "ready",
      content: { nodes: [{ tag: "p", children: [`訳 ${first.id}`] }] },
    });
    expect(server.requests).toHaveLength(requested);
    // 取るものがなければ、sendo に何も聞かない
    expect(await core.prefetchArticleContents(2)).toBe(0);
    expect(server.requests).toHaveLength(requested);
  });

  test("全文を先に取ったあとで訳文が届いたら、次の先読みで訳した本文を取る。全文は消さない", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, {
      translation: { ...translated(T1), status: "queued", title: null, translatedAt: null },
    });
    server.pageContents.set(article.id, "<p>全文</p>");
    server.translatedContents.set(article.id, "<p>訳</p>");
    await core.sync();
    await core.prefetchArticleContents(10);
    expect(server.pageContentRequests).toContain(article.id);
    expect(server.translationContentRequests).not.toContain(article.id);

    server.setTranslation(article.id, translated(T2));
    await core.sync();
    await core.prefetchArticleContents(10);
    expect(server.translationContentRequests).toContain(article.id);
    expect(await core.getTranslatedContent(article.id, T2)).toMatchObject({ status: "ready" });
    expect(await core.getArticleContent(article.id, "page")).toMatchObject({ status: "ready" });
  });

  test("本文を訳さなかった記事は、続けて全文を取る。次の先読みでは、どちらも取り直さない", async () => {
    const { server, core, article } = await seeded();
    server.pageContents.set(article.id, "<p>全文</p>");
    server.translatedContents.set(article.id, null);
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.translationContentRequests).toEqual([article.id]);
    expect(server.pageContentRequests).toEqual([article.id]);
    expect(await core.getArticleContent(article.id, "page")).toMatchObject({ status: "ready" });

    const before = server.requests.length;
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.requests).toHaveLength(before);
  });

  test("木にして出すものが残らない訳した本文は、本文を訳さなかったものとして、続けて全文を取る", async () => {
    const { server, core, db, article } = await seeded();
    server.pageContents.set(article.id, "<p>全文</p>");
    server.translatedContents.set(article.id, "<script>alert(1)</script><p></p>");
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.translationContentRequests).toEqual([article.id]);
    expect(server.pageContentRequests).toEqual([article.id]);
    expect(await core.getTranslatedContent(article.id, T1)).toEqual({ status: "none" });
    // 本文を訳さなかった印として置き、大きさには数えない（全文の分だけ）
    expect(await translationRows(db)).toEqual([
      { article_id: article.id, html: null, translated_at: T1 },
    ]);
    expect((await core.getContentStorage()).used).toBe(
      new TextEncoder().encode("<p>全文</p>").byteLength,
    );
    // 次の先読みでは、どちらも取り直さない
    const before = server.requests.length;
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.requests).toHaveLength(before);
  });

  test("本文を訳さなかった印のある記事は、これまでどおり全文を取る", async () => {
    const { server, core, article } = await seeded();
    server.pageContents.set(article.id, "<p>全文</p>");
    server.translatedContents.set(article.id, null);
    // 開いて、本文を訳さなかったと知った（全文はまだない）
    expect(await core.fetchTranslatedContent(article.id, T1)).toEqual({ status: "none" });
    expect(await core.prefetchArticleContents(10)).toBe(1);
    expect(server.translationContentRequests).toEqual([article.id]);
    expect(server.pageContentRequests).toEqual([article.id]);
  });

  test("取る間に訳し直された記事は、その回では取り直さず、全文も取らない。同期で時刻が届いたら手元から使う", async () => {
    const { server, core, article } = await seeded();
    server.pageContents.set(article.id, "<p>全文</p>");
    // 手元は T1 のまま、sendo で訳し直した
    server.setTranslation(article.id, translated(T2));
    server.translatedContents.set(article.id, "<p>新しい訳</p>");
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.translationContentRequests).toEqual([article.id]);
    expect(server.pageContentRequests).toEqual([]);

    await core.sync();
    expect(await core.getTranslatedContent(article.id, T2)).toMatchObject({ status: "ready" });
    expect(await core.prefetchArticleContents(10)).toBe(0);
    expect(server.translationContentRequests).toEqual([article.id]);
  });

  test("開いている一覧の、読んでいる位置のすぐ下から、訳した本文を取る", async () => {
    const { server, core, feed, article: first } = await seeded();
    const other = server.subscribe({ url: "https://example.com/other.xml" });
    const newest = server.deliver(other.id, {
      publishedAt: server.now + 10_000,
      translation: translated(T1),
    });
    for (const article of [first, newest]) {
      server.translatedContents.set(article.id, "<p>訳</p>");
    }
    await core.sync();
    core.setOpenList({ feedId: feed.id }, { tab: "tab", seq: 1 });
    expect(await core.prefetchArticleContents(10)).toBe(2);
    expect(server.translationContentRequests).toEqual([first.id, newest.id]);
  });
});
