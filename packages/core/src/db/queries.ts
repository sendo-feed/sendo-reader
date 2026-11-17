import type { Article, Feed, Folder, UnreadCounts } from "../models";
import type { Executor, SqlValue } from "./database";

/** 画面のための読み出し。手元の DB だけを読み、ネットワークは待たない */

export interface ArticleQuery {
  /** このフィードの記事だけ */
  feedId?: string;
  /** このフォルダのフィードの記事だけ */
  folderId?: string;
  /** unread なら未読だけ、read なら既読だけ、starred なら保存済みだけ */
  state?: "all" | "unread" | "read" | "starred";
  /**
   * 探す言葉。空白で区切ったすべての言葉が、タイトル・要約・著者のどれかに入っている記事だけ
   * （大文字と小文字は、ASCII の範囲で区別しない）。空なら絞らない
   */
  search?: string;
  /** 公開日時の新しい順（既定）・古い順、または既読にした日時の新しい順（既読だけ） */
  order?: "newest" | "oldest" | "recentlyRead";
  /** 1 回に読む数（1〜200、既定は 50） */
  limit?: number;
  /** 前のページの最後の記事。その続き（新しい順ならこれより古いもの、古い順なら新しいもの）を読む */
  after?: ArticleCursor;
}

/** 一覧の続き・位置の復元に使う日時。既読順では readAt も必要 */
export interface ArticleCursor {
  id: string;
  publishedAt: number;
  readAt?: number | null;
}

