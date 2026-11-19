import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiError, SyncStatus, Table } from "../../src";
import { connectReader, type ReaderClient } from "../../src/web/client";
import { FakeSendo } from "../fake-sendo";
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
function world(updates = false) {
  const namespace = `test-${crypto.randomUUID()}${updates ? ":updates" : ""}`;
  const server = new FakeSendo();
  const connections: string[] = [];
  if (updates) {
    const channel = new BroadcastChannel(`${namespace}:updates`);
    channel.onmessage = ({ data }: MessageEvent<string>) => connections.push(data);
    cleanups.push(() => channel.close());
  }
  cleanups.push(
    serveFakeSendo(
      server,
      `${namespace}:fake-sendo`,
      updates ? "sendo-sync.worker-test" : undefined,
    ),
  );
  /** タブを開く。"failing" なら、DB を開けないワーカーにする */
  const open = (kind: "ok" | "failing" = "ok"): Tab => {
    // Vite はワーカーのオプションを、その場に書いた値からしか読めない
    const worker =
      kind === "ok"
        ? new Worker(new URL("./reader-worker.ts", import.meta.url), {
            type: "module",
            name: namespace,
          })
        : new Worker(new URL("./failing-reader-worker.ts", import.meta.url), {
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
  /** 偽の sendo でログインしてから（Google から戻ったことにして）、タブで使い始める */
  const signIn = async (tab: Tab) => {
    server.signInAs();
    expect(await tab.client.restoreSession()).toBe(true);
  };
  return { server, open, signIn, connections };
}

describe("1 つのタブ", () => {
  test("ログインして同期し、手元の DB から読み書きできる", async () => {
    const { server, open } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml", title: "Example" });
    const article = server.deliver(feed.id, { title: "hello" });
    const { client } = open();

    expect(await client.isSignedIn()).toBe(false);
    expect(await client.restoreSession()).toBe(false);
    server.signInAs();
    expect(await client.restoreSession()).toBe(true);
    expect(await client.currentUser()).toEqual({ id: "user-1", email: "you@example.com" });
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
    const { server, open } = world();
    const { client } = open();
    server.signInAs();
    server.failNext(500);
    const error = (await client.restoreSession().catch((e: unknown) => e)) as ApiError;
    expect(error.name).toBe("ApiError");
    expect(error.kind).toBe("server");
    expect(error.code).toBe("injected");
    const empty = await client.createFolder("   ").catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(Error);
  });

  test("ワーカーを作り直しても（タブを開き直しても）、手元のデータとログインが残る", async () => {
    const { server, open, signIn } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await signIn(first);
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
    const { server, open, signIn } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await signIn(first);
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
    const { open, signIn } = world();
    const first = open();
    await signIn(first);
    await first.client.syncNow();

    const second = open();
    await vi.waitFor(() => {
      expect(second.statuses.at(-1)).toMatchObject({ signedIn: true });
    });
  });

  test("代表のタブが閉じたら、ほかのタブが引き継ぎ、手元のデータも使い続けられる", async () => {
    const { server, open, signIn } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    const first = open();
    await signIn(first);
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

  test("代表だけが通知に接続し、次の代表も接続時に差分を取る", async () => {
    const { server, open, signIn, connections } = world(true);
    const first = open();
    await signIn(first);

    const syncRequests = () =>
      server.requests.filter((request) => request.startsWith("GET /sync?")).length;
    await vi.waitFor(() => {
      expect(connections).toHaveLength(1);
      expect(syncRequests()).toBeGreaterThanOrEqual(2);
    });
    const second = open();
    expect(await second.client.isSignedIn()).toBe(true);
    expect(connections).toHaveLength(1);

    const before = syncRequests();
    first.worker.terminate();
    await vi.waitFor(() => {
      expect(connections).toHaveLength(2);
      expect(syncRequests()).toBeGreaterThanOrEqual(before + 2);
    });
    expect(connections[0]).toMatch(/\/api\/v1\/sync\/updates$/);
    expect(connections[1]).toBe(connections[0]);
  });

  test("3 つのタブで代表が 2 回入れ替わっても、どのタブからも使える", async () => {
    const { server, open, signIn } = world();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    const tabs = [open(), open(), open()];
    await signIn(tabs[0] as Tab);
    await tabs[0]?.client.syncNow();

    tabs[0]?.worker.terminate();
    expect(await tabs[1]?.client.countUnread()).toMatchObject({ total: 1 });
    tabs[1]?.worker.terminate();
    expect(await tabs[2]?.client.countUnread()).toMatchObject({ total: 1 });
    const folderId = await tabs[2]?.client.createFolder("Tech");
    expect(folderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await tabs[2]?.client.syncNow();
    expect([...server.folders.values()].map((f) => f.name)).toEqual(["Tech"]);
  });
});

describe("セッションが切れたとき", () => {
  test("通知の接続前にユーザーが替わったら、新しいユーザーの同期を待つ", async () => {
    const { server, open, signIn, connections } = world(true);
    const nextUser = { id: "user-2", email: "other@example.com" };
    let finishSync = () => {};
    const pausedSync = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    let firstSync = false;
    let switching = false;
    let waiting = false;
    server.onRequest = async (path) => {
      if (firstSync && path === "GET /me" && !switching) {
        switching = true;
        server.signInAs(nextUser);
      }
      if (path === "GET /sync" && switching && !waiting) {
        waiting = true;
        await pausedSync;
      }
      if (path === "GET /sync") firstSync = true;
    };
    const tab = open();
    await signIn(tab);
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      expect(connections).toHaveLength(0);
    } finally {
      finishSync();
    }
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    expect(await tab.client.currentUser()).toEqual(nextUser);
  });

  test("通知に接続する前にセッション切れが分かったら、同期で画面に伝える", async () => {
    const { server, open, signIn, connections } = world(true);
    let firstSync = false;
    server.onRequest = async (path) => {
      if (firstSync && path === "GET /me") server.expireSession();
      if (path === "GET /sync") firstSync = true;
    };
    const tab = open();
    await signIn(tab);
    await vi.waitFor(() => {
      expect(tab.statuses.at(-1)?.error).toBe("unauthorized");
    });
    expect(connections).toHaveLength(0);
  });

  test("ほかのタブでログインし直して戻ってきたら、代表のタブの止まっていた同期を再開する", async () => {
    const { server, open, signIn } = world();
    const first = open();
    await signIn(first);
    await first.client.syncNow();
    server.expireSession();
    expect(await first.client.syncNow()).toMatchObject({ signedIn: true, error: "unauthorized" });

    // 2 つめのタブで Google のログインを通り、戻ってきた
    server.signInAs();
    const second = open();
    expect(await second.client.restoreSession()).toBe(true);
    await vi.waitFor(() => {
      expect(first.statuses.at(-1)).toMatchObject({ signedIn: true, error: null });
    });
  });
});

describe("代表が名乗り直したときと、代表が替わったとき", () => {
  test("タブを開き足しても、ほかのタブが頼んで答えを待っている呼び出しを二重に動かさない", async () => {
    const { server, open } = world();
    const first = open();
    expect(await first.client.isSignedIn()).toBe(false);
    const second = open();
    expect(await second.client.isSignedIn()).toBe(false);

    let released = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    let verifications = 0;
    server.onRequest = async (path) => {
      // 確かめている間に届いた /me だけを数える（終わったあとの同期の /me は数えない）
      if (path === "GET /me" && !released) {
        verifications += 1;
        await held;
      }
    };
    server.signInAs();
    const signingIn = second.client.restoreSession();
    await vi.waitFor(() => expect(verifications).toBe(1));
    // 3 つめのタブを開くと、代表が名乗り直す
    const third = open();
    expect(await third.client.countPending()).toBe(0);
    release();
    await signingIn;
    expect(verifications).toBe(1);
    expect(await first.client.isSignedIn()).toBe(true);
  });

  test("同じ名前のフォルダにまとめたあと代表が替わっても、画面が持っている前の ID で操作できる", async () => {
    const { server, open, signIn } = world();
    const first = open();
    await signIn(first);
    await first.client.syncNow();
    // 別の端末で、同じ名前のフォルダを作っていた（この端末にはまだ届いていない）
    const existing = server.createFolder("Tech");
    const second = open();
    const folderId = await second.client.createFolder("Tech");
    await second.client.syncNow();
    expect(server.folders.size).toBe(1);

    first.worker.terminate();
    await second.client.renameFolder(folderId, "Technology");
    await second.client.syncNow();
    expect(server.folders.get(existing.id)?.name).toBe("Technology");
    expect(await second.client.countPending()).toBe(0);
  });
});

describe("DB を開けなかったとき", () => {
  test("待っている呼び出しも、そのあとの呼び出しも、止まらずに失敗で返す", async () => {
    const { open } = world();
    const { client } = open("failing");
    const first = await client.isSignedIn().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain("OPFS を開けない");
    // そのあとに呼んでも、もう一度開こうとして、また失敗で返す
    const second = await client.listArticles().catch((e: unknown) => e);
    expect((second as Error).message).toContain("OPFS を開けない");
  });

  test("ロックを放すので、ほかのタブが代表になれ、開けなかったタブもその代表に頼んで使える", async () => {
    const { open, signIn } = world();
    const failing = open("failing");
    await expect(failing.client.isSignedIn()).rejects.toThrow("OPFS を開けない");

    const ok = open();
    await signIn(ok);
    expect(await failing.client.isSignedIn()).toBe(true);
  });
});
