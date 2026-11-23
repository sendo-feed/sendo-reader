import type { ArticleTranslation, TranslationFailure } from "@sendo-reader/core";
import { describe, expect, test } from "vitest";
import {
  articleTranslationLabel,
  listTitle,
  modelName,
  TRANSLATION_FAILED,
  translationConditions,
  translationFailureText,
  translationLabel,
} from "../src/lib/translation";

/** 翻訳のラベルと、一覧に出すタイトル（docs/decisions/translation.md の 1、2） */

const t = (
  language: string,
  status: ArticleTranslation["status"],
  title: string | null = null,
) => ({
  language,
  status,
  title,
  summary: null,
  translatedAt: title === null ? null : 1,
  retranslated: false,
});

const language = (text: string) => ({ kind: "language", text });
const status = (text: string) => ({ kind: "status", text });
const model = (text: string) => ({ kind: "model", text });
const effort = (text: string) => ({ kind: "effort", text });

describe("translationLabel", () => {
  test.each([
    ["queued", "Queued"],
    ["translating", "Translating"],
    ["translated", "Translated"],
    ["untranslated", "Untranslated"],
  ] as const)("%s は、言語の枠と %s の枠の 2 つ", (state, label) => {
    expect(translationLabel(t("en", state))).toEqual([language("EN"), status(label)]);
  });

  test("言語を大文字にする", () => {
    expect(translationLabel(t("zh", "translated"))).toEqual([language("ZH"), status("Translated")]);
  });

  test("翻訳のない記事にはラベルを出さない", () => {
    expect(translationLabel(null)).toBeNull();
    // 翻訳に対応する前の版のタブが代表のときは、項目そのものがない
    expect(translationLabel(undefined)).toBeNull();
  });

  test("und は、言語の枠を出さず状態の枠だけ。queued（sendo は作らない）は出さない", () => {
    expect(translationLabel(t("und", "untranslated"))).toEqual([status("Untranslated")]);
    expect(translationLabel(t("und", "queued"))).toBeNull();
    expect(translationLabel(t("und", "translating"))).toEqual([status("Translating")]);
    expect(translationLabel(t("und", "translated"))).toEqual([status("Translated")]);
  });

  test("一覧の行には、Translated でもモデルと思考量の枠を足さない", () => {
    expect(
      translationLabel({
        ...t("en", "translated", "訳"),
        model: "claude-haiku-5-5",
        effort: "low",
      }),
    ).toEqual([language("EN"), status("Translated")]);
  });
});

describe("listTitle", () => {
  test("訳したタイトルがあれば、それを出す", () => {
    expect(listTitle({ title: "Original", translation: t("en", "translated", "訳") })).toBe("訳");
  });

  test("訳したタイトルがなければ、原文のタイトル", () => {
    expect(listTitle({ title: "Original", translation: t("en", "queued") })).toBe("Original");
    expect(listTitle({ title: "Original", translation: null })).toBe("Original");
    expect(listTitle({ title: null, translation: null })).toBeNull();
    expect(listTitle({ title: "Original" })).toBe("Original");
  });

  test("訳したタイトルが空なら、原文のタイトル", () => {
    expect(listTitle({ title: "Original", translation: t("en", "translated", "") })).toBe(
      "Original",
    );
  });
});

/** 訳せなかった理由の文（docs/decisions/translation.md の 1） */
describe("translationFailureText", () => {
  const withFailure = (
    failure: TranslationFailure | null,
    status: ArticleTranslation["status"] = "untranslated",
  ): ArticleTranslation => ({ ...t("en", status), failure });

  test("拒否・その場の翻訳（記事 007f6c3e-… の形）は、種類を添えて、頼み直しても同じ見込みが高いと出す", () => {
    expect(
      translationFailureText(
        withFailure({ kind: "refused", category: "cyber", stage: "on_demand" }),
      ),
    ).toBe(
      "サイバーセキュリティの安全策で、翻訳を断られました。頼み直しても、同じ結果になる見込みが高いです。",
    );
  });

  test("拒否・バッチは、Translate で頼み直すと通ることがあると出し、別のモデルで試すとは言い切らない", () => {
    const text = translationFailureText(
      withFailure({ kind: "refused", category: "bio", stage: "batch" }),
    );
    expect(text).toBe(
      "生物学の安全策で、翻訳を断られました。Translate で頼み直すと、通ることがあります。",
    );
    expect(text).not.toContain("別のモデル");
  });

  test.each([
    ["知らない種類", "unknown_category"],
    ["Object の性質の名前", "toString"],
    ["空", null],
  ])("拒否の種類が%sなら、種類を添えずに拒否の文を出す", (_name, category) => {
    expect(
      translationFailureText(withFailure({ kind: "refused", category, stage: "on_demand" })),
    ).toBe("安全策で、翻訳を断られました。頼み直しても、同じ結果になる見込みが高いです。");
  });

  test.each([
    ["そのほかの失敗", { kind: "failed", category: null, stage: "batch" }],
    ["知らない種類（kind）", { kind: "timeout", category: "cyber", stage: "on_demand" }],
    ["知らないどこで起きたか（stage）", { kind: "refused", category: "cyber", stage: "scheduled" }],
  ])("%s は、そのほかの失敗の文を出す", (_name, failure) => {
    expect(translationFailureText(withFailure(failure))).toBe(TRANSLATION_FAILED);
  });

  test("untranslated でない記事、理由のない記事、理由の項目のない記事（版の違うタブ）、翻訳のない記事には出さない", () => {
    const failure = { kind: "refused", category: "cyber", stage: "on_demand" };
    for (const status of ["queued", "translating", "translated"] as const) {
      expect(translationFailureText(withFailure(failure, status))).toBeNull();
    }
    expect(translationFailureText(withFailure(null))).toBeNull();
    expect(translationFailureText(t("en", "untranslated"))).toBeNull();
    expect(translationFailureText(t("und", "untranslated"))).toBeNull();
    expect(translationFailureText(null)).toBeNull();
    expect(translationFailureText(undefined)).toBeNull();
  });
});

