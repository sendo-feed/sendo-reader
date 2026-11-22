import type { Article, ArticleTranslation, TranslationStatus } from "@sendo-reader/core";

const STATUS_LABELS: Record<TranslationStatus, string> = {
  queued: "Queued",
  translating: "Translating",
  translated: "Translated",
  untranslated: "Untranslated",
};

/**
 * 元の言語と翻訳の状態を 1 つにしたラベル（docs/decisions/translation.md の 1）。`EN · Translated` など。
 * 翻訳のない記事は null。言語が判定できなかった記事（und）は、訳文がないあいだは出さず、
 * 訳しているときと訳したあとは、言語を省いて出す
 */
export function translationLabel(translation: ArticleTranslation | null): string | null {
  if (translation === null) return null;
  const status = STATUS_LABELS[translation.status];
  if (translation.language === "und") {
    return translation.status === "translating" || translation.status === "translated"
      ? status
      : null;
  }
  return `${translation.language.toUpperCase()} · ${status}`;
}

/** 一覧の行に出すタイトル。訳したタイトルがあれば、それを出す（docs/decisions/translation.md の 2） */
export function listTitle(article: Pick<Article, "title" | "translation">): string | null {
  return article.translation?.title ?? article.title;
}
