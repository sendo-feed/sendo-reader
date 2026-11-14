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
 */

/** タブから呼べる ReaderCore のメソッド。これ以外は呼ばせない */
export const READER_METHODS = [
  "isSignedIn",
  "signIn",
  "signOut",
  "countPending",
  "listFolders",
  "listFeeds",
  "listArticles",
  "getArticle",
  "countUnread",
  "setRead",
  "setStarred",
  "markAllRead",
  "createFolder",
  "renameFolder",
  "deleteFolder",
  "moveFeed",
  "unsubscribe",
  "discoverFeeds",
  "subscribe",
  "importOpml",
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
  "setRead",
  "setStarred",
  "markAllRead",
  "createFolder",
  "renameFolder",
  "deleteFolder",
  "moveFeed",
  "unsubscribe",
]);

/** 終わったらすぐ同期する（ログインした、購読した、OPML を取り込んだ、ログアウトした） */
export const SYNC_NOW_METHODS = new Set<Method>(["signIn", "signOut", "subscribe", "importOpml"]);

export type Result = { ok: true; value: unknown } | { ok: false; error: SerializedError };

export interface SerializedError {
  name: string;
  message: string;
  kind?: ApiErrorKind;
  status?: number;
  code?: string;
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

/** ワーカー ⇄ ほかのタブのワーカー（BroadcastChannel） */
export type PeerMessage =
  | { type: "call"; from: string; id: number; method: Method; args: unknown[] }
  | { type: "result"; to: string; id: number; result: Result }
  | { type: "changed"; tables: Table[] }
  | { type: "status"; status: SyncStatus }
  /** 代表になった（待っている呼び出しを、この代表に送り直す） */
  | { type: "leader"; leaderId: string }
  /** 起動した（代表がいれば、名乗り出て、今の同期の様子を送る） */
  | { type: "hello"; from: string }
  /** タブが前に出た（代表に同期を促す） */
  | { type: "visible" };

export function serializeError(error: unknown): SerializedError {
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
  const out = new Error(error.message);
  out.name = error.name;
  return out;
}
