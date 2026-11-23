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

describe("translationLabel", () => {
  test.each([
    ["queued", "EN · Queued"],
    ["translating", "EN · Translating"],
    ["translated", "EN · Translated"],
    ["untranslated", "EN · Untranslated"],
  ] as const)("%s は %s", (status, label) => {
    expect(translationLabel(t("en", status))).toBe(label);
  });

  test("und でない untranslated は、言語と一緒に出す", () => {
    expect(translationLabel(t("en", "untranslated"))).toBe("EN · Untranslated");
  });

  test("言語を大文字にする", () => {
    expect(translationLabel(t("zh", "translated"))).toBe("ZH · Translated");
  });

  test("翻訳のない記事にはラベルを出さない", () => {
    expect(translationLabel(null)).toBeNull();
    // 翻訳に対応する前の版のタブが代表のときは、項目そのものがない
    expect(translationLabel(undefined)).toBeNull();
  });

  test("und は、言語を省いて状態だけを出す。queued（sendo は作らない）は出さない", () => {
    expect(translationLabel(t("und", "untranslated"))).toBe("Untranslated");
    expect(translationLabel(t("und", "queued"))).toBeNull();
    expect(translationLabel(t("und", "translating"))).toBe("Translating");
    expect(translationLabel(t("und", "translated"))).toBe("Translated");
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
    ["claude-sonnet-5-5", "Sonnet"],
    ["claude-haiku-5-5", "Haiku"],
    ["claude-opus-5-5", "Opus"],
    ["claude-haiku-4-5-20251001", "Haiku"],
  ])("%s は系列の名前（%s）にし、版は出さない", (model, name) => {
    expect(modelName(model)).toBe(name);
  });

  test.each([
    ["知らない系列", "claude-fable-1"],
    ["ほかのモデル", "gpt-unknown"],
    ["頭が途中まで", "claude-sonnet"],
    ["大文字", "Claude-Haiku-5-5"],
  ])("%s の ID は、届いたまま出す", (_name, model) => {
    expect(modelName(model)).toBe(model);
  });
});

describe("translationConditions と articleTranslationLabel", () => {
  const translated = (model: unknown, effort: unknown): ArticleTranslation =>
    ({ ...t("en", "translated", "訳"), model, effort }) as ArticleTranslation;

  test("Translated の記事は、ラベルの終わりにモデルと思考量を足す", () => {
    expect(translationConditions(translated("claude-haiku-5-5", "low"))).toBe("Haiku low");
    expect(articleTranslationLabel(translated("claude-haiku-5-5", "low"))).toBe(
      "EN · Translated · Haiku low",
    );
    expect(articleTranslationLabel(translated("claude-opus-5-5", "high"))).toBe(
      "EN · Translated · Opus high",
    );
  });

  test("知らないモデルの ID と思考量は、届いたまま出す", () => {
    expect(articleTranslationLabel(translated("gpt-unknown", "ultra"))).toBe(
      "EN · Translated · gpt-unknown ultra",
    );
  });

  test("思考量がない（null、空、文字でない、項目なし）なら、モデルだけを足す", () => {
    for (const effort of [null, "", 1, undefined]) {
      expect(articleTranslationLabel(translated("claude-sonnet-5-5", effort))).toBe(
        "EN · Translated · Sonnet",
      );
    }
  });

  test("モデルがない（null、空、文字でない、項目なし）なら、思考量があっても何も足さない", () => {
    for (const model of [null, "", 1, undefined]) {
      expect(translationConditions(translated(model, "low"))).toBeNull();
      expect(articleTranslationLabel(translated(model, "low"))).toBe("EN · Translated");
    }
    // 条件の項目のない翻訳（版の違うタブが代表のとき）
    expect(articleTranslationLabel(t("en", "translated", "訳"))).toBe("EN · Translated");
  });

  test("Translated でない状態（Translating の間を含む）には足さない", () => {
    for (const status of ["queued", "translating", "untranslated"] as const) {
      const translation = {
        ...t("en", status),
        model: "claude-haiku-5-5",
        effort: "low",
      };
      expect(translationConditions(translation)).toBeNull();
      expect(articleTranslationLabel(translation)).toBe(translationLabel(translation));
    }
  });

  test("und の記事は、言語を省いた状態のあとに足す。翻訳のない記事には出さない", () => {
    expect(
      articleTranslationLabel({
        ...t("und", "translated", "訳"),
        model: "claude-haiku-5-5",
        effort: "low",
      }),
    ).toBe("Translated · Haiku low");
    expect(articleTranslationLabel(null)).toBeNull();
    expect(articleTranslationLabel(undefined)).toBeNull();
  });
});
