import type { ArticleTranslation } from "@sendo-reader/core";
import { describe, expect, test } from "vitest";
import { listTitle, translationLabel } from "../src/lib/translation";

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

  test("言語を大文字にする", () => {
    expect(translationLabel(t("zh", "translated"))).toBe("ZH · Translated");
  });

  test("翻訳のない記事にはラベルを出さない", () => {
    expect(translationLabel(null)).toBeNull();
    // 翻訳に対応する前の版のタブが代表のときは、項目そのものがない
    expect(translationLabel(undefined)).toBeNull();
  });

  test("und は、訳文がないあいだは出さず、訳しているときと訳したあとは言語を省く", () => {
    expect(translationLabel(t("und", "untranslated"))).toBeNull();
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
