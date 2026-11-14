import { ApiError, type SendoApi } from "../api/client";
import type { SyncArticle, SyncFeed, SyncFolder, SyncResponse } from "../api/sync-contract";
import type { Database, Executor } from "../db/database";
import { deleteSetting, getSetting, setSetting } from "../db/settings";
import type { Table } from "../models";

/** 手元に置く既読の記事の期間。受信箱に入ってからこれより古い既読の記事は、手元から消す */
export const LOCAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 1 回の同期で取るページの上限。サーバーが続きを返し続けても止まるようにする */
const MAX_PAGES = 1000;

const CURSOR_KEY = "sync.cursor";

export interface PullResult {
  /** 取ったページの数 */
  pages: number;
  /** カーソルが古すぎて、最初から同期し直した */
  reset: boolean;
  /** 中身が変わった表 */
  changed: Set<Table>;
}

export interface PullOptions {
  now: () => number;
  /** ページを書き込むたびに呼ぶ（画面に変わった表を知らせる） */
  onPage?: (changed: Set<Table>) => void;
}

/**
 * sendo から差分を取り、手元の DB に書き込む（docs/decisions/sync.md）。
 *
 * ページごとに、行の書き込みと新しいカーソルの保存を 1 つのトランザクションで行う。途中で
 * 失敗しても、書き込んだページまでのカーソルが残るので、次はその続きから取れる。
 */
export async function pull(db: Database, api: SendoApi, options: PullOptions): Promise<PullResult> {
  const result: PullResult = { pages: 0, reset: false, changed: new Set() };
  let cursor = await getSetting(db, CURSOR_KEY);

  while (true) {
    if (result.pages >= MAX_PAGES) {
      throw new Error(`同期が ${MAX_PAGES} ページで終わらなかった`);
    }
    let page: SyncResponse;
    try {
      page = await api.sync(cursor);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "cursor_expired" && !result.reset) {
        // 消した印が回収され、差分を出せない。手元を空にして最初から取り直す
        await clearSyncedData(db);
        for (const table of ["folders", "feeds", "articles"] as const) result.changed.add(table);
        options.onPage?.(new Set(result.changed));
        cursor = null;
        result.reset = true;
        continue;
      }
      throw error;
    }

    const changed = await db.transaction(async (tx) => {
      const changed = await applyPage(tx, page);
      await setSetting(tx, CURSOR_KEY, page.cursor);
      return changed;
    });
    result.pages += 1;
    for (const table of changed) result.changed.add(table);
    if (changed.size > 0) options.onPage?.(changed);

    cursor = page.cursor;
    if (!page.hasMore) break;
  }

  if (await pruneOldArticles(db, options.now())) {
    result.changed.add("articles");
    options.onPage?.(new Set<Table>(["articles"]));
  }
  return result;
}

/** 同期で届いた 1 ページを書き込む。変わった表を返す */
async function applyPage(tx: Executor, page: SyncResponse): Promise<Set<Table>> {
  const changed = new Set<Table>();
  // フォルダ → 購読 → 記事の順に当てる。購読をやめた印で記事を消してから、届いた記事を入れる
  for (const folder of page.folders) await applyFolder(tx, folder);
  if (page.folders.length > 0) changed.add("folders");
  for (const feed of page.feeds) {
    if (await applyFeed(tx, feed)) changed.add("articles");
  }
  if (page.feeds.length > 0) changed.add("feeds");
  for (const article of page.articles) await applyArticle(tx, article);
  if (page.articles.length > 0) changed.add("articles");
  return changed;
}

async function applyFolder(tx: Executor, folder: SyncFolder): Promise<void> {
  if (folder.deletedAt !== null) {
    await tx.run("delete from folders where id = ?", [folder.id]);
    // 入っていたフィードはフォルダなしに戻す（sendo と同じ決まり）
    await tx.run("update feeds set folder_id = null where folder_id = ?", [folder.id]);
    return;
  }
  await tx.run(
    `insert into folders (id, name, created_at) values (?, ?, ?)
     on conflict (id) do update set name = excluded.name, created_at = excluded.created_at`,
    [folder.id, folder.name, time(folder.createdAt)],
  );
}

/** 購読を書き込む。購読をやめた印で記事を消したら true */
async function applyFeed(tx: Executor, feed: SyncFeed): Promise<boolean> {
  if (feed.deletedAt !== null) {
    await tx.run("delete from feeds where id = ?", [feed.id]);
    // 購読をやめたフィードの記事は、スターを付けたもの以外を手元から消す（sync.md）
    const removed = await tx.all<{ id: string }>(
      "delete from articles where feed_id = ? and starred_at is null returning id",
      [feed.id],
    );
    return removed.length > 0;
  }
  await tx.run(
    `insert into feeds (id, url, title, site_url, folder_id, created_at) values (?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       url = excluded.url, title = excluded.title, site_url = excluded.site_url,
       folder_id = excluded.folder_id, created_at = excluded.created_at`,
    [feed.id, feed.url, feed.title, feed.siteUrl, feed.folderId, time(feed.createdAt)],
  );
  return false;
}

async function applyArticle(tx: Executor, article: SyncArticle): Promise<void> {
  await tx.run(
    `insert into articles (
       id, feed_id, url, title, summary, author, published_at, received_at, read_at, starred_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       feed_id = excluded.feed_id, url = excluded.url, title = excluded.title,
       summary = excluded.summary, author = excluded.author,
       published_at = excluded.published_at, received_at = excluded.received_at,
       read_at = excluded.read_at, starred_at = excluded.starred_at`,
    [
      article.id,
      article.feedId,
      article.url,
      article.title,
      article.summary,
      article.author,
      time(article.publishedAt),
      time(article.receivedAt),
      nullableTime(article.readAt),
      nullableTime(article.starredAt),
    ],
  );
}

/**
 * 受信箱に入ってから LOCAL_RETENTION_MS より古く、既読でスターのない記事を手元から消す。
 * 手元に置くのは、最初の同期で届く範囲（未読、スター、直近 30 日）に揃える（local-first.md）。
 */
async function pruneOldArticles(db: Database, now: number): Promise<boolean> {
  const removed = await db.all<{ id: string }>(
    `delete from articles
     where received_at < ? and read_at is not null and starred_at is null
     returning id`,
    [now - LOCAL_RETENTION_MS],
  );
  return removed.length > 0;
}

/** 同期で届いたデータとカーソルを消す（トークンなどの設定は残す） */
export async function clearSyncedData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("delete from articles");
    await tx.run("delete from feeds");
    await tx.run("delete from folders");
    await deleteSetting(tx, CURSOR_KEY);
  });
}

/** 同期済みのカーソル。まだ一度も同期していなければ null */
export function getCursor(db: Executor): Promise<string | null> {
  return getSetting(db, CURSOR_KEY);
}

function time(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`時刻として読めない：${iso}`);
  return value;
}

function nullableTime(iso: string | null): number | null {
  return iso === null ? null : time(iso);
}
