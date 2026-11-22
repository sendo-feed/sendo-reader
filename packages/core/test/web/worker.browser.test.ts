import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiError, SyncStatus, Table } from "../../src";
import { TABLES } from "../../src/models";
import {
  connectReader,
  PROTOCOL_VERSION,
  ProtocolMismatchError,
  type ReaderClient,
} from "../../src/web/client";
import type { PeerMessage } from "../../src/web/protocol";
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
function world() {
  const namespace = `test-${crypto.randomUUID()}`;
  const server = new FakeSendo();
  cleanups.push(serveFakeSendo(server, `${namespace}:fake-sendo`));
  /**
   * タブを開く。"failing" なら、DB を開けないワーカーにする。"other-version" なら、やり取りの
   * 版の番号が違うワーカー（版の違うタブ）にする
   */
  const open = (kind: "ok" | "failing" | "other-version" = "ok"): Tab => {
    // Vite はワーカーのオプションを、その場に書いた値からしか読めない
    const worker =
      kind === "ok"
        ? new Worker(new URL("./reader-worker.ts", import.meta.url), {
            type: "module",
            name: namespace,
          })
        : kind === "failing"
          ? new Worker(new URL("./failing-reader-worker.ts", import.meta.url), {
              type: "module",
              name: namespace,
            })
          : new Worker(new URL("./other-version-reader-worker.ts", import.meta.url), {
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
  /** この決まりより前の版の代表（番号を名乗らない）を開き、代表になるまで待つ */
  const openLegacyLeader = async () => {
    const worker = new Worker(new URL("./legacy-leader-worker.ts", import.meta.url), {
      type: "module",
      name: namespace,
    });
    cleanups.push(() => worker.terminate());
    const received: PeerMessage[] = [];
    await new Promise<void>((resolve) => {
      worker.addEventListener("message", (event: MessageEvent) => {
        if (event.data.type === "leading") resolve();
        if (event.data.type === "received") received.push(event.data.message);
      });
    });
    /** 番号を付けずに、ほかのワーカーに送る */
    const post = (message: unknown) => worker.postMessage({ type: "post", message });
    return { worker, received, post };
  };
  /** ワーカーどうしのチャンネルに、ページから加わる（この決まりより前の版のタブを真似る） */
  const joinPeers = () => {
    const channel = new BroadcastChannel(`${namespace}:peers`);
    cleanups.push(() => channel.close());
    const messages: PeerMessage[] = [];
    channel.addEventListener("message", (event: MessageEvent<PeerMessage>) => {
      messages.push(event.data);
    });
    return { channel, messages };
  };
  return { server, open, signIn, openLegacyLeader, joinPeers };
}

/** 版が合わない失敗で、相手の番号が peerVersion であることを確かめる */
async function expectMismatch(call: Promise<unknown>, peerVersion: number | null) {
  const error = await call.then(
    () => {
      throw new Error("失敗するはずが、成功した");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProtocolMismatchError);
  expect(error).toMatchObject({ peerVersion, version: PROTOCOL_VERSION });
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

describe("版の違うタブが混ざったとき", () => {
  test("代表の番号が違うと、あとから開いたタブの呼び出しはすぐ失敗し、代表は処理しない", async () => {
    const { open, signIn } = world();
    const other = open("other-version");
    await signIn(other);
    await other.client.syncNow();

    const tab = open();
    await expectMismatch(tab.client.createFolder("Tech"), PROTOCOL_VERSION + 1);
    await expectMismatch(tab.client.isSignedIn(), PROTOCOL_VERSION + 1);
    expect(await other.client.listFolders()).toEqual([]);
  });

  test("代表が番号を名乗らない（この決まりより前の版）と、頼みを送らずにすぐ失敗し、その知らせも画面に渡さない", async () => {
    const { open, openLegacyLeader, joinPeers } = world();
    const legacy = await openLegacyLeader();
    const tab = open();
    await expectMismatch(tab.client.createFolder("Tech"), null);
    await expectMismatch(tab.client.isSignedIn(), null);
    expect(legacy.received).toEqual([]);

    const { messages } = joinPeers();
    legacy.post({ type: "changed", tables: ["folders"] });
    legacy.post({ type: "status", status: { signedIn: true } });
    await vi.waitFor(() => {
      expect(messages.map((m) => m.type)).toEqual(["changed", "status"]);
    });
    // 知らせが届いていれば、そのあとの呼び出しの答えより先に、画面に渡っている
    await expectMismatch(tab.client.countPending(), null);
    expect(tab.changes).toEqual([]);
    expect(tab.statuses).toEqual([]);
  });

  test("番号のない頼み（この決まりより前の版のタブ）と番号の違う頼みは、代表が処理せずに失敗を返す", async () => {
    const { open, signIn, joinPeers } = world();
    const leader = open();
    await signIn(leader);
    const { channel, messages } = joinPeers();
    const call = { type: "call", method: "createFolder", from: "old-tab" } as const;
    channel.postMessage({ ...call, id: 1, args: ["Tech", crypto.randomUUID()] });
    channel.postMessage({
      ...call,
      version: PROTOCOL_VERSION + 1,
      id: 2,
      args: ["News", crypto.randomUUID()],
    });

    await vi.waitFor(() => {
      expect(messages.filter((m) => m.type === "result")).toHaveLength(2);
    });
    for (const id of [1, 2]) {
      expect(messages).toContainEqual({
        type: "result",
        to: "old-tab",
        id,
        result: {
          ok: false,
          error: expect.objectContaining({
            name: "ProtocolMismatchError",
            peerVersion: PROTOCOL_VERSION,
          }),
        },
      });
    }
    expect(await leader.client.listFolders()).toEqual([]);
  });

  test("答えを待っている間に代表が閉じ、番号の合わない代表に替わったら、待っていた呼び出しもすぐ失敗する", async () => {
    const { server, open } = world();
    const first = open();
    expect(await first.client.isSignedIn()).toBe(false);
    // 次の代表を待つ順：番号の違うタブ、そのあとに頼むタブ
    const other = open("other-version");
    // 番号の違うタブは、代表に頼めない（ワーカーが動き、代表のロックを待ち始めたことを確かめる）
    await expect(other.client.isSignedIn()).rejects.toMatchObject({
      name: "ProtocolMismatchError",
      peerVersion: PROTOCOL_VERSION,
    });
    const tab = open();
    expect(await tab.client.isSignedIn()).toBe(false);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // ログインを確かめている間は答えない
    server.signInAs();
    let holding = 0;
    server.onRequest = async (path) => {
      if (path === "GET /me") {
        holding += 1;
        await held;
      }
    };
    const waiting = tab.client.restoreSession();
    await vi.waitFor(() => expect(holding).toBeGreaterThan(0));
    first.worker.terminate();
    await expectMismatch(waiting, PROTOCOL_VERSION + 1);
    release();
  });

  test("番号の合わない代表が閉じたら、代表を引き継いだタブにも、番号の合う代表に替わったタブにも、すべての表と同期の様子が届き、使える", async () => {
    const { open, signIn, joinPeers } = world();
    const other = open("other-version");
    await signIn(other);
    await other.client.syncNow();
    const tabs = [open(), open()] as const;
    for (const tab of tabs) await expectMismatch(tab.client.isSignedIn(), PROTOCOL_VERSION + 1);
    tabs[0].statuses.length = 0;
    tabs[1].statuses.length = 0;

    // 番号の合わない代表の知らせは、画面に渡さない
    const { messages } = joinPeers();
    await other.client.createFolder("Tech");
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({ type: "changed" }));
    });
    for (const tab of tabs) {
      // 知らせが届いていれば、そのあとの呼び出しの答えより先に、画面に渡っている
      await expectMismatch(tab.client.countPending(), PROTOCOL_VERSION + 1);
      expect(tab.changes).toEqual([]);
      expect(tab.statuses).toEqual([]);
    }

    other.worker.terminate();
    for (const tab of tabs) {
      await vi.waitFor(() => {
        expect(tab.changes).toContainEqual([...TABLES].sort());
        expect(tab.statuses.at(-1)).toMatchObject({ signedIn: true });
      });
      expect((await tab.client.listFolders()).map((f) => f.name)).toEqual(["Tech"]);
    }
  });
});
