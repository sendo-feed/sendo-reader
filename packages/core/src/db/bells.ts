import type { Bell } from "../models";
import type { Executor } from "./database";

/**
 * 手元に見えるベル。bells の表（sendo が受け付けた行）に、まだ送っていない購読のベルの付け外し
 * （操作キューの setFeedBell。鍵はフィードの ID）を重ねる。フィードごとに最後に積んだ操作が、その
 * フィードの購読だけのベルを決める（付けるなら、その操作の ID のベルを見せ、外すなら見せない）。
 * 断られた操作を消すだけで、sendo の状態に戻る。
 *
 * 購読のベルは、手元で今もその購読をしているときだけ見せる。購読をやめても、まだ送っていない
 * ベルの操作や、送って受け付けられた行は残る（sendo は購読をやめるとベルを外し、その知らせは
 * 同期で届く）。届く前に購読し直しても、購読が替わるので古いベルは見せない（手元の購読に ID が
 * ないときは、ワークスペースに対応する前の sendo から届いた行なので、フィードがあれば見せる）
 */
const VISIBLE_BELLS = `
  with latest as (
    select key, max(id) as id from pending_ops where kind = 'setFeedBell' group by key
  )
  select id, subscription_id as subscriptionId, feed_id as feedId, words, created_at as createdAt
    from bells
    where feed_id is null
      or (exists (
          select 1 from feeds
          where feeds.id = bells.feed_id
            and (feeds.subscription_id is null or feeds.subscription_id = bells.subscription_id)
        ) and (words is not null or feed_id not in (select key from latest)))
  union all
  select json_extract(pending_ops.payload, '$.bellId'), feeds.subscription_id, latest.key, null,
      json_extract(pending_ops.payload, '$.at')
    from latest
    join pending_ops on pending_ops.id = latest.id
    join feeds on feeds.id = latest.key
    where json_extract(pending_ops.payload, '$.on') = 1`;

/** 手元に見えるベルを、作った順に読む */
export function listBells(db: Executor): Promise<Bell[]> {
  return db.all<Bell>(`select * from (${VISIBLE_BELLS}) order by createdAt, id`);
}

/** そのフィードの、手元に見える購読だけのベルの ID（なければ null） */
export async function visibleFeedBellId(db: Executor, feedId: string): Promise<string | null> {
  const [row] = await db.all<{ id: string }>(
    `select id from (${VISIBLE_BELLS}) where feedId = ? and words is null limit 1`,
    [feedId],
  );
  return row?.id ?? null;
}

export async function countVisibleBells(db: Executor): Promise<number> {
  const [row] = await db.all<{ count: number }>(`select count(*) as count from (${VISIBLE_BELLS})`);
  return row?.count ?? 0;
}

export function putBell(tx: Executor, bell: Bell): Promise<void> {
  return tx.run(
    `insert into bells (id, subscription_id, feed_id, words, created_at) values (?, ?, ?, ?, ?)
     on conflict (id) do update set subscription_id = excluded.subscription_id,
       feed_id = excluded.feed_id, words = excluded.words, created_at = excluded.created_at`,
    [bell.id, bell.subscriptionId, bell.feedId, bell.words, bell.createdAt],
  );
}

export function removeBell(tx: Executor, id: string): Promise<void> {
  return tx.run("delete from bells where id = ?", [id]);
}

export function clearBells(tx: Executor): Promise<void> {
  return tx.run("delete from bells");
}
