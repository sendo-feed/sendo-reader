import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../src";
import type { Article } from "../src/models";
import {
  TRANSLATION_MARK_MS,
  TRANSLATION_WATCH_MS,
  TranslationRequests,
} from "../src/translation-requests";
import { setup } from "./helpers";

/*
 * 記事をその場で訳してもらう（docs/decisions/translation.md の 4、6）。頼んだ印と頼んだ記事は
 * core のメモリーにだけ置く
 */

const queued = {
  language: "en",
  status: "queued",
  title: null,
  summary: null,
  translatedAt: null,
  retranslated: false,
};
const translated = (at: number) => ({
  language: "en",
  status: "translated",
  title: "訳したタイトル",
  summary: null,
  translatedAt: new Date(at).toISOString(),
  retranslated: false,
});
const untranslated = { ...queued, status: "untranslated" };

afterEach(() => {
  vi.useRealTimers();
});

async function seeded(translation: unknown = queued) {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://example.com/feed.xml" });
  const article = context.server.deliver(feed.id, { title: "Original", translation });
  await context.core.sync();
  return { ...context, article };
}

describe("その場の翻訳を頼む", () => {
  test("受け付けられたらすぐ translating にし、頼んだあとの同期と訳文の到着で印を外す", async () => {
    const { server, core, article } = await seeded();
    await core.requestTranslation(article.id);
    expect(server.translationRequests).toEqual([article.id]);
    // 同期を待たずに、手元の記事を translating にする
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });
    expect((await core.listArticles())[0]?.translationRequest).toBe("requested");

    // 頼んだあとに始めた同期で、印を外す（sendo は translating にしてある）
    await core.sync();
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });

    server.setTranslation(article.id, translated(server.now));
    await core.sync();
    const done = await core.getArticle(article.id);
    expect(done?.translation).toMatchObject({ status: "translated", title: "訳したタイトル" });
    expect(done?.translationRequest).toBeUndefined();
  });

  test("sendo で訳せずに untranslated に戻ったら、訳せなかったことにする。頼み直せる", async () => {
    const { server, core, article } = await seeded();
    await core.requestTranslation(article.id);
    server.setTranslation(article.id, untranslated);
    await core.sync();
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "untranslated" },
      translationRequest: "failed",
    });

    await core.requestTranslation(article.id);
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });
    expect(server.translationRequests).toEqual([article.id, article.id]);
  });

  test("translation_exists は、受け付けられたときと同じに扱う", async () => {
    const { server, core, article } = await seeded({
      ...queued,
      status: "translating",
    });
    await core.requestTranslation(article.id);
    expect((await core.getArticle(article.id))?.translationRequest).toBe("requested");
    expect(server.translationRequests).toEqual([article.id]);
  });

  test("断られたら理由の code を付けて投げ、印を付けない", async () => {
    const { server, core, article } = await seeded();
    server.translationRequestError = { status: 503, code: "translation_unavailable" };
    const error = await core.requestTranslation(article.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "translation_unavailable" });
    expect(await core.getArticle(article.id)).toMatchObject({ translation: { status: "queued" } });
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
  });

  test("届かなければ network で投げ、操作キューにも積まない", async () => {
    const { server, core, article } = await seeded();
    server.failNext("network");
    await expect(core.requestTranslation(article.id)).rejects.toMatchObject({ kind: "network" });
    expect(await core.countPending()).toBe(0);
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
  });

  test("受け付ける前に始まっていた同期が終わっても、印を外さない", async () => {
    const { server, core, article } = await seeded();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const syncStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.onRequest = async (path) => {
      if (!path.startsWith("GET /sync")) return;
      server.onRequest = null;
      entered();
      await gate;
    };
    const running = core.sync();
    await syncStarted;
    await core.requestTranslation(article.id);
    // 受け付けたあとに sendo を変えても、走っていた同期は前の状態を届けるかもしれない
    server.setTranslation(article.id, untranslated);
    release();
    await running;
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });

    // 受け付けたあとに始めた同期で、訳せなかったと決める
    await core.sync();
    expect((await core.getArticle(article.id))?.translationRequest).toBe("failed");
  });

  test("1 分で印を外し、1 時間で忘れる", async () => {
    const { server, core, article } = await seeded();
    await core.requestTranslation(article.id);
    server.now += TRANSLATION_MARK_MS;
    // 印は外れ、手元の状態（queued）で出す。頼んだ記事としては覚えている
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "queued" },
      translationRequest: "requested",
    });
    server.now += TRANSLATION_WATCH_MS;
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
  });

  test("1 分で印が外れたら、記事が変わったと知らせる（画面が読み直して Translate をまた出す）", async () => {
    const { server, core, article } = await seeded();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables]));
    await core.requestTranslation(article.id);
    expect(changes).toEqual([["articles"]]);

    server.now += TRANSLATION_MARK_MS - 1;
    vi.advanceTimersByTime(TRANSLATION_MARK_MS - 1);
    expect(changes).toHaveLength(1);
    server.now += 1;
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([["articles"], ["articles"]]);
    expect(await core.getArticle(article.id)).toMatchObject({ translation: { status: "queued" } });
  });

  test("訳せなかったあとでほかの人が頼んだら、この端末の頼みは忘れる（その翻訳が失敗しても失敗の文を出さない）", async () => {
    const { server, core, article } = await seeded();
    await core.requestTranslation(article.id);
    server.setTranslation(article.id, untranslated);
    await core.sync();
    expect((await core.getArticle(article.id))?.translationRequest).toBe("failed");

    // ほかの端末が頼んだ
    server.setTranslation(article.id, { ...queued, status: "translating" });
    await core.sync();
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
    });
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();

    // その翻訳も訳せずに戻った。この端末は頼んでいないので、失敗の文は出さない
    server.setTranslation(article.id, untranslated);
    await core.sync();
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
  });

  test("ログアウトすると、頼んだ印と頼んだ記事を消す", async () => {
    const { server, core, article } = await seeded();
    await core.requestTranslation(article.id);
    await core.signOut();
    expect(await core.sendPendingSignOut()).toBe(true);
    server.signInAs();
    expect(await core.restoreSession()).toBe(true);
    await core.sync();
    const again = await core.getArticle(article.id);
    expect(again).not.toBeNull();
    expect(again?.translationRequest).toBeUndefined();
  });

  test("ログインしていなければ頼めない", async () => {
    const { core, article } = await seeded();
    await core.signOut();
    await expect(core.requestTranslation(article.id)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

describe("品質優先の段階で訳し直してもらう（docs/decisions/translation.md の 5、6）", () => {
  const retranslated = (at: number) => ({
    ...translated(at),
    title: "品質優先で訳したタイトル",
    retranslated: true,
  });

  test("受け付けられたらすぐ translating にし、訳し直しの印が届いたら忘れる", async () => {
    const { server, core, article } = await seeded(translated(Date.now() - 60_000));
    await core.requestTranslation(article.id, { retranslation: true });
    expect(server.retranslationRequests).toEqual([article.id]);
    expect(server.translationRequests).toEqual([]);
    // 訳文はあるが、訳し直しが届くまでは translating にする（もとの訳文は残す）
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating", title: "訳したタイトル", retranslated: false },
      translationRequest: "requested",
    });

    await core.sync();
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });

    server.setTranslation(article.id, retranslated(server.now));
    await core.sync();
    const done = await core.getArticle(article.id);
    expect(done?.translation).toMatchObject({
      status: "translated",
      title: "品質優先で訳したタイトル",
      retranslated: true,
    });
    expect(done?.translationRequest).toBeUndefined();
  });

  test("sendo で訳し直せずに、印のない translated に戻ったら、訳せなかったことにする。頼み直せる", async () => {
    const before = translated(Date.now() - 60_000);
    const { server, core, article } = await seeded(before);
    await core.requestTranslation(article.id, { retranslation: true });
    await core.sync();
    server.setTranslation(article.id, before);
    await core.sync();
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translated", title: "訳したタイトル", retranslated: false },
      translationRequest: "failed",
    });

    await core.requestTranslation(article.id, { retranslation: true });
    expect(await core.getArticle(article.id)).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });
    expect(server.retranslationRequests).toEqual([article.id, article.id]);
  });

  test("その場の翻訳の失敗（untranslated）と取り違えない：訳し直しの最中の translating では失敗にしない", async () => {
    const { core, article } = await seeded(translated(Date.now() - 60_000));
    await core.requestTranslation(article.id, { retranslation: true });
    await core.sync();
    expect((await core.getArticle(article.id))?.translationRequest).toBe("requested");
    // 訳文はもとのまま（translatedAt がある）でも、届いたことにしない
    expect((await core.getArticle(article.id))?.translation?.status).toBe("translating");
  });

  test("retranslation_not_allowed は、受け付けられたことにせず理由の code を付けて投げる", async () => {
    const { server, core, article } = await seeded(retranslated(Date.now() - 60_000));
    const error = await core
      .requestTranslation(article.id, { retranslation: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "retranslation_not_allowed" });
    expect(server.retranslationRequests).toEqual([article.id]);
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
    expect((await core.getArticle(article.id))?.translation?.status).toBe("translated");
  });

  test("訳し直しを頼んでも translation_exists は受け付けたことにしない（その場の翻訳だけの扱い）", async () => {
    const { server, core, article } = await seeded(translated(Date.now() - 60_000));
    server.translationRequestError = { status: 409, code: "translation_exists" };
    await expect(
      core.requestTranslation(article.id, { retranslation: true }),
    ).rejects.toMatchObject({ code: "translation_exists" });
    expect((await core.getArticle(article.id))?.translationRequest).toBeUndefined();
  });
});

