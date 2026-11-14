/**
 * 差分同期（GET /api/v1/sync）の応答の形。
 *
 * sendo の差分同期の決定（docs/decisions/sync.md）に沿った「仮の形」。sendo の OpenAPI に
 * /sync が入ったら、ここは生成した型（schema.gen.ts）に置き換え、この形との違いを直す。
 * 仮の形を使うのはこのファイルと api/client.ts の sync() だけにして、置き換えを小さくする。
 *
 * - カーソルの中身は解釈しない。受け取ったものをそのまま次に送る
 * - カーソルなしで呼ぶと、最初の同期（未読、スター、直近 30 日に受信箱に入った記事）
 * - hasMore が true なら、返ってきたカーソルですぐ続きを取る
 * - 消したフォルダと購読は deletedAt の付いた行で届く
 * - カーソルが古すぎて差分を出せないときは 410 と error.code = "cursor_expired"。最初から同期し直す
 */

import type { SyncPage } from "../sync/page";
import { ApiError } from "./errors";

export interface SyncResponse {
  cursor: string;
  hasMore: boolean;
  folders: SyncFolder[];
  feeds: SyncFeed[];
  articles: SyncArticle[];
}

export interface SyncFolder {
  id: string;
  name: string;
  createdAt: string;
  /** 消したなら、その時刻 */
  deletedAt: string | null;
}

/** 購読しているフィード。id は REST API の /feeds/{id} と同じ */
export interface SyncFeed {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  folderId: string | null;
  createdAt: string;
  /** 購読をやめたなら、その時刻 */
  deletedAt: string | null;
}

/** 受信箱の記事。記事の本体と、既読・スター */
export interface SyncArticle {
  id: string;
  feedId: string;
  /** http ／ https の URL だけ */
  url: string | null;
  /** プレーンテキスト */
  title: string | null;
  /** プレーンテキスト */
  summary: string | null;
  author: string | null;
  publishedAt: string;
  /** 受信箱に入った時刻 */
  receivedAt: string;
  readAt: string | null;
  starredAt: string | null;
}

/**
 * sendo の応答を、core の中の形（SyncPage）にする。形が違えば ApiError（server）を投げる。
 * 記事のタイトルや要約は信頼できないデータだが、ここでは文字列であることだけを確かめる
 * （画面では HTML として出さない）。
 */
export function toSyncPage(body: unknown): SyncPage {
  const root = record(body, "(root)");
  return {
    cursor: string(root.cursor, "cursor"),
    hasMore: boolean(root.hasMore, "hasMore"),
    folders: array(root.folders, "folders").map((value, i) => {
      const row = record(value, `folders[${i}]`);
      return {
        id: string(row.id, `folders[${i}].id`),
        name: string(row.name, `folders[${i}].name`),
        createdAt: time(row.createdAt, `folders[${i}].createdAt`),
        deleted: nullableTime(row.deletedAt, `folders[${i}].deletedAt`) !== null,
      };
    }),
    feeds: array(root.feeds, "feeds").map((value, i) => {
      const row = record(value, `feeds[${i}]`);
      return {
        id: string(row.id, `feeds[${i}].id`),
        url: string(row.url, `feeds[${i}].url`),
        title: nullableString(row.title, `feeds[${i}].title`),
        siteUrl: nullableString(row.siteUrl, `feeds[${i}].siteUrl`),
        folderId: nullableString(row.folderId, `feeds[${i}].folderId`),
        createdAt: time(row.createdAt, `feeds[${i}].createdAt`),
        deleted: nullableTime(row.deletedAt, `feeds[${i}].deletedAt`) !== null,
      };
    }),
    articles: array(root.articles, "articles").map((value, i) => {
      const row = record(value, `articles[${i}]`);
      const at = (field: string) => `articles[${i}].${field}`;
      return {
        id: string(row.id, at("id")),
        feedId: string(row.feedId, at("feedId")),
        url: nullableString(row.url, at("url")),
        title: nullableString(row.title, at("title")),
        summary: nullableString(row.summary, at("summary")),
        author: nullableString(row.author, at("author")),
        publishedAt: time(row.publishedAt, at("publishedAt")),
        receivedAt: time(row.receivedAt, at("receivedAt")),
        readAt: nullableTime(row.readAt, at("readAt")),
        starredAt: nullableTime(row.starredAt, at("starredAt")),
      };
    }),
  };
}

function invalid(field: string): ApiError {
  return new ApiError("server", `sendo の同期の応答の形が正しくない：${field}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(field);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(field);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(field);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field);
  return value;
}

function time(value: unknown, field: string): number {
  const ms = Date.parse(string(value, field));
  if (Number.isNaN(ms)) throw invalid(field);
  return ms;
}

function nullableTime(value: unknown, field: string): number | null {
  return value === null ? null : time(value, field);
}
