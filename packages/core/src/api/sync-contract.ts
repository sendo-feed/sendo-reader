/**
 * 差分同期（GET /api/v1/sync）の応答を確かめて、core の中の形（SyncPage、sync/page.ts）にする。
 * 決まりは sendo の差分同期の決定（docs/decisions/sync.md）と、OpenAPI の /sync の説明が正。
 *
 * - カーソルの中身は解釈しない。受け取ったものをそのまま次に送る
 * - カーソルなしで呼ぶと、最初の同期（未読、スター、直近 30 日に受信箱に入った記事）
 * - hasMore が true なら、返ってきたカーソルですぐ続きを取る
 * - 消したフォルダと購読は deleted: true の行で、受信箱から消えた記事は { id, deleted: true } で届く
 * - カーソルが読めない（古すぎる、など）ときは 400 と error.code = "invalid_cursor"。最初から同期し直す
 *
 * 応答は外から来たデータなので、生成した型を当てる前に形を確かめる。確かめたものを生成した型
 * （SyncChanges）として組み立てるので、sendo が形を変えたら、ここが型チェックで止まる。
 */

import type { SyncArticle, SyncPage } from "../sync/page";
import { ApiError } from "./errors";
import type { components } from "./schema.gen";

type Schemas = components["schemas"];
export type SyncChanges = Schemas["SyncChanges"];

/** sendo の応答を確かめて、core の中の形にする。形が違えば ApiError（server）を投げる */
export function toSyncPage(body: unknown): SyncPage {
  const changes = parseSyncChanges(body);
  return {
    cursor: changes.cursor,
    hasMore: changes.hasMore,
    folders: changes.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      createdAt: Date.parse(folder.createdAt),
      deleted: folder.deleted,
    })),
    feeds: changes.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      title: feed.title,
      siteUrl: feed.siteUrl,
      folderId: feed.folderId,
      createdAt: Date.parse(feed.createdAt),
      deleted: feed.deleted,
    })),
    articles: changes.articles.map(
      (article): SyncArticle =>
        article.deleted
          ? { id: article.id, deleted: true }
          : {
              id: article.id,
              feedId: article.feedId,
              url: article.url,
              title: article.title,
              summary: article.summary,
              author: article.author,
              publishedAt: Date.parse(article.publishedAt),
              receivedAt: Date.parse(article.receivedAt),
              readAt: article.readAt === null ? null : Date.parse(article.readAt),
              starredAt: article.starredAt === null ? null : Date.parse(article.starredAt),
              deleted: false,
            },
    ),
  };
}

/**
 * 応答の形を確かめる。記事のタイトルや要約は信頼できないデータだが、ここでは文字列であることだけを
 * 確かめる（画面では HTML として出さない）。時刻は読める形であることを確かめる。
 */
function parseSyncChanges(body: unknown): SyncChanges {
  const root = record(body, "(root)");
  return {
    cursor: string(root.cursor, "cursor"),
    hasMore: boolean(root.hasMore, "hasMore"),
    folders: array(root.folders, "folders").map((value, i): Schemas["SyncFolder"] => {
      const row = record(value, `folders[${i}]`);
      const at = (field: string) => `folders[${i}].${field}`;
      return {
        id: string(row.id, at("id")),
        name: string(row.name, at("name")),
        createdAt: time(row.createdAt, at("createdAt")),
        deleted: boolean(row.deleted, at("deleted")),
      };
    }),
    feeds: array(root.feeds, "feeds").map((value, i): Schemas["SyncFeed"] => {
      const row = record(value, `feeds[${i}]`);
      const at = (field: string) => `feeds[${i}].${field}`;
      return {
        id: string(row.id, at("id")),
        url: string(row.url, at("url")),
        title: nullableString(row.title, at("title")),
        siteUrl: nullableString(row.siteUrl, at("siteUrl")),
        folderId: nullableString(row.folderId, at("folderId")),
        createdAt: time(row.createdAt, at("createdAt")),
        deleted: boolean(row.deleted, at("deleted")),
      };
    }),
    articles: array(root.articles, "articles").map((value, i): Schemas["SyncArticle"] => {
      const row = record(value, `articles[${i}]`);
      const at = (field: string) => `articles[${i}].${field}`;
      if (boolean(row.deleted, at("deleted"))) {
        return { id: string(row.id, at("id")), deleted: true };
      }
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
        deleted: false,
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

/** 読める時刻の文字列なら、そのまま返す */
function time(value: unknown, field: string): string {
  const text = string(value, field);
  if (Number.isNaN(Date.parse(text))) throw invalid(field);
  return text;
}

function nullableTime(value: unknown, field: string): string | null {
  return value === null ? null : time(value, field);
}
