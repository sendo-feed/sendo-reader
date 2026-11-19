import type { FeedFetchTimes } from "../models";
import type { Executor } from "./database";

export async function getStoredFeedFetchTimes(
  db: Executor,
  feedId: string,
): Promise<FeedFetchTimes | null> {
  const [times] = await db.all<{
    lastFetchedAt: number | null;
    lastSuccessfulFetchAt: number | null;
  }>(
    `select last_fetched_at as lastFetchedAt, last_successful_fetch_at as lastSuccessfulFetchAt
     from feed_fetch_times where feed_id = ?`,
    [feedId],
  );
  return times ?? null;
}

/** 応答を待つ間に手元の購読が消えていたら、時刻を置かない */
export async function putStoredFeedFetchTimes(
  tx: Executor,
  feedId: string,
  times: FeedFetchTimes,
): Promise<boolean> {
  const rows = await tx.all<{ feed_id: string }>(
    `insert into feed_fetch_times (feed_id, last_fetched_at, last_successful_fetch_at)
     select id, ?, ? from feeds where id = ?
     on conflict (feed_id) do update set
       last_fetched_at = excluded.last_fetched_at,
       last_successful_fetch_at = excluded.last_successful_fetch_at
     returning feed_id`,
    [times.lastFetchedAt, times.lastSuccessfulFetchAt, feedId],
  );
  return rows.length > 0;
}
