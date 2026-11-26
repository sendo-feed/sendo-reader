/**
 * 差分同期（GET /api/v1/sync）の応答を確かめて、core の中の形（SyncPage、sync/page.ts）にする。
 * 決まりは sendo の差分同期の決定（docs/decisions/sync.md）と、OpenAPI の /sync の説明が正。
 *
 * - カーソルの中身は解釈しない。受け取ったものをそのまま次に送る
 * - カーソルなしで呼ぶと、最初の同期（未読、スター、直近 30 日に受信箱に入った記事）
 * - hasMore が true なら、返ってきたカーソルですぐ続きを取る
 * - 消したフォルダと購読は deleted: true の行で、受信箱から消えた記事は { id, deleted: true } で届く
 * - 設定の項目（settings）は、どの端末の種類の分も届く。消した項目は deleted: true で届く
 * - カーソルが読めない（古すぎる、など）ときは 400 と error.code = "invalid_cursor"。最初から同期し直す
 *
 * 応答は外から来たデータなので、使う項目の形を確かめてから、生成した型（SyncChanges）を基に
 * 組み立てる。sendo が使う項目の形を変えたら、ここが型チェックで止まる。
 */

import {
  DEVICE_TYPES,
  type JsonValue,
  type SavedPage,
  TRANSLATION_STATUSES,
  type TranslationFailure,
} from "../models";
import { normalizeSavedUrl, SAVED_ID_PATTERN } from "../saved";
import type { SyncArticle, SyncPage, SyncSetting } from "../sync/page";
import { toSameOriginUrl } from "../url";
import { ApiError } from "./errors";
import type { components } from "./schema.gen";

type Schemas = components["schemas"];
export type SyncChanges = Schemas["SyncChanges"];
// フィードの取得状態はまだ使わないので、同期に必要な項目だけを検証する。
type ParsedSyncFeed = Omit<Schemas["SyncFeed"], "status" | "lastErrorCode" | "relocationCandidate">;
/** 確かめた記事。翻訳は、訳せなかった理由の知らない値も持つ形（ParsedTranslation） */
type ParsedSyncArticle =
  | Extract<Schemas["SyncArticle"], { deleted: true }>
  | (Omit<Extract<Schemas["SyncArticle"], { deleted: false }>, "translation"> & {
      translation: ParsedTranslation | null;
    });
type ParsedSyncWorkspace =
  | Extract<Schemas["SyncWorkspace"], { deleted: true }>
  | (Omit<Extract<Schemas["SyncWorkspace"], { deleted: false }>, "isDefault"> & {
      isDefault?: boolean;
    });

/** sendo の応答を確かめて、core の中の形にする。形が違えば ApiError（server）を投げる */
export function toSyncPage(body: unknown): SyncPage {
  const changes = parseSyncChanges(body);
  return {
    // 知らない端末の種類の項目は、使わない（置かない）
    settings:
      changes.settings === undefined
        ? null
        : changes.settings.flatMap((setting): SyncSetting[] => {
            const deviceType = DEVICE_TYPES.find((type) => type === setting.deviceType);
            if (deviceType === undefined) return [];
            return setting.deleted
              ? [{ deviceType, name: setting.name, deleted: true }]
              : [
                  {
                    deviceType,
                    name: setting.name,
                    value: (setting.value ?? null) as JsonValue,
                    deleted: false,
                  },
                ];
          }),
    savedPages:
      changes.savedPages?.map((page) =>
        page.deleted ? page : { ...page, savedAt: Date.parse(page.savedAt) },
      ) ?? null,
    workspaces:
      changes.workspaces?.map((row) =>
        row.deleted ? row : { ...row, createdAt: Date.parse(row.createdAt) },
      ) ?? null,
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
      displayName: feed.displayName,
      siteUrl: feed.siteUrl,
      folderId: feed.folderId,
      ...(feed.subscriptionId !== undefined && {
        workspaceId: feed.workspaceId ?? null,
        subscriptionId: feed.subscriptionId,
      }),
      iconUrl: toSameOriginUrl(feed.iconUrl),
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
              thumbnailUrl: toSameOriginUrl(article.thumbnailUrl),
              hasContent: article.hasContent,
              publishedAt: Date.parse(article.publishedAt),
              receivedAt: Date.parse(article.receivedAt),
              readAt: article.readAt === null ? null : Date.parse(article.readAt),
              starredAt: article.starredAt === null ? null : Date.parse(article.starredAt),
              translation:
                article.translation === null
                  ? null
                  : {
                      ...article.translation,
                      translatedAt:
                        article.translation.translatedAt === null
                          ? null
                          : Date.parse(article.translation.translatedAt),
                    },
              deleted: false,
            },
    ),
  };
}

