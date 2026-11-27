import type { Bell } from "../models";
import type { Executor } from "./database";

/**
 * 手元に見えるベル。bells の表（sendo が受け付けた行）に、まだ送っていないベルの付け外し（操作
 * キューの setBell。鍵は購読と言葉の組）を重ねる。組ごとに最後に積んだ操作が、その組のベルを決める
 * （付けるなら、その操作の ID のベルを見せ、外すなら見せない）。組が同じかは、フィードの ID と照合用
 * の言葉で見分ける（sendo の notifications.md の 3。言葉の並びや大文字と小文字が違っても同じ組）。
 * 断られた操作を消すだけで、sendo の状態に戻る。
 *
 * 購読のベルは、手元で今もその購読をしているときだけ見せる。購読をやめても、まだ送っていない
 * ベルの操作や、送って受け付けられた行は残る（sendo は購読をやめるとベルを外し、その知らせは
 * 同期で届く）。届く前に購読し直しても、購読が替わるので古いベルは見せない（手元の購読に ID が
 * ないときは、ワークスペースに対応する前の sendo から届いた行なので、フィードがあれば見せる）。
 * 言葉だけのベルは、購読によらず見せる
 */
const VISIBLE_BELLS = `
  with ops as (
    select json_extract(payload, '$.bellId') as id,
        json_extract(payload, '$.feedId') as feed_id,
        json_extract(payload, '$.words.words') as words,
        json_extract(payload, '$.words.matchKey') as match_key,
        json_extract(payload, '$.on') as adds,
        json_extract(payload, '$.at') as at
      from pending_ops
      where id in (select max(id) from pending_ops where kind = 'setBell' group by key)
  )
  select id, subscription_id as subscriptionId, feed_id as feedId, words, match_key as matchKey,
      created_at as createdAt
    from bells
    where (feed_id is null or exists (
        select 1 from feeds
        where feeds.id = bells.feed_id
          and (feeds.subscription_id is null or feeds.subscription_id = bells.subscription_id)
      ))
      and not exists (
        select 1 from ops where ops.feed_id is bells.feed_id and ops.match_key is bells.match_key
      )
  union all
  select ops.id, feeds.subscription_id, ops.feed_id, ops.words, ops.match_key, ops.at
    from ops left join feeds on feeds.id = ops.feed_id
    where ops.adds = 1 and (ops.feed_id is null or feeds.id is not null)`;

/** 手元に見えるベルを、作った順に読む */
export function listBells(db: Executor): Promise<Bell[]> {
  return db.all<Bell>(`select * from (${VISIBLE_BELLS}) order by createdAt, id`);
}

export function putBell(tx: Executor, bell: Bell): Promise<void> {
  return tx.run(
    `insert into bells (id, subscription_id, feed_id, words, match_key, created_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (id) do update set subscription_id = excluded.subscription_id,
       feed_id = excluded.feed_id, words = excluded.words, match_key = excluded.match_key,
       created_at = excluded.created_at`,
    [bell.id, bell.subscriptionId, bell.feedId, bell.words, bell.matchKey, bell.createdAt],
  );
}

export function removeBell(tx: Executor, id: string): Promise<void> {
  return tx.run("delete from bells where id = ?", [id]);
}

export function clearBells(tx: Executor): Promise<void> {
  return tx.run("delete from bells");
}
