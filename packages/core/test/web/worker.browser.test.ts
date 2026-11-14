import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiError, SyncStatus, Table } from "../../src";
import { connectReader, type ReaderClient } from "../../src/web/client";
import { FakeSendo, TOKEN } from "../fake-sendo";
import { serveFakeSendo } from "./fake-bridge";

/** 1 つのタブ（ワーカーと、それにつないだ窓口） */
interface Tab {
  worker: Worker;
  client: ReaderClient;
  changes: Table[][];
  statuses: SyncStatus[];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** テストごとの名前空間で、偽の sendo と、タブを開く関数を用意する */
function world() {
  const namespace = `test-${crypto.randomUUID()}`;
  const server = new FakeSendo();
  cleanups.push(serveFakeSendo(server, `${namespace}:fake-sendo`));
  const open = (): Tab => {
    const worker = new Worker(new URL("./reader-worker.ts", import.meta.url), {
      type: "module",
      name: namespace,
    });
    cleanups.push(() => worker.terminate());
    const client = connectReader(worker);
    const tab: Tab = { worker, client, changes: [], statuses: [] };
    client.onChange((tables) => tab.changes.push([...tables].sort()));
    client.onStatus((status) => tab.statuses.push(status));
    return tab;
  };
  return { server, open };
}

describe("1 つのタブ", () => {
  test("ログインして同期し、手元の DB から読み書きできる", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml", title: "Example" });
    const article = server.deliver(feed.id, { title: "hello" });
    const { client } = open();

    expect(await client.isSignedIn()).toBe(false);
    await client.signIn(TOKEN);
    const status = await client.syncNow();
    expect(status).toMatchObject({ signedIn: true, error: null, pending: 0 });

    expect((await client.listArticles()).map((a) => a.title)).toEqual(["hello"]);
    expect(await client.listFeeds()).toMatchObject([{ id: feed.id, title: "Example" }]);

    await client.setRead(article.id, true);
    expect((await client.getArticle(article.id))?.readAt).not.toBeNull();
    await client.syncNow();
    expect(server.inbox.get(article.id)?.readAt).not.toBeNull();
  });

  test("失敗は、種類（kind）と理由（code）の付いた ApiError として届く", async () => {
    const { open } = world();
    const { client } = open();
    const error = (await client.signIn("sendo_wrong").catch((e: unknown) => e)) as ApiError;
    expect(error.name).toBe("ApiError");
    expect(error.kind).toBe("unauthorized");
    const empty = await client.createFolder("   ").catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(Error);
  });

  test("ワーカーを作り直しても（タブを開き直しても）、手元のデータとログインが残る", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await first.client.signIn(TOKEN);
    await first.client.syncNow();
    // 送る前に閉じる（書き込んでから送るまで少し待つので、まだ送っていない操作が残る）
    await first.client.setStarred(article.id, true);
    expect(await first.client.countPending()).toBe(1);
    first.worker.terminate();

    const second = open();
    expect(await second.client.isSignedIn()).toBe(true);
    expect((await second.client.getArticle(article.id))?.starredAt).not.toBeNull();
    await vi.waitFor(async () => {
      expect(await second.client.countPending()).toBe(0);
    });
    expect(server.inbox.get(article.id)?.starredAt).not.toBeNull();
  });
});

describe("複数のタブ", () => {
  test("2 つめのタブは代表に頼んで読み書きし、変更はどちらのタブにも届く", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await first.client.signIn(TOKEN);
    await first.client.syncNow();

    const second = open();
    expect((await second.client.listArticles()).map((a) => a.id)).toEqual([article.id]);
    await second.client.setStarred(article.id, true);
    expect((await first.client.getArticle(article.id))?.starredAt).not.toBeNull();
    await vi.waitFor(() => {
      expect(first.changes).toContainEqual(["articles"]);
      expect(second.changes).toContainEqual(["articles"]);
    });
  });

  test("あとから開いたタブにも、今の同期の様子が届く", async () => {
    const { open } = world();
    const first = open();
    await first.client.signIn(TOKEN);
    await first.client.syncNow();

    const second = open();
    await vi.waitFor(() => {
      expect(second.statuses.at(-1)).toMatchObject({ signedIn: true });
    });
  });

  test("代表のタブが閉じたら、ほかのタブが引き継ぎ、手元のデータも使い続けられる", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await first.client.signIn(TOKEN);
    await first.client.syncNow();
    const second = open();
    expect(await second.client.isSignedIn()).toBe(true);

    first.worker.terminate();
    // 引き継ぐ前に頼んだ呼び出しも、新しい代表が答える
    expect((await second.client.listArticles()).map((a) => a.id)).toEqual([article.id]);
    await second.client.setRead(article.id, true);
    await second.client.syncNow();
    expect(server.inbox.get(article.id)?.readAt).not.toBeNull();
  });

  test("3 つのタブで代表が 2 回入れ替わっても、どのタブからも使える", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    const tabs = [open(), open(), open()];
    await tabs[0]?.client.signIn(TOKEN);
    await tabs[0]?.client.syncNow();

    tabs[0]?.worker.terminate();
    expect(await tabs[1]?.client.countUnread()).toMatchObject({ total: 1 });
    tabs[1]?.worker.terminate();
    expect(await tabs[2]?.client.countUnread()).toMatchObject({ total: 1 });
    const folderId = await tabs[2]?.client.createFolder("Tech");
    expect(folderId?.startsWith("local-")).toBe(true);
    await tabs[2]?.client.syncNow();
    expect([...server.folders.values()].map((f) => f.name)).toEqual(["Tech"]);
  });
});
