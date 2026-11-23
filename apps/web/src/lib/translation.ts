import type { Article, ArticleTranslation, TranslationStatus } from "@sendo-reader/core";

const STATUS_LABELS: Record<TranslationStatus, string> = {
  queued: "Queued",
  translating: "Translating",
  translated: "Translated",
  untranslated: "Untranslated",
};

/**
 * 元の言語と翻訳の状態を 1 つにしたラベル（docs/decisions/translation.md の 1）。`EN · Translated` など。
 * 翻訳のない記事は null。言語が判定できなかった記事（und）は、言語を省いて状態だけを出す
 * （Untranslated、Translating、Translated。sendo は und の記事を queued にしないので、届いても出さない）
 */
export function translationLabel(
  translation: ArticleTranslation | null | undefined,
): string | null {
  // 版の違うタブが代表のときは、翻訳の項目のない記事が届くことがある（undefined）
  if (translation == null) return null;
  const status = STATUS_LABELS[translation.status];
  if (translation.language === "und") return translation.status === "queued" ? null : status;
  return `${translation.language.toUpperCase()} · ${status}`;
}

/**
 * 一覧の行に出すタイトル。訳したタイトルがあれば、それを出す（docs/decisions/translation.md の 2）。
 * 訳したタイトルが空なら、原文のタイトル
 */
export function listTitle(
  article: Pick<Article, "title"> & { translation?: Article["translation"] | undefined },
): string | null {
  const translated = article.translation?.title;
  return translated !== undefined && translated !== null && translated !== ""
    ? translated
    : article.title;
}
