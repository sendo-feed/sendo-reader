import type { Executor } from "./database";
import { deleteSetting, setSetting } from "./settings";

/** 同期のカーソルを置く設定の鍵 */
export const CURSOR_KEY = "sync.cursor";

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
}
