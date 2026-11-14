import type { Executor } from "./database";
import { deleteSetting, setSetting } from "./settings";

/** 同期のカーソル（最後に書き込んだページのもの）を置く設定の鍵 */
export const CURSOR_KEY = "sync.cursor";

/**
 * 最後まで（hasMore が false になるまで）同期し終えた応答のカーソル。まとめて既読の境界に
 * 使えるのはこれだけ（途中のカーソルは、sendo が sync_incomplete で断る）
 */
export const COMPLETE_CURSOR_KEY = "sync.completeCursor";

/** 次の同期で最初から取り直す印 */
export const RESYNC_KEY = "sync.resync";

/**
 * 次の同期で、最初から取り直すよう頼む。手元の行は、取り直し終えるまで残す
 * （戻し方の決まっていない操作を sendo に断られたとき）
 */
export async function requestResync(tx: Executor): Promise<void> {
  await setSetting(tx, RESYNC_KEY, "1");
}

/**
 * 同期で届いた行（記事、購読、フォルダ）とカーソルを消す（最初から取り直した行で置き換えるとき）。
 * トークンと、まだ送り終えていない操作は残す（取り直した行の上に重ね直す）。
 */
export async function clearSyncedRows(tx: Executor): Promise<void> {
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await deleteSetting(tx, CURSOR_KEY);
  await deleteSetting(tx, COMPLETE_CURSOR_KEY);
}

/**
 * 最後まで同期し終えたことを記録する。手元の記事の既読・未読は、このカーソルの時点の sendo と
 * 同じになる。ただし、まだ送り終えていない操作で既読・未読を変えた記事は除く。
 * 同期のページの書き込みと、操作の重ね直しと同じトランザクションの中で呼ぶ。
 */
export async function markSyncComplete(tx: Executor, cursor: string): Promise<void> {
  await setSetting(tx, COMPLETE_CURSOR_KEY, cursor);
  await tx.run("update articles set read_synced = 1 where read_synced = 0");
  await tx.run(
    `update articles set read_synced = 0 where id in (
       select json_extract(payload, '$.articleId') from pending_ops
       where kind = 'setArticleState' and json_extract(payload, '$.read') is not null
       union
       select value from pending_ops, json_each(json_extract(payload, '$.articleIds'))
       where kind = 'markRead'
     )`,
  );
}
