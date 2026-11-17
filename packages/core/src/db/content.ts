import type { Executor } from "./database";

export type ContentSource = "feed" | "page";

function contentTable(source: ContentSource): string {
  return source === "page" ? "article_page_contents" : "article_contents";
}

/**
 * 記事ごとに取った本文の、手元の置き場（sendo の docs/decisions/content.md の 6）。
 *
 * 置くのは、sendo から受け取った HTML（信頼できない）と、出どころ。一度受け取った本文は
 * 変わらないので、置いたら取り直さない。記事を手元から消すと、一緒に消える
 * （スキーマのトリガー）。
 */

export interface StoredContent {
  html: string;
  source: string;
}

/**
 * 本文を取りにいけるかと、手元の本文。フィードは hasContent で決め、ページは記事があれば
 * 取りにいける（取れるかは sendo の機能による）。記事が手元になければ null
 */
export async function getStoredContent(
  db: Executor,
  articleId: string,
  source: ContentSource = "feed",
): Promise<{ hasContent: boolean; stored: StoredContent | null } | null> {
  const [row] = await db.all<{ has_content: number; html: string | null; source: string | null }>(
    `select a.has_content, c.html, c.source
     from articles a left join ${contentTable(source)} c on c.article_id = a.id
     where a.id = ?`,
    [articleId],
  );
  if (row === undefined) return null;
  return {
    hasContent: source === "page" || row.has_content !== 0,
    stored:
      row.html === null || row.source === null ? null : { html: row.html, source: row.source },
  };
}

/** 取った本文を置く。記事が手元から消えていたら、置かない（false を返す） */
export async function putStoredContent(
  tx: Executor,
  articleId: string,
  content: StoredContent,
  now: number,
  source: ContentSource = "feed",
): Promise<boolean> {
  const rows = await tx.all<{ article_id: string }>(
    `insert into ${contentTable(source)} (article_id, html, source, fetched_at)
     select id, ?, ?, ? from articles where id = ?
     on conflict (article_id) do update set
       html = excluded.html, source = excluded.source, fetched_at = excluded.fetched_at
     returning article_id`,
    [content.html, content.source, now, articleId],
  );
  return rows.length > 0;
}

/**
 * sendo に本文がなかった（hasContent は true だったが、片付けの途中などで 404 が返った）記事を、
 * 本文なしにする。変えたら true
 */
export async function markContentMissing(tx: Executor, articleId: string): Promise<boolean> {
  const rows = await tx.all<{ id: string }>(
    "update articles set has_content = 0 where id = ? and has_content <> 0 returning id",
    [articleId],
  );
  return rows.length > 0;
}

/**
 * 本文を先に取っておく記事（未読で、sendo に本文があり、手元にまだない）を、新しい順に選ぶ。
 * 見るのは、未読の新しい limit 件だけ（それより古い未読は、開いたときに取る）
 */
export async function listContentToPrefetch(db: Executor, limit: number): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `select id from (
       select id, has_content, published_at from articles
       where read_at is null
       order by published_at desc, id desc
       limit ?
     )
     where has_content <> 0 and id not in (select article_id from article_contents)
     order by published_at desc, id desc`,
    [limit],
  );
  return rows.map((row) => row.id);
}
