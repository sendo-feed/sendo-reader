import { describe, expect, test } from "vitest";
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
