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

/**
 * その場の翻訳が sendo で訳せずに戻ったときの文（docs/decisions/translation.md の 6）。訳せなかった
 * 理由の、そのほかの失敗の文も同じ（同じく 1）
 */
export const TRANSLATION_FAILED = "訳せませんでした。Translate でもう一度頼めます。";

/**
 * 拒否の種類（sendo が配る stop_details.category）の日本語。ここにない種類と空の種類は、文に添えない
 * （docs/decisions/translation.md の 1）
 */
const REFUSAL_CATEGORIES = new Map([
  ["cyber", "サイバーセキュリティ"],
  ["bio", "生物学"],
  ["frontier_llm", "AI モデルの開発"],
  ["reasoning_extraction", "推論の書き出し"],
  ["general_harms", "有害な内容"],
]);

/**
 * 記事の画面のラベルの下に出す、訳せなかった理由の文（docs/decisions/translation.md の 1。sendo の
 * translation.md の 17）。出している状態が untranslated で、理由が届いている記事だけ。頼んだ印のある
 * 間（Translating）は出さない。種類やどこで起きたかに知らない値が届いたら（版の違う sendo）、
 * そのほかの失敗の文
 */
export function translationFailureText(
  translation: ArticleTranslation | null | undefined,
): string | null {
  // 版の違うタブが代表のときは、理由の項目のない翻訳が届くことがある（undefined）
  const failure = translation?.failure;
  if (translation == null || translation.status !== "untranslated" || failure == null) return null;
  if (failure.kind !== "refused" || (failure.stage !== "batch" && failure.stage !== "on_demand")) {
    return TRANSLATION_FAILED;
  }
  const category = failure.category === null ? undefined : REFUSAL_CATEGORIES.get(failure.category);
  const refused = `${category === undefined ? "" : `${category}の`}安全策で、翻訳を断られました。`;
  return failure.stage === "batch"
    ? `${refused}Translate を押すと、断られたときに別のモデルで試します（それでも断られることがあります）。`
    : `${refused}頼み直しても、同じ結果になる見込みが高いです。`;
}
