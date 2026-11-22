import { ApiError, type ApiErrorKind } from "../api/errors";
import type { Table } from "../models";
import type { SyncStatus } from "../sync/scheduler";

/**
 * Web で、タブ（画面）・そのタブのワーカー・ほかのタブのワーカーの間でやり取りする形
 * （docs/decisions/local-first.md の「どのタブでも使えるようにする」）。
 *
 * - タブは自分のワーカーにだけ話す（postMessage）
 * - DB と同期を持つのは代表のワーカーだけ。ほかのワーカーは、頼まれたことを BroadcastChannel で
 *   代表に渡し、答えを自分のタブに返す
 * - 版の違うタブが混ざることがあるので、ワーカーどうしのやり取りには版の番号を付ける
 *   （PROTOCOL_VERSION）。タブと自分のワーカーは同じ版なので、そのやり取りには付けない
 */

/**
 * ワーカーどうしのやり取り（PeerMessage）の版の番号（docs/decisions/local-first.md の 5）。
 *
 * 頼める処理（READER_METHODS など）、その引数、答え、知らせ（変わった表、同期の様子）の形か
 * 意味を変えたときに、1 つ上げる。上げないと、版の混ざったタブが黙って誤った動きをする。
 * 上げると、番号の違うタブどうしは、読み込み直すまでやり取りしない（「版が合わない」失敗を返す）。
 * ふつうの配備では上げない（版の混ざったタブも、そのまま使える）。
 */
export const PROTOCOL_VERSION = 1;

/**
 * 代表のワーカーと、やり取りの版の番号が合わない（docs/decisions/local-first.md の 5）。
 * 頼みは処理していない。版の違うタブを読み込み直すか閉じれば、使えるようになる
 */
export class ProtocolMismatchError extends Error {
  override readonly name = "ProtocolMismatchError";
  /** 自分の番号 */
  readonly version: number;
  /** 相手の番号。相手が番号を名乗らない（この決まりより前の版）なら null */
  readonly peerVersion: number | null;

  constructor(peerVersion: number | null, version: number = PROTOCOL_VERSION) {
    super(
      peerVersion === null
        ? "版の違うタブが開いているため、使えません（相手の版の番号なし）"
        : `版の違うタブが開いているため、使えません（自分の版の番号 ${version}、相手 ${peerVersion}）`,
    );
    this.version = version;
    this.peerVersion = peerVersion;
  }
}

/** タブから呼べる ReaderCore のメソッド。これ以外は呼ばせない */
export const READER_METHODS = [
  "isSignedIn",
  "currentUser",
  "restoreSession",
  "prepareSignIn",
  "signOut",
  "countPending",
  "listFolders",
  "listFeeds",
  "listLatestArticleDates",
  "getFeedFetchTimes",
  "listArticles",
  "listSavedPages",
  "getSavedPageForUrl",
  "savePage",
  "unsavePage",
  "recordArticleOpen",
  "getArticle",
  "getArticles",
  "getArticleContent",
  "fetchArticleContent",
  "getContentStorage",
  "setContentStorageLimit",
  "setOpenList",
  "countUnread",
  "countReadSince",
  "setRead",
  "setReadMany",
  "setStarred",
  "markAllRead",
  "createFolder",
  "renameFolder",
  "deleteFolder",
  "moveFeed",
  "renameFeed",
  "unsubscribe",
  "unsubscribeDiscord",
  "disconnectDiscord",
  "listSettings",
  "changeSettings",
  "seedSettings",
  "refreshFeedFetchTimes",
  "discoverFeeds",
  "subscribe",
  "importOpml",
  "requestTranslation",
] as const;

export type ReaderMethod = (typeof READER_METHODS)[number];

/** ReaderCore のほかに、ワーカーが受ける呼び出し */
export type WorkerMethod = "syncNow" | "status";

export type Method = ReaderMethod | WorkerMethod;

const METHODS = new Set<string>([...READER_METHODS, "syncNow", "status"]);

export function isMethod(value: unknown): value is Method {
  return typeof value === "string" && METHODS.has(value);
}

