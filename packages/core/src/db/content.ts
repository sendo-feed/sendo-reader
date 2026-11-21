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

/** 先に取っておく記事と、その記事の全文が前に取れなかったか */
export interface PrefetchTarget {
  id: string;
  /** 前に全文が取れなかった（全文は取り直さず、フィード本文だけを取る） */
  pageMissed: boolean;
}

/**
 * 本文を先に取っておく記事を、新しい順に limit 件まで選ぶ（docs/decisions/local-first.md の
 * 「記事の本文」）。未読で、手元に全文がない記事のうち、全文が取れなかった印のない記事と、
 * 印はあるがフィード本文があって手元にまだない記事（代わりのフィード本文を取り損ねた）
 */
export async function listContentsToPrefetch(
  db: Executor,
  limit: number,
): Promise<PrefetchTarget[]> {
  const rows = await db.all<{ id: string; page_missed: number }>(
    `select a.id, m.article_id is not null as page_missed
     from articles a left join article_page_misses m on m.article_id = a.id
     where a.read_at is null
       and a.id not in (select article_id from article_page_contents)
       and (
         m.article_id is null
         or (a.has_content <> 0 and a.id not in (select article_id from article_contents))
       )
     order by a.published_at desc, a.id desc
     limit ?`,
    [limit],
  );
  return rows.map((row) => ({ id: row.id, pageMissed: row.page_missed !== 0 }));
}

/** 全文が取れなかった印を置く。記事が手元から消えていたら、置かない */
export async function markPageMissing(tx: Executor, articleId: string, now: number): Promise<void> {
  await tx.run(
    `insert into article_page_misses (article_id, missed_at)
     select id, ? from articles where id = ?
     on conflict (article_id) do nothing`,
    [now, articleId],
  );
}

/** 手元に置いた本文（全文とフィード本文）の合計の大きさ（UTF-8 のバイト数） */
export async function storedContentBytes(db: Executor): Promise<number> {
  const [row] = await db.all<{ bytes: number }>(
    "select coalesce(sum(bytes), 0) as bytes from article_content_sizes",
  );
  return row?.bytes ?? 0;
}

/**
 * 手元の本文が limit（バイト）を超えていたら、既読でスターのない記事の本文から、読んだのが古い
 * 順に消して、limit 以下に収める（docs/decisions/local-first.md の「記事の本文」）。未読とスターの
 * 記事の本文と、protect の記事（最後に開いた記事、いま置いた本文の記事）の本文は消さない。
 * 収まらなければ、超えたまま。消したあとの合計を返す
 */
export async function evictContents(
  tx: Executor,
  limit: number,
  protect: readonly string[] = [],
): Promise<number> {
  let total = await storedContentBytes(tx);
  if (total <= limit) return total;
  const rows = await tx.all<{ article_id: string; source: string; bytes: number }>(
    `select s.article_id, s.source, s.bytes from article_content_sizes s
     join articles a on a.id = s.article_id
     where a.read_at is not null and a.starred_at is null
       and a.id not in (select value from json_each(?))
     order by a.read_at, a.id, s.source`,
    [JSON.stringify(protect)],
  );
  for (const row of rows) {
    if (total <= limit) break;
    const table = row.source === "page" ? "article_page_contents" : "article_contents";
    await tx.run(`delete from ${table} where article_id = ?`, [row.article_id]);
    total -= row.bytes;
  }
  return total;
}
