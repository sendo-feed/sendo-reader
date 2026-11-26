import { ApiError, type SendoApi } from "../api/client";
import { clearBells, putBell, removeBell } from "../db/bells";
import type { Database, Executor, SqlValue } from "../db/database";
import { putFeed } from "../db/feeds";
import { clearSavedPages, putSavedPage, removeSavedPage } from "../db/saved-pages";
import { deleteSetting, getSetting, setSetting } from "../db/settings";
import {
  COMPLETE_CURSOR_KEY,
  CURSOR_KEY,
  clearSyncedRows,
  markSyncComplete,
  RESYNC_KEY,
} from "../db/synced";
import { clearSyncedSettings, putSyncedSetting, removeSyncedSetting } from "../db/synced-settings";
import {
  CONFIRMED_WORKSPACE_DEFAULT_KEY,
  finishWorkspaceDefaults,
  putWorkspace,
  setDefaultWorkspaceOnSubscribe,
  setWorkspacesAvailable,
  workspacesAvailable,
} from "../db/workspaces";
import { type Article, TABLES, type Table } from "../models";
import { readWorkspaceDefault } from "./ops";
import type { SyncPage } from "./page";
import { reapplyPending, reconcilePendingMarkRead } from "./queue";

/** 1 回の同期で取るページの上限。サーバーが続きを返し続けても止まるようにする */
const MAX_PAGES = 1000;

export interface PullResult {
  /** 取ったページの数 */
  pages: number;
  /** カーソルが読めないと言われた（または頼まれた）ので、最初から同期し直した */
  reset: boolean;
  /** 中身が変わった表 */
  changed: Set<Table>;
}

export interface PullOptions {
  /** 中断の合図（ログアウトなど）。中断したら、それ以降は DB に書かない */
  signal?: AbortSignal;
  /** ページを書き込むたびに呼ぶ（画面に変わった表を知らせる） */
  onPage?: (changed: Set<Table>) => void;
  /**
   * 最後まで同期し終えたときに、最後のページの書き込みと同じトランザクションの中で呼ぶ。
   * settings は、sendo が設定を配っているか（配る前の版なら false）。表を変えたら、その表を返す
   */
  onComplete?: (tx: Executor, info: { settings: boolean }) => Promise<Iterable<Table>>;
}

/**
 * sendo から差分を取り、手元の DB に書き込む（docs/decisions/sync.md）。
 *
 * ページごとに、行の書き込みと新しいカーソルの保存を 1 つのトランザクションで行う。途中で
 * 失敗しても、書き込んだページまでのカーソルが残るので、次はその続きから取れる。
 *
 * 届いた行は sendo の状態なので、手元でまだ送り終えていない操作は、同じトランザクションの中で
 * その上に重ね直す（楽観的な更新を保つ）。
 *
 * 古くなっても、手元では記事を消さない。sendo の片付けで受信箱から消えた記事は、消した記録が
 * 届いたときに消す（docs/decisions/local-first.md の 3）。
 */
export async function pull(db: Database, api: SendoApi, options: PullOptions): Promise<PullResult> {
  const result: PullResult = { pages: 0, reset: false, changed: new Set() };
  // 断られた操作を戻せなかったときなどに、最初から取り直すよう頼まれている
  if ((await getSetting(db, RESYNC_KEY)) !== null) {
    await resync(db, api, options, result);
    return result;
  }

  let cursor = await getSetting(db, CURSOR_KEY);
  const bootstrap =
    cursor !== null &&
    (await workspacesAvailable(db)) &&
    (await getSetting(db, CONFIRMED_WORKSPACE_DEFAULT_KEY)) === null
      ? await readWorkspaceDefault(api, options.signal)
      : undefined;
  while (true) {
    if (result.pages >= MAX_PAGES) {
      throw new Error(`同期が ${MAX_PAGES} ページで終わらなかった`);
    }
    let page: SyncPage;
    try {
      page = await api.sync(cursor, options.signal);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "cursor_invalid") {
        // 消した印が回収されて差分を出せない、カーソルの形が変わった、など。最初から取り直す
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
      if (await reconcilePendingMarkRead(tx, page.articles, !page.hasMore)) {
        changed.add("articles");
      }
      if (
        !page.hasMore &&
        (await finishWorkspaceDefaults(tx, page.workspaces !== null, bootstrap))
      ) {
        changed.add("workspaces");
      }
      if (await reapplyPending(tx)) changed.add("workspaces");
      await setSetting(tx, CURSOR_KEY, page.cursor);
      if (!page.hasMore) {
        await markSyncComplete(tx, page.cursor);
        const more = await options.onComplete?.(tx, { settings: page.settings !== null });
        for (const table of more ?? []) changed.add(table);
      }
      return changed;
    });
    result.pages += 1;
    for (const table of changed) result.changed.add(table);
    if (changed.size > 0) options.onPage?.(changed);

    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return result;
}