/** SQL の一覧と同じ並び順で比べる。負なら a が先、正なら b が先 */
export function compareArticles(
  a: ArticleCursor,
  b: ArticleCursor,
  order?: ArticleQuery["order"],
): number {
  const time = (article: ArticleCursor) =>
    order === "recentlyRead" ? (article.readAt ?? 0) : article.publishedAt;
  const difference = time(a) - time(b) || (a.id === b.id ? 0 : a.id > b.id ? 1 : -1);
  return order === "oldest" ? difference : -difference;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ArticleRow = {
  id: string;
  feed_id: string;
  url: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  thumbnail_url: string | null;
  has_content: number;
  published_at: number;
  received_at: number;
  read_at: number | null;
  starred_at: number | null;
};

const ARTICLE_COLUMNS =
  "a.id, a.feed_id, a.url, a.title, a.summary, a.author, a.thumbnail_url, a.has_content, a.published_at, a.received_at, a.read_at, a.starred_at";

/** 公開日時の新しい順・古い順、または既読にした日時の新しい順に読む。同時刻なら id で決める */
export async function listArticles(db: Executor, query: ArticleQuery = {}): Promise<Article[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (query.feedId !== undefined) {
    where.push("a.feed_id = ?");
    params.push(query.feedId);
  }
  if (query.folderId !== undefined) {
    where.push("a.feed_id in (select id from feeds where folder_id = ?)");
    params.push(query.folderId);
  }
  if (query.state === "unread") where.push("a.read_at is null");
  const recentlyRead = query.order === "recentlyRead";
  if (query.state === "read" || recentlyRead) where.push("a.read_at is not null");
  if (query.state === "starred") where.push("a.starred_at is not null");
  for (const term of searchTerms(query.search)) {
    // % と _ は、そのままの文字として探す
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      "(a.title like ? escape '\\' or a.summary like ? escape '\\' or a.author like ? escape '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  const oldest = query.order === "oldest";
  const column = recentlyRead ? "a.read_at" : "a.published_at";
  if (query.after !== undefined) {
    const time = recentlyRead ? query.after.readAt : query.after.publishedAt;
    if (time === undefined || time === null) throw new RangeError("既読順の続きには readAt が必要");
    const than = oldest ? ">" : "<";
    where.push(`(${column}, a.id) ${than} (?, ?)`);
    params.push(time, query.after.id);
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  params.push(limit);

  const rows = await db.all<ArticleRow>(
    `select ${ARTICLE_COLUMNS} from articles a
     ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
     order by ${column} ${oldest ? "asc" : "desc"}, a.id ${oldest ? "asc" : "desc"}
     limit ?`,
    params,
  );
  return rows.map(toArticle);
}

/** 探す言葉の数と長さの上限（長い入力で、手元の DB を重くしない） */
const MAX_SEARCH_TERMS = 8;
const MAX_SEARCH_TERM_LENGTH = 100;

/** 探す言葉を、空白（全角を含む）で分ける */
export function searchTerms(search: string | undefined): string[] {
  return (search ?? "")
    .split(/\s+/u)
    .filter((term) => term !== "")
    .slice(0, MAX_SEARCH_TERMS)
    .map((term) => term.slice(0, MAX_SEARCH_TERM_LENGTH));
}

/** 記事をまとめて読む（見つからない ID は飛ばす）。画面が出している記事の状態を読み直すのに使う */
export async function getArticles(db: Executor, ids: readonly string[]): Promise<Article[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<ArticleRow>(
    `select ${ARTICLE_COLUMNS} from articles a where a.id in (select value from json_each(?))`,
    [JSON.stringify(ids)],
  );
  return rows.map(toArticle);
}

export async function getArticle(db: Executor, id: string): Promise<Article | null> {
  const [row] = await db.all<ArticleRow>(
    `select ${ARTICLE_COLUMNS} from articles a where a.id = ?`,
    [id],
  );
  return row === undefined ? null : toArticle(row);
}

/** フォルダを名前の順に読む */
export async function listFolders(db: Executor): Promise<Folder[]> {
  const rows = await db.all<{ id: string; name: string; created_at: number }>(
    "select id, name, created_at from folders order by name, id",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

/** 購読しているフィードを、名前（なければ URL）の順に読む */
export async function listFeeds(db: Executor): Promise<Feed[]> {
  const rows = await db.all<{
    id: string;
    url: string;
    title: string | null;
    site_url: string | null;
    folder_id: string | null;
    icon_url: string | null;
    created_at: number;
  }>(
    `select id, url, title, site_url, folder_id, icon_url, created_at from feeds
     order by coalesce(title, url) collate nocase, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    siteUrl: row.site_url,
    folderId: row.folder_id,
    iconUrl: row.icon_url,
    createdAt: row.created_at,
  }));
}

/** 未読の数。全体、フィードごと、フォルダごと（未読のないものは含まない） */
export async function countUnread(db: Executor): Promise<UnreadCounts> {
  const rows = await db.all<{ feed_id: string; folder_id: string | null; unread: number }>(
    `select a.feed_id, f.folder_id, count(*) as unread
     from articles a left join feeds f on f.id = a.feed_id
     where a.read_at is null
     group by a.feed_id`,
  );
  const counts: UnreadCounts = { total: 0, feeds: new Map(), folders: new Map() };
  for (const row of rows) {
    counts.total += row.unread;
    counts.feeds.set(row.feed_id, row.unread);
    if (row.folder_id !== null) {
      counts.folders.set(row.folder_id, (counts.folders.get(row.folder_id) ?? 0) + row.unread);
    }
  }
  return counts;
}

/** since（ミリ秒）からあとに既読にした記事の数。今日読んだ数を出すのに使う */
export async function countReadSince(db: Executor, since: number): Promise<number> {
  const [row] = await db.all<{ n: number }>(
    "select count(*) as n from articles where read_at >= ?",
    [since],
  );
  return row?.n ?? 0;
}

function toArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    feedId: row.feed_id,
    url: row.url,
    title: row.title,
    summary: row.summary,
    author: row.author,
    thumbnailUrl: row.thumbnail_url,
    hasContent: row.has_content !== 0,
    publishedAt: row.published_at,
    receivedAt: row.received_at,
    readAt: row.read_at,
    starredAt: row.starred_at,
  };
}
