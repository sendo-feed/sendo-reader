import type { Executor } from "./database";
import { deleteSetting } from "./settings";

/** 同期のカーソルを置く設定の鍵 */
export const CURSOR_KEY = "sync.cursor";

/**
 * 同期で届いた行（記事、購読、フォルダ）とカーソルを消す。次の同期は最初から取り直し、
 * sendo の状態に揃う。トークンと、まだ送り終えていない操作は残す（取り直した行の上に重ね直す）。
 */
export async function clearSyncedRows(tx: Executor): Promise<void> {
  await tx.run("delete from articles");
  await tx.run("delete from feeds");
  await tx.run("delete from folders");
  await deleteSetting(tx, CURSOR_KEY);
}
