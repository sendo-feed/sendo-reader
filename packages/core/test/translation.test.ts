import { describe, expect, test } from "vitest";
import { ReaderCore } from "../src";
import { createSendoApi } from "../src/api/client";
import { migrate } from "../src/db/schema";
import { pull } from "../src/sync/pull";
import { FakeSendo } from "./fake-sendo";
import { openMemoryDb, setup } from "./helpers";

/*
 * 記事の翻訳を、差分同期で受けて手元に置く（docs/decisions/translation.md、sendo の
 * docs/decisions/sync.md の 10）
 */

const TRANSLATED_AT = "2026-11-22T05:00:00.000Z";

const queued = {
  language: "en",
  status: "queued",
  title: null,
  summary: null,
  translatedAt: null,
  retranslated: false,
  failure: null,
  model: null,
  effort: null,
};
const translated = {
  language: "en",
  status: "translated",
  title: "コードモッドでリファクタリングする",
  summary: "API の変更を自動で当てる",
  translatedAt: TRANSLATED_AT,
  retranslated: false,
  failure: null,
  model: "claude-sonnet-5-5",
  effort: "medium",
};

/** 操作を送らずに、取るだけの同期（ops.test.ts と同じ） */
async function pullOnly(context: Awaited<ReturnType<typeof setup>>) {
  const api = createSendoApi({ baseUrl: "https://sendo.test/api/v1", fetch: context.server.fetch });
  return pull(context.db, api, {});
}

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
    ["真偽でない訳し直しの印", { ...translated, retranslated: "yes" }],
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

  test("訳し直しの印を置き、替わったら置き換える。印に対応する前の sendo（項目がない）なら、訳し直していない", async () => {
    const { server, core, feed } = await seeded();
    const { retranslated: _, ...withoutFlag } = translated;
    const old = server.deliver(feed.id, { title: "Old", translation: withoutFlag });
    const article = server.deliver(feed.id, { title: "New", translation: translated });
    await core.sync();
    expect((await core.getArticle(old.id))?.translation?.retranslated).toBe(false);
    expect((await core.getArticle(article.id))?.translation?.retranslated).toBe(false);

    server.setTranslation(article.id, {
      ...translated,
      title: "品質優先で訳し直した訳",
      model: "claude-opus-5-5",
      effort: "high",
      translatedAt: "2026-11-22T06:00:00.000Z",
      retranslated: true,
    });
    await core.sync();
    const [listed] = (await core.listArticles()).filter((a) => a.id === article.id);
    expect(listed?.translation).toMatchObject({
      title: "品質優先で訳し直した訳",
      model: "claude-opus-5-5",
      effort: "high",
      retranslated: true,
    });
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

  test("まだ送っていない既読とスターがある間に翻訳が届いても、既読とスターを保ち、翻訳も置く", async () => {
    const context = await seeded();
    const { server, core, feed } = context;
    const article = server.deliver(feed.id, { translation: queued });
    await core.sync();
    await core.setRead(article.id, true);
    await core.setStarred(article.id, true);
    server.setTranslation(article.id, translated);
    // 操作を送らずに取るだけの同期。届いた行（未読・スターなし）の上に、手元の操作を重ね直す
    await pullOnly(context);
    const stored = await core.getArticle(article.id);
    expect(stored?.readAt).not.toBeNull();
    expect(stored?.starredAt).not.toBeNull();
    expect(stored?.translation?.status).toBe("translated");

    await core.sync();
    expect(server.inbox.get(article.id)?.readAt).not.toBeNull();
    expect(server.inbox.get(article.id)?.starredAt).not.toBeNull();
  });

  test("言語が und の記事も、翻訳を置く", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, {
      translation: { ...translated, language: "und" },
    });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      language: "und",
      status: "translated",
    });
  });
});

describe("訳せなかった理由を受ける（sendo の translation.md の 17、この reader の translation.md の 1）", () => {
  /** 記事 007f6c3e-… と同じ形（その場の翻訳で cyber の拒否） */
  const refused = {
    ...queued,
    status: "untranslated",
    failure: { kind: "refused", category: "cyber", stage: "on_demand" },
  };

  test("届いた理由を置き、理由が消えたら（translating、訳文）消す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { translation: refused });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation?.failure).toEqual(refused.failure);
    const [listed] = await core.listArticles();
    expect(listed?.translation?.failure).toEqual(refused.failure);

    server.setTranslation(article.id, { ...refused, status: "translating", failure: null });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      status: "translating",
      failure: null,
    });
    server.setTranslation(article.id, translated);
    await core.sync();
    expect((await core.getArticle(article.id))?.translation?.failure).toBeNull();
  });

  test("知らない種類・どこで起きたか・拒否の種類も、そのまま置く。空の拒否の種類は null", async () => {
    const { server, core, feed } = await seeded();
    const unknown = { kind: "timeout", category: "unknown_category", stage: "scheduled" };
    const a = server.deliver(feed.id, { translation: { ...refused, failure: unknown } });
    const b = server.deliver(feed.id, {
      translation: { ...refused, failure: { kind: "refused", category: null, stage: "batch" } },
    });
    await core.sync();
    expect((await core.getArticle(a.id))?.translation?.failure).toEqual(unknown);
    expect((await core.getArticle(b.id))?.translation?.failure).toEqual({
      kind: "refused",
      category: null,
      stage: "batch",
    });
  });

  test.each([
    ["オブジェクトでない", "refused"],
    ["配列", [refused.failure]],
    ["文字列でない種類", { ...refused.failure, kind: 1 }],
    ["どこで起きたかがない", { kind: "refused", category: "cyber" }],
    ["文字列でも null でもない拒否の種類", { ...refused.failure, category: 1 }],
  ])(
    "理由の形が崩れていても（%s）同期は止まらず、翻訳は残して理由だけをなしにする",
    async (_name, failure) => {
      const { server, core, feed } = await seeded();
      const broken = server.deliver(feed.id, { translation: { ...refused, failure } });
      await core.sync();
      expect((await core.getArticle(broken.id))?.translation).toMatchObject({
        status: "untranslated",
        failure: null,
      });
    },
  );

  test("理由に対応する前の sendo（項目がない）なら、理由なし", async () => {
    const { server, core, feed } = await seeded();
    const { failure: _, ...withoutFailure } = refused;
    const article = server.deliver(feed.id, { translation: withoutFailure });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      status: "untranslated",
      failure: null,
    });
  });

  test("理由を持つ前の版の手元の DB は、ある記事を残したまま理由なしにし、そのあとの同期で理由が入る", async () => {
    const server = new FakeSendo();
    const db = await openMemoryDb();
    await migrate(db, 19);
    await db.run(
      `insert into articles (id, feed_id, title, published_at, received_at, translation_status,
         translation_language) values ('old', 'feed', 'Old', 1, 1, 'untranslated', 'en')`,
    );
    const core = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
      now: () => server.now,
    });
    expect((await core.getArticle("old"))?.translation).toMatchObject({
      status: "untranslated",
      failure: null,
    });
    server.signInAs();
    await core.restoreSession();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id, { translation: { ...refused, failure: null } });
    await core.sync();
    server.setTranslation(article.id, refused);
    await core.sync();
    expect((await core.getArticle(article.id))?.translation?.failure).toEqual(refused.failure);
  });
});

