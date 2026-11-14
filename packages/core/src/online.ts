import { errorFromBody, type SendoApi } from "./api/client";
import type { Database, Executor } from "./db/database";
import { listFeeds } from "./db/queries";
import type { Feed } from "./models";
import { reapplyPending } from "./sync/queue";

/**
 * sendo に問い合わせないとできない操作（フィードの候補探し、購読、OPML の取り込み）。
 *
 * 購読は、sendo がフィードを取得して確かめるので、手元だけでは決められない。画面では
 * 「通信が要る操作」として、待っている間の表示を出す。結果は、次の同期で手元にも揃う。
 */

export interface FeedCandidate {
  url: string;
  title: string | null;
}

/** サイトの URL から、購読できるフィードの候補を探す。URL がフィードそのものなら、それだけを返す */
export async function discoverFeeds(
  api: SendoApi,
  url: string,
  signal: AbortSignal,
): Promise<FeedCandidate[]> {
  const { data, error, response } = await api.client.GET("/feeds/discover", {
    params: { query: { url } },
    signal,
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
  input: { url: string; folderId: string | null },
  signal: AbortSignal,
  afterWrite: (tx: Executor, feed: Feed) => Promise<void> = async () => {},
): Promise<Feed | null> {
  const { data, error, response } = await api.client.POST("/feeds", {
    body: { url: input.url, folderId: input.folderId },
    signal,
  });
  if (data === undefined) throw errorFromBody(response.status, error);
  const { feed } = data;
  const received: Feed = {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    siteUrl: feed.siteUrl,
    folderId: feed.folderId,
    createdAt: Date.parse(feed.createdAt),
  };
  return db.transaction(async (tx) => {
    signal.throwIfAborted();
    await tx.run(
      `insert into feeds (id, url, title, site_url, folder_id, created_at) values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         url = excluded.url, title = excluded.title, site_url = excluded.site_url,
         folder_id = excluded.folder_id`,
      [
        received.id,
        received.url,
        received.title,
        received.siteUrl,
        received.folderId,
        received.createdAt,
      ],
    );
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
  const { data, error, response } = await api.client.POST("/opml", {
    body: xml,
    headers: { "content-type": "text/x-opml" },
    bodySerializer: (body: string) => body,
    signal,
  });
  if (data === undefined) throw errorFromBody(response.status, error);
  return data;
}
