// 画面の状態（list.svelte.ts）は $state などのルーンを使う。ルーンの型は svelte が持つ
/// <reference types="svelte" />
import type { Article, ArticleQuery } from "@sendo-reader/core";
import type { ReaderClient } from "@sendo-reader/core/web";
import { describe, expect, test } from "vitest";
import { ArticleListState } from "../src/lib/list.svelte";

/** 開いている一覧（ArticleListState）。画面の部品を通さず、読み出しの順番を確かめる */

function article(id: string, publishedAt: number): Article {
  return {
    id,
    feedId: "feed-1",
    url: null,
    title: id,
    summary: null,
    author: null,
    thumbnailUrl: null,
    hasContent: false,
    publishedAt,
    receivedAt: publishedAt,
    readAt: null,
    starredAt: null,
    translation: null,
  };
}

/** 一覧の読み出しを、テストから好きな順に終わらせられる偽の窓口 */
function fakeClient() {
  const requests: { query: ArticleQuery; resolve: (page: Article[]) => void }[] = [];
  const client = {
    listArticles: (query: ArticleQuery) =>
      new Promise<Article[]>((resolve) => requests.push({ query, resolve })),
    getArticles: async () => [],
  } as unknown as ReaderClient;
  return { client, requests };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ArticleListState", () => {
  test("一覧を替えて読んでいる間に読み直しが重なっても、show が解けたときには替えた先の記事が入っている", async () => {
    const { client, requests } = fakeClient();
    const list = new ArticleListState(client);
    // 記事のない一覧（Saved）を開いている
    const starred = list.show({ state: "starred" });
    requests[0]?.resolve([]);
    await starred;
    expect(list.articles).toEqual([]);

    // 戻るで All に替えた。読んでいる間に、記事が変わった知らせで読み直しが始まる
    const all = [article("a", 2), article("b", 1)];
    let seen: string[] | null = null;
    const shown = list.show({}).then(() => {
      seen = list.articles.map((a) => a.id);
    });
    const refreshed = list.refresh();
    expect(requests).toHaveLength(3);

    // 先に始めた読み出し（もう古い）が先に終わる。まだ show を解かない
    requests[1]?.resolve(all);
    await flush();
    expect(seen).toBeNull();

    // あとの読み出しが終わってから解け、そのときには記事が入っている
    requests[2]?.resolve(all);
    await Promise.all([shown, refreshed]);
    expect(seen).toEqual(["a", "b"]);
  });

  test("読み出しが重ならなければ、これまでどおり読み終えたときに解ける", async () => {
    const { client, requests } = fakeClient();
    const list = new ArticleListState(client);
    const shown = list.show({});
    requests[0]?.resolve([article("a", 1)]);
    await shown;
    expect(list.articles.map((a) => a.id)).toEqual(["a"]);
    expect(list.loading).toBe(false);
  });

  describe("書けず、読み直しもできなかったとき（版の違うタブのために代表とやり取りできない、など）", () => {
    /** 一覧を出したあと、書き込みも読み出しも失敗する窓口 */
    async function failingList() {
      let failing = false;
      const fail = () => Promise.reject(new Error("代表とやり取りできない"));
      const client = {
        listArticles: async () => (failing ? fail() : [article("a", 2), article("b", 1)]),
        getArticles: async () => (failing ? fail() : []),
        setRead: fail,
        setStarred: fail,
        setReadMany: fail,
      } as unknown as ReaderClient;
      const list = new ArticleListState(client);
      await list.show({});
      failing = true;
      return list;
    }

    test("既読・スターの切り替えは、押す前の表示に戻る", async () => {
      const list = await failingList();
      const a = list.find("a");
      if (a === null) throw new Error("記事がない");
      await expect(list.toggle(a, "starredAt")).rejects.toThrow("代表とやり取りできない");
      expect(list.find("a")?.starredAt).toBeNull();
      await expect(list.toggle(a, "readAt")).rejects.toThrow("代表とやり取りできない");
      expect(list.find("a")?.readAt).toBeNull();
    });

    test("まとめて既読にしたものも、押す前の表示に戻る", async () => {
      const list = await failingList();
      await expect(list.markRead(["a", "b"])).rejects.toThrow("代表とやり取りできない");
      expect(list.articles.map((a) => a.readAt)).toEqual([null, null]);
    });
  });
});