/** 手元にすぐ反映する書き込み。あとで送るので、少し待ってから同期する */
export const WRITE_METHODS = new Set<Method>([
  "savePage",
  "unsavePage",
  "recordArticleOpen",
  "setRead",
  "setReadMany",
  "setStarred",
  "markAllRead",
  "createFolder",
  "renameFolder",
  "deleteFolder",
  "moveFeed",
  "renameFeed",
  "unsubscribe",
  "changeSettings",
]);

/**
 * 終わったらすぐ同期する（タブを開いた・ログインから戻った、購読した、OPML を取り込んだ、
 * ログアウトした）。ログインし直して戻ったタブが代表でなくても、止まっていた同期を再開する
 */
export const SYNC_NOW_METHODS = new Set<Method>([
  "restoreSession",
  "signOut",
  "subscribe",
  "importOpml",
  // 頼んだ印は、受け付けたあとに始めた同期が終わったときに外す（docs/decisions/translation.md の 6）
  "requestTranslation",
  "unsubscribeDiscord",
  "disconnectDiscord",
  // 移行待ちの設定は、同期を終えたときに送る
  "seedSettings",
]);

export type Result = { ok: true; value: unknown } | { ok: false; error: SerializedError };

export interface SerializedError {
  name: string;
  message: string;
  kind?: ApiErrorKind;
  status?: number;
  code?: string;
  /** ProtocolMismatchError の、受け取る側から見た相手（代表）の番号 */
  peerVersion?: number | null;
}

/** タブ → 自分のワーカー */
export type TabMessage =
  | { type: "call"; id: number; method: Method; args: unknown[] }
  /** タブが前に出た。しばらく同期していなければ同期してほしい */
  | { type: "visible" };

/** ワーカー → 自分のタブ */
export type WorkerMessage =
  | { type: "result"; id: number; result: Result }
  | { type: "changed"; tables: Table[] }
  | { type: "status"; status: SyncStatus };

/**
 * ワーカー ⇄ ほかのタブのワーカー（BroadcastChannel）。
 *
 * 頼み、知らせ、名乗りには version（PROTOCOL_VERSION）を付ける。この決まりより前の版のワーカー
 * は付けないので、受けるときは付いていない形も考える。hello、visible、result は、番号を確かめず
 * に受ける（result は、番号を確かめてから送った頼みにだけ届く）
 */
export type PeerMessage =
  | { type: "call"; version?: number; from: string; id: number; method: Method; args: unknown[] }
  | { type: "result"; to: string; id: number; result: Result }
  | { type: "changed"; version?: number; tables: Table[] }
  | { type: "status"; version?: number; status: SyncStatus }
  /** 代表になった（番号が合えば、待っている呼び出しを、この代表に送り直す） */
  | { type: "leader"; version?: number; leaderId: string }
  /** 起動した（代表がいれば、名乗り出て、今の同期の様子を送る） */
  | { type: "hello"; from: string }
  /** タブが前に出た（代表に同期を促す） */
  | { type: "visible" };

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ProtocolMismatchError) {
    return { name: error.name, message: error.message, peerVersion: error.peerVersion };
  }
  if (error instanceof ApiError) {
    const out: SerializedError = { name: "ApiError", message: error.message, kind: error.kind };
    if (error.status !== undefined) out.status = error.status;
    if (error.code !== undefined) out.code = error.code;
    return out;
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

/** ワーカーから届いた失敗を、画面で instanceof や kind で見分けられる形に戻す */
export function deserializeError(error: SerializedError): Error {
  if (error.name === "ApiError" && error.kind !== undefined) {
    return new ApiError(error.kind, error.message, error.status, error.code);
  }
  if (error.name === "RangeError") return new RangeError(error.message);
  if (error.name === "ProtocolMismatchError") {
    // 自分の番号は、受け取ったタブの番号（ワーカーとタブは同じ版）
    return new ProtocolMismatchError(
      typeof error.peerVersion === "number" ? error.peerVersion : null,
    );
  }
  const out = new Error(error.message);
  out.name = error.name;
  return out;
}