/**
 * 応答の形を確かめる。記事のタイトルや要約は信頼できないデータだが、ここでは文字列であることだけを
 * 確かめる（画面では HTML として出さない）。時刻は読める形であることを確かめる。画像の URL
 * （thumbnailUrl、iconUrl）は、core の中の形にするときに、同じオリジンを指すものだけを残す。
 */
function parseSyncChanges(body: unknown): Omit<
  SyncChanges,
  "feeds" | "settings" | "savedPages" | "articles" | "workspaces"
> & {
  feeds: ParsedSyncFeed[];
  articles: ParsedSyncArticle[];
  settings: SyncChanges["settings"] | undefined;
  savedPages: SyncChanges["savedPages"];
  workspaces: ParsedSyncWorkspace[] | undefined;
} {
  const root = record(body, "(root)");
  return {
    // あとから足された項目。設定を配る前の版の sendo が相手でも、同期を止めない
    settings:
      root.settings === undefined
        ? undefined
        : array(root.settings, "settings").map((value, i): Schemas["SyncSetting"] => {
            const row = record(value, `settings[${i}]`);
            const at = (field: string) => `settings[${i}].${field}`;
            const deviceType = string(row.deviceType, at("deviceType"));
            const name = string(row.name, at("name"));
            if (boolean(row.deleted, at("deleted"))) return { deviceType, name, deleted: true };
            // 値は JSON の値なら何でもよい（JSON として届いているので、形は確かめない）
            return { deviceType, name, value: row.value, deleted: false };
          }),
    savedPages:
      root.savedPages === undefined
        ? undefined
        : array(root.savedPages, "savedPages").map((value, i): Schemas["SyncSavedPage"] => {
            const field = `savedPages[${i}]`;
            const row = record(value, field);
            if (boolean(row.deleted, `${field}.deleted`)) {
              return { id: savedId(row.id, `${field}.id`), deleted: true };
            }
            return { ...parseSavedPage(row, field), deleted: false };
          }),
    workspaces:
      root.workspaces === undefined
        ? undefined
        : array(root.workspaces, "workspaces").map((value, i): ParsedSyncWorkspace => {
            const field = `workspaces[${i}]`;
            const row = record(value, field);
            const id = string(row.id, `${field}.id`);
            if (boolean(row.deleted, `${field}.deleted`)) return { id, deleted: true };
            return {
              id,
              name: string(row.name, `${field}.name`),
              createdAt: time(row.createdAt, `${field}.createdAt`),
              ...(row.isDefault !== undefined && {
                isDefault: boolean(row.isDefault, `${field}.isDefault`),
              }),
              deleted: false,
            };
          }),
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
    feeds: array(root.feeds, "feeds").map((value, i): ParsedSyncFeed => {
      const row = record(value, `feeds[${i}]`);
      const at = (field: string) => `feeds[${i}].${field}`;
      const deleted = boolean(row.deleted, at("deleted"));
      return {
        id: string(row.id, at("id")),
        url: string(row.url, at("url")),
        title: nullableString(row.title, at("title")),
        displayName: optionalString(row.displayName, at("displayName")),
        siteUrl: nullableString(row.siteUrl, at("siteUrl")),
        folderId: nullableString(row.folderId, at("folderId")),
        ...(!deleted &&
          root.workspaces !== undefined && {
            workspaceId: nullableString(row.workspaceId, at("workspaceId")),
            subscriptionId: string(row.subscriptionId, at("subscriptionId")),
          }),
        iconUrl: optionalString(row.iconUrl, at("iconUrl")),
        createdAt: time(row.createdAt, at("createdAt")),
        deleted,
      };
    }),
    articles: array(root.articles, "articles").map((value, i): ParsedSyncArticle => {
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
        thumbnailUrl: optionalString(row.thumbnailUrl, at("thumbnailUrl")),
        // あとから足された項目。本文を配る前の版の sendo が相手なら、本文なし
        hasContent:
          row.hasContent === undefined ? false : boolean(row.hasContent, at("hasContent")),
        publishedAt: time(row.publishedAt, at("publishedAt")),
        receivedAt: time(row.receivedAt, at("receivedAt")),
        readAt: nullableTime(row.readAt, at("readAt")),
        starredAt: nullableTime(row.starredAt, at("starredAt")),
        translation: parseTranslation(row.translation),
        deleted: false,
      };
    }),
  };
}