/**
 * 最初から取り直す。すべてのページを取り終えてから、1 つのトランザクションで手元を置き換える
 * （途中で届かなくなっても、手元の行は前のまま残る。オフラインで空にならない）。
 *
 * 手元に置いた本文は、記事の行と一緒に捨てる（開いたときに取り直す）。sendo が画像の署名の鍵を
 * 作り直すと、本文の中の画像の URL が使えなくなるため（sendo の docs/decisions/content.md の 7）。
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
    // まだ送っていない操作が指す記事は、取り直した中になくても残す（最初の同期の範囲の外の
    // 古い記事にスターを付けた、など。消すと、重ね直す先がなくなる）
    const kept = await tx.all<Record<string, SqlValue>>(
      `select * from articles where id in (
         select json_extract(payload, '$.articleId') from pending_ops
         union
         select value from pending_ops, json_each(json_extract(payload, '$.articleIds'))
         where kind <> 'markWorkspaceRead' or json_extract(payload, '$.acknowledged') is not 1
       )`,
    );
    await clearSyncedRows(tx);
    // 設定も、届いたもので置き換える（設定を配る前の版の sendo が相手なら、手元のまま残す）
    const settings = pages.some((page) => page.settings !== null);
    if (settings) await clearSyncedSettings(tx);
    if (pages.some((page) => page.savedPages !== null)) await clearSavedPages(tx);
    if (pages.some((page) => page.bells !== null)) await clearBells(tx);
    for (const page of pages) {
      await applyPage(tx, page);
      await reconcilePendingMarkRead(tx, page.articles);
    }
    for (const row of kept) {
      const columns = Object.keys(row);
      await tx.run(
        `insert into articles (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})
         on conflict (id) do nothing`,
        columns.map((column) => row[column] ?? null),
      );
    }
    if (cursor !== null) await reconcilePendingMarkRead(tx, [], true);
    await finishWorkspaceDefaults(tx, pages.at(-1)?.workspaces != null);
    await reapplyPending(tx);
    if (cursor !== null) {
      await setSetting(tx, CURSOR_KEY, cursor);
      await markSyncComplete(tx, cursor);
      await options.onComplete?.(tx, { settings });
    }
    await deleteSetting(tx, RESYNC_KEY);
  });
  result.pages += pages.length;
  result.reset = true;
  const all = new Set<Table>(TABLES);
  for (const table of all) result.changed.add(table);
  options.onPage?.(all);
}

/** 同期で届いた 1 ページを書き込む。変わった表を返す */
async function applyPage(tx: Executor, page: SyncPage): Promise<Set<Table>> {
  const changed = new Set<Table>();
  // 表ごとに、届いた順（sendo の変更番号の順）に当てる。手元の行を消すのは、その行の消した印や
  // 消した記録が届いたときだけ（表をまたいだ順序は保証されないので、ほかの表の変化からは消さない）
  for (const folder of page.folders) {
    // フォルダを消すと、入っていたフィードもフォルダなしに変わる
    if (await applyFolder(tx, folder)) changed.add("feeds");
  }
  if (page.folders.length > 0) changed.add("folders");
  for (const workspace of page.workspaces ?? []) {
    if (workspace.deleted) await tx.run("delete from workspaces where id = ?", [workspace.id]);
    else await putWorkspace(tx, workspace);
  }
  const availabilityChanged = await setWorkspacesAvailable(tx, page.workspaces !== null);
  const subscriptionDefaultChanged = await setDefaultWorkspaceOnSubscribe(
    tx,
    page.defaultWorkspaceOnSubscribe,
  );
  if (availabilityChanged || subscriptionDefaultChanged || (page.workspaces?.length ?? 0) > 0) {
    changed.add("workspaces");
  }
  for (const feed of page.feeds) await applyFeed(tx, feed);
  if (page.feeds.length > 0) changed.add("feeds");
  for (const article of page.articles) await applyArticle(tx, article);
  if (page.articles.length > 0) changed.add("articles");
  // 配列は変更番号の順。同じ項目が続けて来たら、後のものが残る
  for (const setting of page.settings ?? []) {
    if (setting.deleted) await removeSyncedSetting(tx, setting.deviceType, setting.name);
    else await putSyncedSetting(tx, setting.deviceType, setting.name, setting.value);
  }
  if ((page.settings?.length ?? 0) > 0) changed.add("settings");
  for (const saved of page.savedPages ?? []) {
    if (saved.deleted) await removeSavedPage(tx, saved.id);
    else await putSavedPage(tx, saved);
  }
  if ((page.savedPages?.length ?? 0) > 0) changed.add("savedPages");
  for (const bell of page.bells ?? []) {
    if (bell.deleted) await removeBell(tx, bell.id);
    else await putBell(tx, bell);
  }
  if ((page.bells?.length ?? 0) > 0) changed.add("bells");
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

/** 購読を書き込む */
async function applyFeed(tx: Executor, feed: SyncPage["feeds"][number]): Promise<void> {
  if (feed.deleted) {
    // 記事は消さない。受信箱から消えた記事は、記事ごとの消した記録で届く（sync.md の 3）
    await tx.run("delete from feeds where id = ?", [feed.id]);
    return;
  }
  await putFeed(tx, feed);
}

/** 記事を書き込むか、受信箱から消えた記録なら手元から消す */
async function applyArticle(tx: Executor, article: SyncPage["articles"][number]): Promise<void> {
  if (article.deleted) {
    // 手元に置いた本文も、一緒に消える（スキーマのトリガー）
    await tx.run("delete from articles where id = ?", [article.id]);
    return;
  }
  await writeArticle(tx, article);
}

/**
 * 届いた記事を書き込む。最後まで同期し終えるまでは、そのカーソルの範囲の外として扱う
 * （read_synced = 0。終えたら markSyncComplete が 1 にする）
 */
async function writeArticle(tx: Executor, article: Article): Promise<void> {
  await tx.run(
    `insert into articles (
       id, feed_id, url, title, summary, author, thumbnail_url, has_content, published_at,
       received_at, read_at, starred_at, translation_status, translation_language,
       translation_title, translation_summary, translated_at, translation_retranslated,
       translation_failure_kind, translation_failure_category, translation_failure_stage,
       translation_model, translation_effort, read_synced
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     on conflict (id) do update set
       feed_id = excluded.feed_id, url = excluded.url, title = excluded.title,
       summary = excluded.summary, author = excluded.author,
       thumbnail_url = excluded.thumbnail_url, has_content = excluded.has_content,
       published_at = excluded.published_at, received_at = excluded.received_at,
       read_at = excluded.read_at, starred_at = excluded.starred_at,
       translation_status = excluded.translation_status,
       translation_language = excluded.translation_language,
       translation_title = excluded.translation_title,
       translation_summary = excluded.translation_summary,
       translated_at = excluded.translated_at,
       translation_retranslated = excluded.translation_retranslated,
       translation_failure_kind = excluded.translation_failure_kind,
       translation_failure_category = excluded.translation_failure_category,
       translation_failure_stage = excluded.translation_failure_stage,
       translation_model = excluded.translation_model,
       translation_effort = excluded.translation_effort, read_synced = 0`,
    [
      article.id,
      article.feedId,
      article.url,
      article.title,
      article.summary,
      article.author,
      article.thumbnailUrl,
      article.hasContent ? 1 : 0,
      article.publishedAt,
      article.receivedAt,
      article.readAt,
      article.starredAt,
      article.translation?.status ?? null,
      article.translation?.language ?? null,
      article.translation?.title ?? null,
      article.translation?.summary ?? null,
      article.translation?.translatedAt ?? null,
      article.translation?.retranslated === true ? 1 : 0,
      article.translation?.failure?.kind ?? null,
      article.translation?.failure?.category ?? null,
      article.translation?.failure?.stage ?? null,
      article.translation?.model ?? null,
      article.translation?.effort ?? null,
    ],
  );
}

/**
 * 最後まで（hasMore が false になるまで）同期し終えたカーソル。まとめて既読の境界に使う。
 * まだ一度も終えていなければ null
 */
export function getCompleteCursor(db: Executor): Promise<string | null> {
  return getSetting(db, COMPLETE_CURSOR_KEY);
}
