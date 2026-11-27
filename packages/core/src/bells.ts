import type { BellWords } from "./bell-words";
import type { Bell } from "./models";

/**
 * ベルの付け外しで、手元に見えるベルをどう変えるか（sendo の docs/decisions/notifications.md の
 * 1〜3）。core が操作を積むときと、画面が書き込みを待たずに見込みを出すときに、同じ決まりを使う。
 */

/** 付けるベルの組。購読も言葉もないベルは作らない */
export type BellTarget =
  | { feedId: string; words: null }
  | { feedId: string | null; words: BellWords };

/** 見えるベルの組 */
export function bellTarget(bell: Bell): BellTarget {
  return bell.words === null
    ? { feedId: bell.feedId, words: null }
    : { feedId: bell.feedId, words: { words: bell.words, matchKey: bell.matchKey } };
}

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
 * manage feed が出す、その購読のベル（1 つ）。いちばんあとに作ったもの（言葉を替えると、替えた
 * ベルが出たままになる）。なければ undefined
 */
export function feedBell(visible: readonly Bell[], feedId: string): Bell | undefined {
  return visible.findLast((bell) => bell.feedId === feedId);
}

/**
 * manage feed が出している購読のベル（feedBell）を、その言葉の購読 AND 言葉のベルにする（null なら
 * 購読だけのベル。docs/decisions/notifications.md の 7）。sendo にはベルを書き換える API がないので、
 * 出しているベルを外して付ける。同じ購読のほかのベルは外さない。出しているベルがもうその組なら何も
 * せず、ほかのベルがその組なら、出しているベルを外すだけ（同じ組を 2 つ作らない）。その購読にベルが
 * なければ付ける
 */
export function feedBellWordsChange(
  visible: readonly Bell[],
  feedId: string,
  words: BellWords | null,
): BellChange {
  const matchKey = words?.matchKey ?? null;
  const shown = feedBell(visible, feedId);
  if (shown !== undefined && shown.matchKey === matchKey) return { remove: [] };
  const remove = shown === undefined ? [] : [shown];
  const exists = visible.some((bell) => bell.feedId === feedId && bell.matchKey === matchKey);
  return exists ? { remove } : { remove, add: { feedId, words } };
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
  const { add } = change;
  if (add === undefined) return kept;
  const common = { ...draft, subscriptionId: null };
  return [
    ...kept,
    add.words === null
      ? { ...common, feedId: add.feedId, words: null, matchKey: null }
      : { ...common, feedId: add.feedId, words: add.words.words, matchKey: add.words.matchKey },
  ];
}
