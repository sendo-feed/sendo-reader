import type { ArticleTranslation, TranslationFailure } from "@sendo-reader/core";
import { describe, expect, test } from "vitest";
import {
  listTitle,
  TRANSLATION_FAILED,
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

  test("拒否・バッチは、Translate で別のモデルで試せると出す", () => {
    expect(
      translationFailureText(withFailure({ kind: "refused", category: "bio", stage: "batch" })),
    ).toBe(
      "生物学の安全策で、翻訳を断られました。Translate を押すと、断られたときに別のモデルで試します（それでも断られることがあります）。",
    );
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
