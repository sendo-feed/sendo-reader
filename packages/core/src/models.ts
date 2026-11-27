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

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  /** アカウントで購読先を省いたときの行き先。Sendo の対応を確認するまでは省く。 */
  isDefault?: boolean;
}

export interface Feed {
  id: string;
  url: string;
  title: string | null;
  displayName: string | null;
  siteUrl: string | null;
  folderId: string | null;
  /** 購読の所属。null は未割り当て。未対応の応答から取り込んだ購読では省く。 */
  workspaceId?: string | null;
  /** 購読をやめて、購読し直すと変わる ID。 */
  subscriptionId?: string;
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

export interface FeedFetchTimes {
  /** 失敗も含む、最後の取得試行の時刻 */
  lastFetchedAt: number | null;
  /** 304 も含む、最後に取得に成功した時刻 */
  lastSuccessfulFetchAt: number | null;
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
  /**
   * sendo の翻訳（sendo の docs/decisions/translation.md の 14、docs/decisions/translation.md）。
   * 訳さない記事、訳すかどうかがまだ決まっていない記事、翻訳に対応する前の sendo からの記事は null
   */
  translation: ArticleTranslation | null;
  /**
   * この端末で頼んだ、その場の翻訳（docs/decisions/translation.md の 6。core のメモリーにだけ
   * あり、手元の DB には置かない）。requested は頼んで返事を待っている（印のある間は、翻訳の状態を
   * translating にして出す）。failed は、sendo で訳せずに戻った（失敗の文を出す）。頼んでいなければ、
   * 項目がない
   */
  translationRequest?: "requested" | "failed";
}

/** 翻訳の状態。queued は自動の翻訳を待っている、translating は訳している、translated は訳文がある */
export type TranslationStatus = "queued" | "translating" | "translated" | "untranslated";

export const TRANSLATION_STATUSES: readonly TranslationStatus[] = [
  "queued",
  "translating",
  "translated",
  "untranslated",
];

export interface ArticleTranslation {
  /** 訳すかどうかを決めたときの、記事の主言語（ISO 639-1 の小文字。判定できなければ und） */
  language: string;
  status: TranslationStatus;
  /** 訳したタイトルと要約（プレーンテキスト。信頼できないデータ）。訳文がなければ null */
  title: string | null;
  summary: string | null;
  /** 訳した時刻（ミリ秒）。訳文がなければ null */
  translatedAt: number | null;
  /**
   * 品質優先の段階で訳し直したか（sendo の docs/decisions/translation.md の 6）。訳し直せるのは、
   * translated でこれが false の記事だけ
   */
  retranslated: boolean;
  /**
   * 訳せなかった理由（sendo の docs/decisions/translation.md の 17）。sendo は untranslated の記事に
   * だけ付けて配る。理由に対応する前の sendo と、理由のない記事は null。版の違うタブが代表のときは
   * undefined のこともある
   */
  failure?: TranslationFailure | null;
  /**
   * 訳したモデルの ID（claude-haiku-5-5 など。sendo の docs/decisions/translation.md の 18）。sendo が
   * 配ったまま持ち、知らない ID も捨てない。訳文のない記事、条件に対応する前の sendo か reader の版で
   * 受けた記事は null。訳し直しの最中は、もとの訳文のモデル。版の違うタブが代表のときは undefined の
   * こともある
   */
  model?: string | null;
  /**
   * 訳したときの思考量（low ／ medium ／ high など。sendo の docs/decisions/translation.md の 9）。
   * 配ったまま持ち、知らない値も捨てない。思考量を残していない訳文は null。版の違うタブが代表のときは
   * undefined のこともある
   */
  effort?: string | null;
}

/**
 * 訳せなかった理由。値は sendo が配ったまま持ち、知らない値（版の違う sendo）も捨てない。どう出すかは
 * 画面が決める（docs/decisions/translation.md の 1。知らない値は、そのほかの失敗として出す）
 */
export interface TranslationFailure {
  /** refused（拒否された）か failed（そのほかの失敗） */
  kind: string;
  /** 拒否の種類（cyber など）。なければ null */
  category: string | null;
  /** batch（バッチ）か on_demand（その場の翻訳） */
  stage: string;
}

export type SavedPage = {
  id: string;
  url: string;
  title: string | null;
  savedAt: number;
};

/**
 * 通知のベル（sendo の docs/decisions/notifications.md の 1〜7）。購読だけのベルは words が null、
 * 言葉だけのベルは feedId と subscriptionId が null
 */
export type Bell = {
  /** まだ送っていない、付けたばかりのベルは、この端末が決めた ID（送ると sendo の ID に替わることがある） */
  id: string;
  /** 鳴らす購読の ID。購読し直すと変わる */
  subscriptionId: string | null;
  createdAt: number;
} & (
  | { feedId: string; words: null; matchKey: null }
  | {
      /** null なら言葉だけのベル（購読も言葉もないベルはない） */
      feedId: string | null;
      /** 当てる言葉（区切って、空白 1 つでつないだもの。bell-words.ts） */
      words: string;
      /** 照合用の言葉。フィードの ID と照合用の言葉が同じベルは、sendo では同じ組のベル */
      matchKey: string;
    }
);

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
  /**
   * blockquote だけ。sendo が印（`data-x-post`）を付けた X の投稿の ID（1〜20 桁の数字の文字列）。
   * 数としては扱わない（docs/decisions/embeds.md）
   */
  xPost?: string;
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

/**
 * 訳した本文の様子（docs/decisions/translation.md の 8）。どれも、頼んだ訳した時刻の訳文のもの。
 * - ready：手元にある（取った）
 * - missing：まだ手元にない（getTranslatedContent だけ）
 * - none：sendo が本文を訳さなかった。原文の本文を出す
 * - stale：sendo の訳文が、頼んだ時刻のものでない（訳し直した、なくなった）。同期で新しい時刻が
 *   届くまで、訳した要約を出しておく（fetchTranslatedContent だけ）
 */
export type TranslatedContent =
  | { status: "ready"; content: ArticleContent }
  | { status: "missing" }
  | { status: "none" }
  | { status: "stale" };

export interface UnreadCounts {
  total: number;
  /** 未読のあるフィードだけ */
  feeds: Map<string, number>;
  /** 未読のあるフォルダだけ */
  folders: Map<string, number>;
}

/** 手元の DB の表。変わったことを画面に知らせるときに使う */
export const TABLES = [
  "folders",
  "feeds",
  "articles",
  "settings",
  "savedPages",
  "workspaces",
  "bells",
] as const;

export type Table = (typeof TABLES)[number];

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
