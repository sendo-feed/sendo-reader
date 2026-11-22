import type { Executor } from "./database";

/**
 * 訳した本文の、手元の置き場（docs/decisions/translation.md の 8）。原文の本文（content.ts）とは
 * 別の表に、訳した時刻と一緒に置く。記事を手元から消すと、一緒に消える（スキーマのトリガー）。
 *
 * 置くのは、sendo から受け取った HTML（信頼できない）。html が null の行は、その時刻の訳文に本文が
 * なかった（sendo が本文を訳さなかった）印で、取り直さない。
 */

export interface StoredTranslatedContent {
  /** 訳した本文。null は、本文を訳さなかった印 */
  html: string | null;
  source: string | null;
  translatedAt: number;
}

/**
 * 記事の訳した時刻と、手元の訳した本文（時刻を問わず、置いてあるもの）。記事が手元になければ null
 */
export async function getStoredTranslatedContent(
  db: Executor,
  articleId: string,
): Promise<{ translatedAt: number | null; stored: StoredTranslatedContent | null } | null> {
  const [row] = await db.all<{
    article_translated_at: number | null;
    html: string | null;
    source: string | null;
    translated_at: number | null;
  }>(
    `select a.translated_at as article_translated_at, c.html, c.source, c.translated_at
     from articles a left join article_translation_contents c on c.article_id = a.id
     where a.id = ?`,
    [articleId],
  );
  if (row === undefined) return null;
  return {
    translatedAt: row.article_translated_at,
    stored:
      row.translated_at === null
        ? null
        : { html: row.html, source: row.source, translatedAt: row.translated_at },
  };
}

/**
 * 取った訳した本文を置く。手元に置いてある訳した本文より新しいときだけ置く（遅れて返った古い本文で
 * 上書きしない。確かめるのは、置く文の中）。置いたら true。記事が手元から消えていたら、置かない
 */
export async function putStoredTranslatedContent(
  tx: Executor,
  articleId: string,
  content: StoredTranslatedContent,
  now: number,
): Promise<boolean> {
  const rows = await tx.all<{ article_id: string }>(
    `insert into article_translation_contents (article_id, html, source, translated_at, fetched_at)
     select id, ?, ?, ?, ? from articles where id = ?
     on conflict (article_id) do update set
       html = excluded.html, source = excluded.source, translated_at = excluded.translated_at,
       fetched_at = excluded.fetched_at
     where excluded.translated_at > article_translation_contents.translated_at
     returning article_id`,
    [content.html, content.source, content.translatedAt, now, articleId],
  );
  return rows.length > 0;
}