describe("訳したモデルと思考量を受ける（sendo の translation.md の 18、この reader の translation.md の 1）", () => {
  const haiku = { ...translated, model: "claude-haiku-5-5", effort: "low" };

  test("届いたモデルと思考量を置き、一覧と記事で渡す。替わったら置き換え、訳文がなくなったら消す", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { translation: haiku });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
    });
    const [listed] = await core.listArticles();
    expect(listed?.translation).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });

    // 訳し直しの最中は、もとの訳文の条件のまま届く
    server.setTranslation(article.id, { ...haiku, status: "translating" });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      status: "translating",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    server.setTranslation(article.id, {
      ...haiku,
      model: "claude-opus-5-5",
      effort: "high",
      retranslated: true,
      translatedAt: "2026-11-22T06:00:00.000Z",
    });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    server.setTranslation(article.id, queued);
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      model: null,
      effort: null,
    });
  });

  test("知らないモデルの ID と思考量も、そのまま置く。思考量が null ならモデルだけ", async () => {
    const { server, core, feed } = await seeded();
    const unknown = server.deliver(feed.id, {
      translation: { ...translated, model: "gpt-unknown", effort: "ultra" },
    });
    const noEffort = server.deliver(feed.id, {
      translation: { ...haiku, effort: null },
    });
    await core.sync();
    expect((await core.getArticle(unknown.id))?.translation).toMatchObject({
      model: "gpt-unknown",
      effort: "ultra",
    });
    expect((await core.getArticle(noEffort.id))?.translation).toMatchObject({
      model: "claude-haiku-5-5",
      effort: null,
    });
  });

  test.each([
    ["数", 5, 1],
    ["真偽", true, false],
    ["オブジェクト", { id: "claude-haiku-5-5" }, ["low"]],
    ["空の文字", "", ""],
  ])(
    "モデルと思考量が文字でない・空（%s）でも同期は止まらず、届かないもの（null）として翻訳のほかの項目は使う",
    async (_name, model, effort) => {
      const { server, core, feed } = await seeded();
      const article = server.deliver(feed.id, { translation: { ...haiku, model, effort } });
      await core.sync();
      expect((await core.getArticle(article.id))?.translation).toEqual({
        ...haiku,
        translatedAt: Date.parse(TRANSLATED_AT),
        model: null,
        effort: null,
      });
    },
  );

  test("思考量だけが文字でなくても、モデルは使う", async () => {
    const { server, core, feed } = await seeded();
    const article = server.deliver(feed.id, { translation: { ...haiku, effort: 1 } });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      model: "claude-haiku-5-5",
      effort: null,
    });
  });

  test("条件に対応する前の sendo（項目がない）でも同期は止まらず、モデルと思考量は null", async () => {
    const { server, core, feed } = await seeded();
    const { model: _m, effort: _e, ...withoutConditions } = haiku;
    const article = server.deliver(feed.id, { translation: withoutConditions });
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      status: "translated",
      title: haiku.title,
      model: null,
      effort: null,
    });
  });

  test("条件を持つ前の版の手元の DB は、ある記事を残したまま条件なしにし、そのあと届いた記事には条件が入る", async () => {
    const server = new FakeSendo();
    const db = await openMemoryDb();
    await migrate(db, 20);
    await db.run(
      `insert into articles (id, feed_id, title, published_at, received_at, translation_status,
         translation_language, translated_at) values ('old', 'feed', 'Old', 1, 1, 'translated', 'en', 1)`,
    );
    const core = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
      now: () => server.now,
    });
    expect((await core.getArticle("old"))?.translation).toMatchObject({
      status: "translated",
      model: null,
      effort: null,
    });
    server.signInAs();
    await core.restoreSession();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id, { translation: translated });
    await core.sync();
    server.setTranslation(article.id, haiku);
    await core.sync();
    expect((await core.getArticle(article.id))?.translation).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
    });
  });
});
