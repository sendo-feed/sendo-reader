import { describe, expect, test, vi } from "vitest";
import type { ApiError } from "../src";
import { setup } from "./helpers";

function must<T>(value: T | null): T {
  if (value === null) throw new Error("null だった");
  return value;
}

describe("フィードの候補を探す", () => {
  test("サイトの URL から候補を返す", async () => {
    const { server, core } = await setup();
    server.discoverable.set("https://blog.example/", [
      { url: "https://blog.example/feed.xml", title: "記事" },
      { url: "https://blog.example/comments.xml", title: null },
    ]);
    expect(await core.discoverFeeds("https://blog.example/")).toEqual([
      { url: "https://blog.example/feed.xml", title: "記事" },
      { url: "https://blog.example/comments.xml", title: null },
    ]);
  });

  test("取得できない、許されていない URL は、理由のコードを付けて失敗する", async () => {
    const { core } = await setup();
    const notAllowed = (await core.discoverFeeds("http://127.0.0.1/").catch((e) => e)) as ApiError;
    expect([notAllowed.kind, notAllowed.code]).toEqual(["invalid", "url_not_allowed"]);
    const failed = (await core.discoverFeeds("https://down.example/").catch((e) => e)) as ApiError;
    expect([failed.kind, failed.code]).toEqual(["invalid", "fetch_failed"]);
  });
});

describe("購読", () => {
  test("購読したフィードはすぐ手元に入り、記事は次の同期で届く", async () => {
    const { server, core } = await setup();
    server.fetchable.set("https://blog.example/feed.xml", "Blog");
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    const feed = must(await core.subscribe("https://blog.example/feed.xml"));
    expect(feed).toMatchObject({ url: "https://blog.example/feed.xml", title: "Blog" });
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id }]);
    expect(changes).toEqual([["feeds"]]);

    server.deliver(feed.id, { title: "first" });
    await core.sync();
    expect((await core.listArticles()).map((a) => a.title)).toEqual(["first"]);
  });

  test("フィードが見つからなければ feed_not_found で失敗し、手元は変えない", async () => {
    const { core } = await setup();
    const error = (await core.subscribe("https://none.example/").catch((e) => e)) as ApiError;
    expect(error.code).toBe("feed_not_found");
    expect(await core.listFeeds()).toEqual([]);
  });

  test("手元で作ったばかりのフォルダにも入れられる（あとで sendo の ID に付け替わる）", async () => {
    const { server, core } = await setup();
    server.fetchable.set("https://blog.example/feed.xml", null);
    const folderId = await core.createFolder("Tech");
    // フォルダの作成はまだ送れていない
    server.failNext("network");
    await core.sync().catch(() => undefined);

    const feed = must(await core.subscribe("https://blog.example/feed.xml", folderId));
    const [folder] = [...server.folders.values()];
    expect(folder?.name).toBe("Tech");
    expect(feed.folderId).toBe(folder?.id);
    await core.sync();
    expect(server.feeds.get(feed.id)?.folderId).toBe(folder?.id);
    expect(await core.listFeeds()).toMatchObject([{ folderId: folder?.id }]);
  });

  test("すでに購読していれば、それを返し、指定したフォルダに移す", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Tech");
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();

    const feed = must(await core.subscribe("https://blog.example/feed.xml", folder.id));
    expect(feed.id).toBe(existing.id);
    await core.sync();
    expect(server.feeds.get(existing.id)?.folderId).toBe(folder.id);
  });

  test("まだ送っていない購読の停止を先に送ってから購読する（順番を入れ替えない）", async () => {
    const { server, core } = await setup();
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    server.fetchable.set("https://blog.example/feed.xml", null);
    await core.sync();
    await core.unsubscribe(existing.id);

    const feed = must(await core.subscribe("https://blog.example/feed.xml"));
    await core.sync();
    expect(server.feeds.get(feed.id)?.deletedAt).toBeNull();
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id }]);
  });
});

