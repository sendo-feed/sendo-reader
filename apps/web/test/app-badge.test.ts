import type { Table, UnreadCounts } from "@sendo-reader/core";
import { expect, test } from "vitest";
import { showUnreadBadge } from "../src/lib/app-badge";

/**
 * にせものの窓口とバッジ。手元の DB の読み出し（countUnread）は、テストが答えるまで待たせる。
 * バッジに書いた数を calls に覚え、fail のときは書くのに失敗する
 */
function setup() {
  const reads: { answer: (total: number) => void; fail: () => void }[] = [];
  const listeners: ((tables: ReadonlySet<Table>) => void)[] = [];
  const calls: (number | "clear")[] = [];
  const badge = { fail: false };
  const write = (value: number | "clear") => {
    calls.push(value);
    return badge.fail ? Promise.reject(new Error("通知を許可していない")) : Promise.resolve();
  };
  showUnreadBadge(
    {
      countUnread: () =>
        new Promise<UnreadCounts>((resolve, reject) => {
          reads.push({
            answer: (total) => resolve({ total, feeds: new Map(), folders: new Map() }),
            fail: () => reject(new Error("版が合わない")),
          });
        }),
      onChange: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    },
    { setAppBadge: write, clearAppBadge: () => write("clear") },
  );
  const changeArticles = () => {
    for (const listener of listeners) listener(new Set<Table>(["articles"]));
  };
  const read = async (index: number, total: number) => {
    reads[index]?.answer(total);
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { reads, calls, badge, changeArticles, read };
}

test("読んでいる間にまた変わったら、あとの読み出しの数を出し、先の答えが遅れて届いても書き戻さない", async () => {
  const { calls, changeArticles, read } = setup();
  changeArticles();
  await read(1, 11);
  await read(0, 12);
  expect(calls).toEqual([11]);
});

test("書けなかったら、次に数え直したときに同じ数でも書き直す。書けたあとは同じ数を書かない", async () => {
  const { calls, badge, changeArticles, read } = setup();
  badge.fail = true;
  await read(0, 12);
  badge.fail = false;
  changeArticles();
  await read(1, 12);
  changeArticles();
  await read(2, 12);
  expect(calls).toEqual([12, 12]);
});

test("数えられなければ書かず、次に記事の表が変わったときに数え直す", async () => {
  const { reads, calls, changeArticles, read } = setup();
  reads[0]?.fail();
  await new Promise((resolve) => setTimeout(resolve));
  expect(calls).toEqual([]);
  changeArticles();
  await read(1, 0);
  expect(calls).toEqual(["clear"]);
});
