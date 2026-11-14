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
  folders: (Folder & { deleted: boolean })[];
  feeds: (Feed & { deleted: boolean })[];
  articles: Article[];
}