describe("OPML の取り込み", () => {
  test("OPML をそのまま送り、受け付けた数を返す", async () => {
    const { server, core } = await setup();
    const xml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="a" xmlUrl="https://a.example/feed"/>
      <outline text="b" xmlUrl="https://b.example/feed"/></body></opml>`;
    expect(await core.importOpml(xml)).toEqual({ accepted: 2, skippedCount: 0, skipped: [] });
    expect(server.opmlImports).toEqual([xml]);
  });
});

describe("購読の応答を待っている間の操作", () => {
  test("待っている間にしたフォルダの移動を、応答で戻さない", async () => {
    const { server, core } = await setup();
    const tech = server.createFolder("Tech");
    const news = server.createFolder("News");
    const existing = server.subscribe({ url: "https://blog.example/feed.xml", folderId: tech.id });
    await core.sync();

    server.onRequest = async (path) => {
      if (path === "POST /feeds") await core.moveFeed(existing.id, news.id);
    };
    const feed = await core.subscribe("https://blog.example/feed.xml", tech.id);
    expect(feed?.folderId).toBe(news.id);
    expect(await core.listFeeds()).toMatchObject([{ folderId: news.id }]);
    await core.sync();
    expect(server.feeds.get(existing.id)?.folderId).toBe(news.id);
  });

  test("待っている間に購読をやめたら、応答で戻さず null を返す", async () => {
    const { server, core } = await setup();
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();

    server.onRequest = async (path) => {
      if (path === "POST /feeds") await core.unsubscribe(existing.id);
    };
    expect(await core.subscribe("https://blog.example/feed.xml")).toBeNull();
    expect(await core.listFeeds()).toEqual([]);
  });

  test("フォルダを作ったあとの操作が届かなくても、仮の ID の付け替えは覚えている", async () => {
    const { server, core } = await setup();
    server.fetchable.set("https://blog.example/feed.xml", null);
    const existing = server.subscribe({ url: "https://other.example/feed.xml" });
    await core.sync();
    const folderId = await core.createFolder("Tech");
    await core.moveFeed(existing.id, null);
    // フォルダの作成は届き、次の移動で届かなくなる
    server.failNext(null, "network");
    await core.sync().catch(() => undefined);
    const [created] = [...server.folders.values()];
    expect(created?.name).toBe("Tech");

    const feed = await core.subscribe("https://blog.example/feed.xml", folderId);
    await core.sync();
    expect(feed?.folderId).toBe(created?.id);
    expect(server.feeds.get(feed?.id ?? "")?.folderId).toBe(created?.id);
  });
});

describe("購読と OPML の、まだ送っていない操作との順番", () => {
  test("待っている間に移す先のフォルダを消したら、そのフォルダには移さない", async () => {
    const { server, core } = await setup();
    const tech = server.createFolder("Tech");
    const news = server.createFolder("News");
    const existing = server.subscribe({ url: "https://blog.example/feed.xml", folderId: tech.id });
    await core.sync();

    server.onRequest = async (path) => {
      if (path === "POST /feeds") await core.deleteFolder(news.id);
    };
    const feed = await core.subscribe("https://blog.example/feed.xml", news.id);
    expect(feed?.folderId).toBe(tech.id);
    await core.sync();
    expect(server.feeds.get(existing.id)?.folderId).toBe(tech.id);
    expect(server.folders.get(news.id)?.deletedAt).not.toBeNull();
  });

  test("OPML を取り込む前に、まだ送っていない購読の停止を送る", async () => {
    const { server, core } = await setup();
    const existing = server.subscribe({ url: "https://a.example/feed" });
    await core.sync();
    await core.unsubscribe(existing.id);

    server.onRequest = async (path) => {
      if (path === "POST /opml") {
        // 取り込みを受けた時点で、購読の停止はもう届いている
        expect(server.feeds.get(existing.id)?.deletedAt).not.toBeNull();
      }
    };
    await core.importOpml('<opml><body><outline xmlUrl="https://a.example/feed"/></body></opml>');
    expect(await core.countPending()).toBe(0);
  });
});

describe("購読と同期を 1 つずつ行う", () => {
  test("応答を待っている間に購読をやめて同期しても、古い応答でフィードを戻さない", async () => {
    const { server, core } = await setup();
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();

    let syncing: Promise<unknown> | undefined;
    server.onRequest = async (path) => {
      if (path === "POST /feeds") {
        server.onRequest = null;
        await core.unsubscribe(existing.id);
        syncing = core.sync();
      }
    };
    expect(await core.subscribe("https://blog.example/feed.xml")).toBeNull();
    await syncing;
    expect(await core.listFeeds()).toEqual([]);
    expect(server.feeds.get(existing.id)?.deletedAt).not.toBeNull();
  });
});

describe("購読を呼んだあとの操作は、購読より先に送らない", () => {
  test("先に積んだ操作を送っている間に購読をやめても、購読のあとに送る（呼んだ順を守る）", async () => {
    const { server, core } = await setup();
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();
    await core.createFolder("Tech");

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.onRequest = async (path) => {
      if (path === "POST /folders") {
        server.onRequest = null;
        await held;
      }
    };
    const subscribing = core.subscribe("https://blog.example/feed.xml");
    await vi.waitFor(() => expect(server.requests).toContain("POST /folders"));
    await core.unsubscribe(existing.id);
    release();

    expect(await subscribing).toBeNull();
    expect(server.requests.filter((r) => r.startsWith("DELETE /feeds/"))).toEqual([]);
    await core.sync();
    expect(server.feeds.get(existing.id)?.deletedAt).not.toBeNull();
    expect(await core.listFeeds()).toEqual([]);
  });

  test("購読を呼んだあとの移動を、購読より前に送る移動にまとめない", async () => {
    const { server, core } = await setup();
    const tech = server.createFolder("Tech");
    const news = server.createFolder("News");
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();
    await core.moveFeed(existing.id, tech.id);

    server.onRequest = async (path) => {
      if (path.startsWith("PATCH /feeds/")) {
        server.onRequest = null;
        await core.moveFeed(existing.id, news.id);
      }
    };
    await core.subscribe("https://blog.example/feed.xml", tech.id);
    await core.sync();
    expect(server.feeds.get(existing.id)?.folderId).toBe(news.id);
    expect(await core.listFeeds()).toMatchObject([{ folderId: news.id }]);
  });
});

describe("続けて呼んだ購読", () => {
  test("同じフィードを続けて別のフォルダに購読したら、あとから呼んだほうのフォルダになる", async () => {
    const { server, core } = await setup();
    const tech = server.createFolder("Tech");
    const news = server.createFolder("News");
    const existing = server.subscribe({ url: "https://blog.example/feed.xml" });
    await core.sync();

    const first = core.subscribe("https://blog.example/feed.xml", tech.id);
    const second = core.subscribe("https://blog.example/feed.xml", news.id);
    await Promise.all([first, second]);
    await core.sync();
    expect(server.feeds.get(existing.id)?.folderId).toBe(news.id);
    expect(await core.listFeeds()).toMatchObject([{ folderId: news.id }]);
  });
});