/*
 * 同期の途中（届いたページを知らせたあと、同期の終わりに頼みを片付ける前）に画面が読む記事。同期の
 * 途中のこの瞬間は、同期を通して確かめにくいので、頼みの表を直接使う
 */
describe("同期の途中で読んだ記事に、届いた頼みと、ほかの人の頼みを、この端末の頼みとして重ねない", () => {
  const base: Article = {
    id: "a1",
    feedId: "f1",
    url: null,
    title: "Feature Toggles",
    summary: null,
    author: null,
    thumbnailUrl: null,
    hasContent: false,
    publishedAt: 0,
    receivedAt: 0,
    readAt: null,
    starredAt: null,
    translation: null,
  };
  const withTranslation = (translation: Article["translation"]): Article => ({
    ...base,
    translation,
  });
  const sonnetAt = (at: number) => ({
    language: "en",
    status: "translated" as const,
    title: "訳したタイトル",
    summary: null,
    translatedAt: at,
    retranslated: false,
  });

  test("その場の翻訳の訳文が届いた記事", () => {
    const requests = new TranslationRequests(() => 0);
    requests.accept("a1", 0);
    const overlaid = requests.overlay(withTranslation(sonnetAt(1)));
    expect(overlaid.translationRequest).toBeUndefined();
    expect(overlaid.translation?.status).toBe("translated");
  });

  test("訳し直した訳文が届いた記事。届く前は translating にする", () => {
    const requests = new TranslationRequests(() => 0);
    requests.accept("a1", 0, true);
    expect(requests.overlay(withTranslation(sonnetAt(1)))).toMatchObject({
      translation: { status: "translating" },
      translationRequest: "requested",
    });
    const overlaid = requests.overlay(
      withTranslation({ ...sonnetAt(2), title: "Opus", retranslated: true }),
    );
    expect(overlaid.translationRequest).toBeUndefined();
    expect(overlaid.translation?.status).toBe("translated");
  });

  test("訳せなかったあとで、ほかの人の頼みで translating になった記事", async () => {
    const requests = new TranslationRequests(() => 0);
    requests.accept("a1", 0, true);
    await requests.afterSync(1, async () => [withTranslation(sonnetAt(1))]);
    expect(requests.overlay(withTranslation(sonnetAt(1))).translationRequest).toBe("failed");
    const translating = requests.overlay(
      withTranslation({ ...sonnetAt(1), status: "translating" }),
    );
    expect(translating.translationRequest).toBeUndefined();
  });
});
