import type { Article, Feed, Folder, UnreadCounts } from "../models";
import type { Executor, SqlValue } from "./database";

/** 画面のための読み出し。手元の DB だけを読み、ネットワークは待たない */

export interface ArticleQuery {
  /** このフィードの記事だけ */
  feedId?: string;
  /** このフォルダのフィードの記事だけ */
  folderId?: string;
  /** unread なら未読だけ、starred ならスター付きだけ */
  state?: "all" | "unread" | "starred";
  /** 1 回に読む数（1〜200、既定は 50） */
  limit?: number;
  /** 前のページの最後の記事。これより古いものを読む */
  after?: { publishedAt: number; id: string };
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
  published_at: number;
  received_at: number;
  read_at: number | null;
  starred_at: number | null;
};

const ARTICLE_COLUMNS =
  "a.id, a.feed_id, a.url, a.title, a.summary, a.author, a.published_at, a.received_at, a.read_at, a.starred_at";

/** 記事を新しい順に読む（公開日時、同じなら id の大きい順） */
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
  if (query.state === "starred") where.push("a.starred_at is not null");
  if (query.after !== undefined) {
    where.push("(a.published_at < ? or (a.published_at = ? and a.id < ?))");
    params.push(query.after.publishedAt, query.after.publishedAt, query.after.id);
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  params.push(limit);

  const rows = await db.all<ArticleRow>(
    `select ${ARTICLE_COLUMNS} from articles a
     ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
     order by a.published_at desc, a.id desc
     limit ?`,
    params,
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
    created_at: number;
  }>(
    `select id, url, title, site_url, folder_id, created_at from feeds
     order by coalesce(title, url) collate nocase, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    siteUrl: row.site_url,
    folderId: row.folder_id,
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

function toArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    feedId: row.feed_id,
    url: row.url,
    title: row.title,
    summary: row.summary,
    author: row.author,
    publishedAt: row.published_at,
    receivedAt: row.received_at,
    readAt: row.read_at,
    starredAt: row.starred_at,
  };
}
