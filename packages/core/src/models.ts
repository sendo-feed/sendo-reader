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
  displayName: string | null;
  siteUrl: string | null;
  folderId: string | null;
  /**
   * アイコンの画像の URL。sendo が中継する、同じオリジンの URL（docs/decisions/images.md）。
   * 受け取ったものをそのまま <img src> に入れる（組み立てない、書き換えない、中身を読まない）
   */
  iconUrl: string | null;
  createdAt: number;
}

/** 購読の表示名。未設定なら配信元の名前か URL */
export function feedName(feed: Feed): string {
  return feed.displayName ?? feed.title ?? feed.url;
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
  /**
   * sendo に本文（HTML）がある。記事を取り込んだときに決まる。本文そのものは、記事ごとに取って
   * 手元に置く（ReaderCore の getArticleContent ／ fetchArticleContent）
   */
  hasContent: boolean;
  publishedAt: number;
  receivedAt: number;
  readAt: number | null;
  starredAt: number | null;
}

export type SavedPage = {
  id: string;
  url: string;
  title: string | null;
  savedAt: number;
};

/**
 * 記事の本文の中の要素。本文の HTML（信頼できない）を、通すと決めたタグと属性だけの木にしたもの
 * （content/parse.ts）。画面は、この木から要素を組み立てる。HTML の文字列は、画面に渡さない。
 */
export interface ContentElement {
  /** 通すと決めたタグの名前（小文字） */
  tag: string;
  children: ContentNode[];
  /** a だけ。http ／ https だと確かめた、絶対の URL */
  href?: string;
  /** img だけ。sendo の中継を通る、同じオリジンの URL（受け取ったまま） */
  src?: string;
  /** img だけ */
  alt?: string;
  /** img だけ。読み込む前に場所を取るための、もとの大きさ */
  width?: number;
  height?: number;
  /** td ／ th だけ */
  colspan?: number;
  rowspan?: number;
  /** ol だけ */
  start?: number;
}

/** 文字（プレーンテキスト）か、要素 */
export type ContentNode = string | ContentElement;

/** 記事の本文 */
export interface ArticleContent {
  nodes: ContentNode[];
  /** 出どころ。"feed" はフィードの本文、"page" は元ページの全文。知らない値も本文として出す */
  source: string;
}

/**
 * 手元の本文の様子。
 * - ready：手元にある
 * - missing：まだ手元にない（ページの全文は、sendo で取れるかを含めて確かめる必要がある）
 * - none：本文がない記事（要約を出す）
 */
export type LocalArticleContent =
  | { status: "ready"; content: ArticleContent }
  | { status: "missing" }
  | { status: "none" };

export interface UnreadCounts {
  total: number;
  /** 未読のあるフィードだけ */
  feeds: Map<string, number>;
  /** 未読のあるフォルダだけ */
  folders: Map<string, number>;
}

/** 手元の DB の表。変わったことを画面に知らせるときに使う */
export type Table = "folders" | "feeds" | "articles" | "settings" | "savedPages";

/**
 * 端末の種類。設定は、この種類ごとに sendo に預ける（docs/decisions/settings.md）。どちらとして
 * 動くかは、画面が決めて渡す
 */
export type DeviceType = "mobile" | "desktop";

export const DEVICE_TYPES: readonly DeviceType[] = ["mobile", "desktop"];

/** JSON の値 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 設定の項目。名前は reader. で始める。値の中身は、core も sendo も解釈しない */
export interface SettingItem {
  name: string;
  value: JsonValue;
}

/** 設定の変更。put は置く項目、remove は消す（既定に戻す）項目の名前 */
export interface SettingsChange {
  put?: SettingItem[];
  remove?: string[];
}
