import { ApiError, type SendoApi } from "../api/client";
import type { Database, Executor } from "../db/database";
import { deleteSetting, getSetting, setSetting } from "../db/settings";
import { CURSOR_KEY, clearSyncedRows, RESYNC_KEY } from "../db/synced";
import type { Article, Table } from "../models";
import type { SyncPage } from "./page";
import { reapplyPending } from "./queue";

/** 手元に置く既読の記事の期間。受信箱に入ってからこれより古い既読の記事は、手元から消す */
export const LOCAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 1 回の同期で取るページの上限。サーバーが続きを返し続けても止まるようにする */
const MAX_PAGES = 1000;

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
  /** 中断の合図（ログアウトなど）。中断したら、それ以降は DB に書かない */
  signal?: AbortSignal;
  /** ページを書き込むたびに呼ぶ（画面に変わった表を知らせる） */
  onPage?: (changed: Set<Table>) => void;
}

/**
 * sendo から差分を取り、手元の DB に書き込む（docs/decisions/sync.md）。
 *
 * ページごとに、行の書き込みと新しいカーソルの保存を 1 つのトランザクションで行う。途中で
 * 失敗しても、書き込んだページまでのカーソルが残るので、次はその続きから取れる。
 *
 * 届いた行は sendo の状態なので、手元でまだ送り終えていない操作は、同じトランザクションの中で
 * その上に重ね直す（楽観的な更新を保つ）。
 */
export async function pull(db: Database, api: SendoApi, options: PullOptions): Promise<PullResult> {
  const result: PullResult = { pages: 0, reset: false, changed: new Set() };
  // 断られた操作を戻せなかったときなどに、最初から取り直すよう頼まれている
  if ((await getSetting(db, RESYNC_KEY)) !== null) {
    await resync(db, api, options, result);
    return finish(db, options, result);
  }

  let cursor = await getSetting(db, CURSOR_KEY);
  while (true) {
    if (result.pages >= MAX_PAGES) {
      throw new Error(`同期が ${MAX_PAGES} ページで終わらなかった`);
    }
    let page: SyncPage;
    try {
      page = await api.sync(cursor, options.signal);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "cursor_expired") {
        // 消した印が回収され、差分を出せない。最初から取り直す
        await resync(db, api, options, result);
        break;
      }
      throw error;
    }

    const changed = await db.transaction(async (tx) => {
      // 通信を待っている間にログアウトしていたら、書かずに止める（DB の呼び出しは 1 列に並ぶ
      // ので、ここで確かめれば、ログアウトの消去のあとに書き戻すことはない）
      options.signal?.throwIfAborted();
      const changed = await applyPage(tx, page);
      await reapplyPending(tx);
      await setSetting(tx, CURSOR_KEY, page.cursor);
      return changed;
    });
    result.pages += 1;
    for (const table of changed) result.changed.add(table);
    if (changed.size > 0) options.onPage?.(changed);

    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return finish(db, options, result);
}

/**
 * 最初から取り直す。すべてのページを取り終えてから、1 つのトランザクションで手元を置き換える
 * （途中で届かなくなっても、手元の行は前のまま残る。オフラインで空にならない）。
 */
async function resync(
  db: Database,
  api: SendoApi,
  options: PullOptions,
  result: PullResult,
): Promise<void> {
  const pages: SyncPage[] = [];
  let cursor: string | null = null;
  while (true) {
    if (pages.length >= MAX_PAGES) throw new Error(`同期が ${MAX_PAGES} ページで終わらなかった`);
    const page: SyncPage = await api.sync(cursor, options.signal);
    pages.push(page);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  await db.transaction(async (tx) => {
    options.signal?.throwIfAborted();
    await clearSyncedRows(tx);
    for (const page of pages) await applyPage(tx, page);
    await reapplyPending(tx);
    if (cursor !== null) await setSetting(tx, CURSOR_KEY, cursor);
    await deleteSetting(tx, RESYNC_KEY);
  });
  result.pages += pages.length;
  result.reset = true;
  const all = new Set<Table>(["folders", "feeds", "articles"]);
  for (const table of all) result.changed.add(table);
  options.onPage?.(all);
}

async function finish(db: Database, options: PullOptions, result: PullResult) {
  if (await pruneOldArticles(db, options.now(), options.signal)) {
    result.changed.add("articles");
    options.onPage?.(new Set<Table>(["articles"]));
  }
  return result;
}

/** 同期で届いた 1 ページを書き込む。変わった表を返す */
async function applyPage(tx: Executor, page: SyncPage): Promise<Set<Table>> {
  const changed = new Set<Table>();
  // フォルダ → 購読 → 記事の順に当てる。購読をやめた印で記事を消してから、届いた記事を入れる
  for (const folder of page.folders) {
    // フォルダを消すと、入っていたフィードもフォルダなしに変わる
    if (await applyFolder(tx, folder)) changed.add("feeds");
  }
  if (page.folders.length > 0) changed.add("folders");
  for (const feed of page.feeds) {
    if (await applyFeed(tx, feed)) changed.add("articles");
  }
  if (page.feeds.length > 0) changed.add("feeds");
  for (const article of page.articles) await applyArticle(tx, article);
  if (page.articles.length > 0) changed.add("articles");
  return changed;
}

/** フォルダを書き込む。消したフォルダに入っていたフィードを動かしたら true */
async function applyFolder(tx: Executor, folder: SyncPage["folders"][number]): Promise<boolean> {
  if (folder.deleted) {
    await tx.run("delete from folders where id = ?", [folder.id]);
    // 入っていたフィードはフォルダなしに戻す（sendo と同じ決まり）
    const moved = await tx.all<{ id: string }>(
      "update feeds set folder_id = null where folder_id = ? returning id",
      [folder.id],
    );
    return moved.length > 0;
  }
  await tx.run(
    `insert into folders (id, name, created_at) values (?, ?, ?)
     on conflict (id) do update set name = excluded.name, created_at = excluded.created_at`,
    [folder.id, folder.name, folder.createdAt],
  );
  return false;
}

/** 購読を書き込む。購読をやめた印で記事を消したら true */
async function applyFeed(tx: Executor, feed: SyncPage["feeds"][number]): Promise<boolean> {
  if (feed.deleted) {
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
    [feed.id, feed.url, feed.title, feed.siteUrl, feed.folderId, feed.createdAt],
  );
  return false;
}

async function applyArticle(tx: Executor, article: Article): Promise<void> {
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
      article.publishedAt,
      article.receivedAt,
      article.readAt,
      article.starredAt,
    ],
  );
}

/**
 * 受信箱に入ってから LOCAL_RETENTION_MS より古く、既読でスターのない記事を手元から消す。
 * 手元に置くのは、最初の同期で届く範囲（未読、スター、直近 30 日）に揃える（local-first.md）。
 */
async function pruneOldArticles(
  db: Database,
  now: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    signal?.throwIfAborted();
    return tx.all<{ id: string }>(
      `delete from articles
       where received_at < ? and read_at is not null and starred_at is null
       returning id`,
      [now - LOCAL_RETENTION_MS],
    );
  });
  return removed.length > 0;
}

/** 同期済みのカーソル。まだ一度も同期していなければ null */
export function getCursor(db: Executor): Promise<string | null> {
  return getSetting(db, CURSOR_KEY);
}
