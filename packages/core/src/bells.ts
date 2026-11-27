import type { BellWords } from "./bell-words";
import type { Bell } from "./models";

/**
 * ベルの付け外しで、手元に見えるベルをどう変えるか（sendo の docs/decisions/notifications.md の
 * 1〜3）。core が操作を積むときと、画面が書き込みを待たずに見込みを出すときに、同じ決まりを使う。
 */

/** 付けるベルの組。購読も言葉もないベルは作らない */
export type BellTarget =
  | { feedId: string; words: BellWords | null }
  | { feedId: null; words: BellWords };

/**
 * 見えるベルへの変更。外すのが先（sendo でも外してから付けるので、上限ちょうどでも付け替え
 * られる）。どちらもなければ、もうその状態
 */
export interface BellChange {
  remove: Bell[];
  add?: BellTarget;
}

/**
 * 購読のベルを付ける ／ 外す。付けるのは購読だけのベルで、その購読にもうベルがあれば（言葉の
 * ベルでも）何もしない。外すと、その購読のベルをすべて外す
 */
export function feedBellChange(visible: readonly Bell[], feedId: string, on: boolean): BellChange {
  const current = visible.filter((bell) => bell.feedId === feedId);
  if (!on) return { remove: current };
  return current.length > 0 ? { remove: [] } : { remove: [], add: { feedId, words: null } };
}

/**
 * 購読のベルを、その言葉の購読 AND 言葉のベルにする（null なら購読だけのベル）。sendo にはベルを
 * 書き換える API がないので、その購読のほかのベルを外して付ける。同じ組のベルがもうあれば付けず、
 * その購読にベルがなければ付ける
 */
export function feedBellWordsChange(
  visible: readonly Bell[],
  feedId: string,
  words: BellWords | null,
): BellChange {
  const current = visible.filter((bell) => bell.feedId === feedId);
  const same = current.find((bell) => bell.matchKey === (words?.matchKey ?? null));
  const remove = current.filter((bell) => bell !== same);
  return same === undefined ? { remove, add: { feedId, words } } : { remove };
}

/** 言葉だけのベルを付ける ／ 外す。照合用の言葉が同じなら同じベル（同じベルを 2 つ作らない） */
export function wordBellChange(
  visible: readonly Bell[],
  words: BellWords,
  on: boolean,
): BellChange {
  const current = visible.filter(
    (bell) => bell.feedId === null && bell.matchKey === words.matchKey,
  );
  if (!on) return { remove: current };
  return current.length > 0 ? { remove: [] } : { remove: [], add: { feedId: null, words } };
}

/** 見えるベルを 1 つ外す。もう見えなければ何もしない */
export function bellRemoval(visible: readonly Bell[], bellId: string): BellChange {
  return { remove: visible.filter((bell) => bell.id === bellId) };
}

/**
 * 変更したあとに見えるベル（画面が、書き込みを待たずに出す見込み）。付けるベルは draft の ID と
 * 時刻で最後に足す
 */
export function applyBellChange(
  visible: readonly Bell[],
  change: BellChange,
  draft: { id: string; createdAt: number },
): Bell[] {
  const removed = new Set(change.remove);
  const kept = visible.filter((bell) => !removed.has(bell));
  if (change.add === undefined) return kept;
  const { feedId, words } = change.add;
  const common = { ...draft, feedId, subscriptionId: null };
  return [
    ...kept,
    words === null
      ? { ...common, words: null, matchKey: null }
      : { ...common, words: words.words, matchKey: words.matchKey },
  ];
}
