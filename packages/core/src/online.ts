import { errorFromBody, type SendoApi } from "./api/client";
import type { Database, Executor } from "./db/database";
import { putFeed } from "./db/feeds";
import { listFeeds } from "./db/queries";
import type { Feed, FeedFetchTimes } from "./models";
import { reapplyPending } from "./sync/queue";
import { toSameOriginUrl } from "./url";

/**
 * sendo に問い合わせないとできない操作（フィードの取得時刻、候補探し、購読、OPML の取り込み）。
 *
 * 購読は、sendo がフィードを取得して確かめるので、手元だけでは決められない。画面では
 * 「通信が要る操作」として、待っている間の表示を出す。結果は、次の同期で手元にも揃う。
 */

export interface FeedCandidate {
  url: string;
  title: string | null;
}

/** 差分同期に載らない取得時刻を REST API から読む。購読がなければ null */
export async function fetchFeedTimes(
  api: SendoApi,
  feedId: string,
  signal: AbortSignal,
): Promise<FeedFetchTimes | null> {
  const { data, error, response } = await api.client(signal).GET("/feeds", { cache: "no-store" });
  if (data === undefined) throw errorFromBody(response.status, error);
  const feed = data.items.find((item) => item.id === feedId);
  if (feed === undefined) return null;
  return {
    lastFetchedAt: parseFetchTime(feed.lastFetchedAt),
    lastSuccessfulFetchAt: parseFetchTime(feed.lastSuccessfulFetchAt),
  };
}

function parseFetchTime(value: unknown): number | null {
  // 成功時刻を返す前の版の sendo では、項目そのものがない。
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * 記事をその場で訳してもらう。retranslation なら、品質優先の段階で訳し直してもらう（sendo の
 * POST /articles/{id}/translation。docs/decisions/translation.md の 4〜6）。受け付けられたら（202）
 * 返る。断られたか届かなければ ApiError（code に理由）
 */
export async function requestTranslation(
  api: SendoApi,
  articleId: string,
  signal: AbortSignal,
  retranslation = false,
): Promise<void> {
  // その場の翻訳は本文を付けない（訳し直しの指定に対応する前の sendo にも頼める）
  const { data, error, response } = await api.client(signal).POST("/articles/{id}/translation", {
    params: { path: { id: articleId } },
    ...(retranslation && { body: { retranslate: true } }),
  });
  if (data === undefined) throw errorFromBody(response.status, error);
}

/** サイトの URL から、購読できるフィードの候補を探す。URL がフィードそのものなら、それだけを返す */
export async function discoverFeeds(
  api: SendoApi,
  url: string,
  signal: AbortSignal,
): Promise<FeedCandidate[]> {
  const { data, error, response } = await api.client(signal).GET("/feeds/discover", {
    params: { query: { url } },
  });
  if (data === undefined) throw errorFromBody(response.status, error);
  return data.candidates.map((candidate) => ({ url: candidate.url, title: candidate.title }));
}

/**
 * フィードを購読する。すでに購読していれば、それを返す。購読したフィードはすぐ手元にも入れる
 * （記事は次の同期で届く）。folderId は sendo の ID で渡す。
 *
 * 応答を書き込むトランザクションの中で、afterWrite を呼び、まだ送っていない操作を重ね直す
 * （応答を待っている間にした操作の、手元の表示を保つ）。返すのは重ね直したあとの手元の状態で、
 * 待っている間に購読をやめていれば null。
 */
export async function subscribe(
  db: Database,
  api: SendoApi,
  input: { url: string; folderId: string | null; workspaceId: string | null },
  signal: AbortSignal,
  afterWrite: (tx: Executor, feed: Feed) => Promise<void> = async () => {},
): Promise<Feed | null> {
  const { data, error, response } = await api.client(signal).POST("/feeds", {
    body: {
      url: input.url,
      folderId: input.folderId,
      ...(input.workspaceId !== null && { workspaceId: input.workspaceId }),
    },
  });
  if (data === undefined) throw errorFromBody(response.status, error);
  const { feed } = data;
  const received: Feed = {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    displayName: feed.displayName ?? null,
    siteUrl: feed.siteUrl,
    folderId: feed.folderId,
    ...(typeof feed.subscriptionId === "string" && {
      subscriptionId: feed.subscriptionId,
      workspaceId: feed.workspaceId ?? null,
    }),
    // 購読したばかりのフィードには、まだアイコンがないことが多い（あとから、同期で届く）
    iconUrl: toSameOriginUrl(feed.iconUrl),
    createdAt: Date.parse(feed.createdAt),
  };
  return db.transaction(async (tx) => {
    signal.throwIfAborted();
    await putFeed(tx, received);
    await afterWrite(tx, received);
    await reapplyPending(tx);
    return (await listFeeds(tx)).find((local) => local.id === received.id) ?? null;
  });
}

export interface OpmlImportResult {
  /** 登録を受け付けたフィードの数。sendo が順に登録し、次からの同期で手元に届く */
  accepted: number;
  skippedCount: number;
  /** 飛ばしたフィード（最初の 100 件まで） */
  skipped: { url: string; reason: "url_not_allowed" | "url_too_long" | "duplicate" | "too_many" }[];
}

/** Feedly などから書き出した OPML を取り込む。フォルダも sendo が作る */
export async function importOpml(
  api: SendoApi,
  xml: string,
  signal: AbortSignal,
): Promise<OpmlImportResult> {
  const { data, error, response } = await api.client(signal).POST("/opml", {
    body: xml,
    headers: { "content-type": "text/x-opml" },
    bodySerializer: (body: string) => body,
  });
  if (data === undefined) throw errorFromBody(response.status, error);
  return data;
}