/** 訳したモデルと思考量（docs/decisions/translation.md の 1） */
describe("modelName", () => {
  test.each([
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-opus-4-1", "Opus 4.1"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-sonnet-4-20250514", "Sonnet 4"],
    // 副版は 0 でも出す
    ["claude-sonnet-4-0", "Sonnet 4.0"],
    // 版は 2 桁まで
    ["claude-opus-10-12", "Opus 10.12"],
    ["claude-opus-10-12-20300101", "Opus 10.12"],
  ])("%s は %s（系列の名前と版。日付は出さない）", (id, name) => {
    expect(modelName(id)).toBe(name);
  });

  test.each([
    ["知らない系列", "claude-fable-1"],
    ["ほかのモデル", "gpt-unknown"],
    ["版がない", "claude-sonnet"],
    ["版が数字でない", "claude-sonnet-latest"],
    ["系列が版のあと（古い形）", "claude-3-5-sonnet-20241022"],
    ["大文字（頭）", "Claude-Haiku-5-5"],
    ["大文字（系列）", "claude-Haiku-5-5"],
    ["版が 3 つ", "claude-sonnet-5-5-1"],
    ["版が 3 桁", "claude-sonnet-100"],
    ["日付が 8 桁でない", "claude-sonnet-4-2025051"],
    ["日付のあとに続き", "claude-haiku-4-5-20251001-v2"],
    ["日付が 2 つ", "claude-sonnet-4-20250514-20250514"],
    ["末尾がハイフン", "claude-sonnet-5-"],
    ["前に余分", "us.claude-sonnet-5"],
  ])("%s の ID（%s）は、届いたまま出す", (_name, id) => {
    expect(modelName(id)).toBe(id);
  });
});

describe("translationConditions と articleTranslationLabel", () => {
  const translated = (model: unknown, effort: unknown): ArticleTranslation =>
    ({ ...t("en", "translated", "訳"), model, effort }) as ArticleTranslation;

  test("Translated の記事は、言語と状態の枠のあとにモデルと思考量の枠を足す（4 つ）", () => {
    expect(translationConditions(translated("claude-haiku-5-5", "low"))).toEqual([
      model("Haiku 5.5"),
      effort("low"),
    ]);
    expect(articleTranslationLabel(translated("claude-haiku-5-5", "low"))).toEqual([
      language("EN"),
      status("Translated"),
      model("Haiku 5.5"),
      effort("low"),
    ]);
    expect(articleTranslationLabel(translated("claude-opus-5-5", "high"))).toEqual([
      language("EN"),
      status("Translated"),
      model("Opus 5.5"),
      effort("high"),
    ]);
  });

  test("知らないモデルの ID と思考量は、届いたまま出す", () => {
    expect(articleTranslationLabel(translated("gpt-unknown", "ultra"))).toEqual([
      language("EN"),
      status("Translated"),
      model("gpt-unknown"),
      effort("ultra"),
    ]);
  });

  test("思考量がない（null、空、文字でない、項目なし）なら、モデルの枠だけを足す", () => {
    for (const value of [null, "", 1, undefined]) {
      expect(articleTranslationLabel(translated("claude-sonnet-5-5", value))).toEqual([
        language("EN"),
        status("Translated"),
        model("Sonnet 5.5"),
      ]);
    }
  });

  test("モデルがない（null、空、文字でない、項目なし）なら、思考量があってもどちらの枠も足さない", () => {
    for (const value of [null, "", 1, undefined]) {
      expect(translationConditions(translated(value, "low"))).toBeNull();
      expect(articleTranslationLabel(translated(value, "low"))).toEqual([
        language("EN"),
        status("Translated"),
      ]);
    }
    // 条件の項目のない翻訳（版の違うタブが代表のとき）
    expect(articleTranslationLabel(t("en", "translated", "訳"))).toEqual([
      language("EN"),
      status("Translated"),
    ]);
  });

  test("Translated でない状態（Translating の間を含む）には足さない", () => {
    for (const state of ["queued", "translating", "untranslated"] as const) {
      const translation = {
        ...t("en", state),
        model: "claude-haiku-5-5",
        effort: "low",
      };
      expect(translationConditions(translation)).toBeNull();
      expect(articleTranslationLabel(translation)).toEqual(translationLabel(translation));
    }
  });

  test("und の記事は、状態の枠のあとに足す。翻訳のない記事には出さない", () => {
    expect(
      articleTranslationLabel({
        ...t("und", "translated", "訳"),
        model: "claude-haiku-5-5",
        effort: "low",
      }),
    ).toEqual([status("Translated"), model("Haiku 5.5"), effort("low")]);
    expect(articleTranslationLabel(t("und", "queued"))).toBeNull();
    expect(articleTranslationLabel(null)).toBeNull();
    expect(articleTranslationLabel(undefined)).toBeNull();
  });
});
