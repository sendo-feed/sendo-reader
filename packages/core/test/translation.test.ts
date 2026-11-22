import { describe, expect, test } from "vitest";
import { setup } from "./helpers";

/*
 * 記事の翻訳を、差分同期で受けて手元に置く（docs/decisions/translation.md、sendo の
 * docs/decisions/sync.md の 10）
 */

const TRANSLATED_AT = "2026-11-22T05:00:00.000Z";

const queued = { language: "en", status: "queued", title: null, summary: null, translatedAt: null };
const translated = {
  language: "en",
  status: "translated",
  title: "コードモッドでリファクタリングする",
  summary: "API の変更を自動で当てる",
  translatedAt: TRANSLATED_AT,
};

async function seeded() {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://example.com/feed.xml" });
  return { ...context, feed };
}

describe("記事の翻訳を受ける", () => {
  test("届いた翻訳を置き、次の同期で替わった翻訳に置き換える", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, {
      title: "Refactoring with Codemods",
      translation: queued,
    });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toEqual(queued);

    server.setTranslation(article.id, translated);
    await core.sync();
    const [listed] = await core.listArticles();
    expect(listed?.translation).toEqual({ ...translated, translatedAt: Date.parse(TRANSLATED_AT) });
    // 原文のタイトルは原文のまま
    expect(listed?.title).toBe("Refactoring with Codemods");
  });

  test("翻訳の付かない記事は null。訳文の文字は、タグの文字列も文字のまま置く", async () => {
    const { server, core, feed } = await seeded();
    const none = server.deliver(feed.id, { title: "日本語の記事" });
    const tagged = server.deliver(feed.id, {
      translation: { ...translated, title: "<script>alert(1)</script>" },
    });
    await core.sync();
    expect((await core.getArticle(none.id))?.translation).toBeNull();
    expect((await core.getArticle(tagged.id))?.translation?.title).toBe(
      "<script>alert(1)</script>",
    );
  });

  test.each([
    ["知らない状態", { ...queued, status: "retranslating" }],
    ["文字列でない言語", { ...queued, language: 1 }],
    ["言語の形が違う", { ...queued, language: "EN-us" }],
    ["読めない時刻", { ...translated, translatedAt: "yesterday" }],
    ["文字列でないタイトル", { ...translated, title: 1 }],
    ["オブジェクトでない", "translated"],
    ["配列", [translated]],
  ])("%s が届いても同期は止まらず、その記事は翻訳なしで置く", async (_name, translation) => {
    const { server, core, feed } = await seeded();
    const broken = server.deliver(feed.id, { title: "Broken", translation });
    const ok = server.deliver(feed.id, { title: "OK", translation: queued });
    // 形が崩れていると同期は投げる。投げずに終わり、記事は置かれる
    await core.sync();
    expect((await core.getArticle(broken.id))?.title).toBe("Broken");
    expect((await core.getArticle(broken.id))?.translation).toBeNull();
    expect((await core.getArticle(ok.id))?.translation).toEqual(queued);
  });

  test("翻訳に対応する前の sendo が相手でも、同期は止まらない（翻訳なし）", async () => {
    const { server, core, feed } = await seeded();
    server.omitTranslation = true;
    const article = server.deliver(feed.id, { translation: translated });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toBeNull();
  });

  test("最初から同期し直したときも、翻訳を置き直す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { translation: queued });
    const gone = server.deliver(feed.id);
    await core.sync();
    server.setTranslation(article.id, translated);
    server.removeFromInbox(gone.id);
    server.purgeTombstones();
    const result = await core.sync();
    expect(result.pull.reset).toBe(true);
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      status: "translated",
      title: translated.title,
    });
  });

  test("既読にしたあとで翻訳が届いても、既読のまま", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { translation: queued });
    await core.sync();
    await core.setRead(article.id, true);
    await core.sync();
    server.setTranslation(article.id, translated);
    await core.sync();
    const stored = await core.getArticle(article.id);
    expect(stored?.readAt).not.toBeNull();
    expect(stored?.translation?.status).toBe("translated");
  });
});