/** 元の言語の形（ISO 639-1 の小文字 2 文字か、判定できなかった und） */
const LANGUAGE_PATTERN = /^(?:[a-z]{2}|und)$/;

/**
 * 記事の翻訳（あとから足された項目。sendo の docs/decisions/sync.md の 10）。翻訳に対応する前の
 * sendo（項目がない）と、翻訳の付かない記事（null）は、翻訳なし。
 *
 * 翻訳はラベルと訳したタイトルにしか使わないので、形が崩れていても（知らない状態、読めない時刻など）
 * 同期は止めず、その記事を翻訳なしとして扱う。sendo が状態を足しても、古い reader が止まらない
 */
function parseTranslation(value: unknown): ParsedTranslation | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = TRANSLATION_STATUSES.find((s) => s === row.status);
  const { language, title, summary, translatedAt, retranslated, failure, model, effort } = row;
  if (status === undefined) return null;
  if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) return null;
  if (!isNullableString(title) || !isNullableString(summary)) return null;
  if (
    translatedAt !== null &&
    (typeof translatedAt !== "string" || Number.isNaN(Date.parse(translatedAt)))
  ) {
    return null;
  }
  // 訳し直しの印は、あとから足された項目。印に対応する前の sendo（項目がない）は、訳し直していない
  if (retranslated !== undefined && typeof retranslated !== "boolean") return null;
  return {
    language,
    status,
    title,
    summary,
    translatedAt,
    retranslated: retranslated === true,
    failure: parseTranslationFailure(failure),
    model: nonEmptyString(model),
    effort: nonEmptyString(effort),
  };
}

/**
 * 訳したモデルと思考量（あとから足された項目。sendo の docs/decisions/translation.md の 18、この
 * reader の translation.md の 1）。ラベルに足すだけなので、条件に対応する前の sendo（項目がない）、
 * 文字でない値、空の文字は届かないもの（null）とし、翻訳のほかの項目は使う。知らない値（sendo が
 * モデルや思考量を足した）は捨てずに持ち、画面が届いたまま出す
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 確かめた記事の翻訳。訳せなかった理由は、知らない値も捨てずに持つ（TranslationFailure） */
type ParsedTranslation = Omit<Schemas["SyncArticleTranslation"] & object, "failure"> & {
  failure: TranslationFailure | null;
};

/**
 * 訳せなかった理由（あとから足された項目。sendo の docs/decisions/translation.md の 17）。理由に
 * 対応する前の sendo（項目がない）は、理由なし。形が崩れていたら（文字列でない、など）、翻訳は残して
 * 理由だけをなしにする。知らない値（sendo が種類を足した）は捨てずに持ち、画面がそのほかの失敗と
 * して出す
 */
function parseTranslationFailure(value: unknown): TranslationFailure | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, category, stage } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof stage !== "string" || !isNullableString(category)) {
    return null;
  }
  return { kind, category, stage };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** 保存 API の応答にも、差分同期と同じ境界の検証を使う。 */
export function toSavedPage(body: unknown): SavedPage {
  const page = parseSavedPage(record(body, "page"), "page");
  return { ...page, savedAt: Date.parse(page.savedAt) };
}

function parseSavedPage(row: Record<string, unknown>, field: string): Schemas["SavedPage"] {
  const url = normalizeSavedUrl(string(row.url, `${field}.url`));
  if (url === null) throw invalid(`${field}.url`);
  return {
    id: savedId(row.id, `${field}.id`),
    url,
    title: nullableString(row.title, `${field}.title`),
    savedAt: time(row.savedAt, `${field}.savedAt`),
  };
}

function savedId(value: unknown, field: string): string {
  const id = string(value, field);
  if (!SAVED_ID_PATTERN.test(id)) throw invalid(field);
  return id;
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

/** あとから足された項目。まだ配っていない版の sendo が相手でも、同期を止めない（ないものは null） */
function optionalString(value: unknown, field: string): string | null {
  return value === undefined ? null : nullableString(value, field);
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
