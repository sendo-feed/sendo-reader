import type { Article, Feed, Folder } from "../models";

/**
 * 差分同期の 1 ページ（core の中の形）。sendo の応答の形からの変換は API の境界
 * （api/sync-contract.ts）で行い、同期のロジックはこの形だけを扱う。時刻はミリ秒の数。
 */
export interface SyncPage {
  /** 次に送るカーソル。中身は解釈しない */
  cursor: string;
  /** 続きがある */
  hasMore: boolean;
  /** deleted なら、消した印。手元からも消す */
  folders: (Folder & { deleted: boolean })[];
  /** deleted なら、購読をやめた印。手元の購読を消す（記事は消さない） */
  feeds: (Feed & { deleted: boolean })[];
  /** 受信箱の記事か、受信箱から消えた記録 */
  articles: SyncArticle[];
}

export type SyncArticle = (Article & { deleted: false }) | { id: string; deleted: true };
