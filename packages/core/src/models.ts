/**
 * 画面に渡すデータの形。時刻はミリ秒の数（Date.now() と同じ）。
 *
 * 記事のタイトル・要約・著者は、外から来た信頼できないプレーンテキスト。画面では HTML として
 * 出さず、URL は toSafeHttpUrl を通してからリンクにする。
 */

/** sendo にログインしているユーザー（GET /me） */
export interface User {
  id: string;
  email: string;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Feed {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  folderId: string | null;
  /**
   * アイコンの画像の URL。sendo が中継する、同じオリジンの URL（docs/decisions/images.md）。
   * 受け取ったものをそのまま <img src> に入れる（組み立てない、書き換えない、中身を読まない）
   */
  iconUrl: string | null;
  createdAt: number;
}

export interface Article {
  id: string;
  feedId: string;
  url: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  /** サムネイルの画像の URL。フィードの iconUrl と同じく、受け取ったものをそのまま使う */
  thumbnailUrl: string | null;
  publishedAt: number;
  receivedAt: number;
  readAt: number | null;
  starredAt: number | null;
}

export interface UnreadCounts {
  total: number;
  /** 未読のあるフィードだけ */
  feeds: Map<string, number>;
  /** 未読のあるフォルダだけ */
  folders: Map<string, number>;
}

/** 手元の DB の表。変わったことを画面に知らせるときに使う */
export type Table = "folders" | "feeds" | "articles";
