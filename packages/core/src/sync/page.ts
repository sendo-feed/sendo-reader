import type { Article, DeviceType, Feed, Folder, JsonValue, SavedPage, Workspace } from "../models";

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
  /**
   * 設定の項目（どの端末の種類の分も届く）。deleted なら、消した印。手元からも消す。
   * 設定を配る前の版の sendo が相手なら null
   */
  settings: SyncSetting[] | null;
  /** 保存したページ。未対応の sendo からは null */
  savedPages: SyncSavedPage[] | null;
  /** ワークスペース。未対応の Sendo からは null。 */
  workspaces: SyncWorkspace[] | null;
}

export type SyncSetting =
  | { deviceType: DeviceType; name: string; value: JsonValue; deleted: false }
  | { deviceType: DeviceType; name: string; deleted: true };

export type SyncArticle = (Article & { deleted: false }) | { id: string; deleted: true };

export type SyncSavedPage = (SavedPage & { deleted: false }) | { id: string; deleted: true };

export type SyncWorkspace = (Workspace & { deleted: false }) | { id: string; deleted: true };
