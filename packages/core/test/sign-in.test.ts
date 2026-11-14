import { describe, expect, test, vi } from "vitest";
import { ApiError, ReaderCore } from "../src";
import { FakeSendo, TOKEN } from "./fake-sendo";
import { openMemoryDb, setup } from "./helpers";

describe("ログイン", () => {
  test("使えるトークンなら手元に置き、開き直してもログインしたまま", async () => {
    const { db, server, core } = await setup({ signIn: false });
    expect(core.isSignedIn()).toBe(false);
    await core.signIn(`  ${TOKEN}\n`);
    expect(core.isSignedIn()).toBe(true);
    expect(server.requests).toEqual(["GET /folders"]);

    const reopened = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
    });
    expect(reopened.isSignedIn()).toBe(true);
  });

  test("使えないトークンなら unauthorized で失敗し、何も置かない", async () => {
    const { core } = await setup({ signIn: false });
    const error = await core.signIn("sendo_wrong").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("unauthorized");
    expect(core.isSignedIn()).toBe(false);
  });

  test("空のトークンは送らずに失敗する", async () => {
    const { server, core } = await setup({ signIn: false });
    await expect(core.signIn("   ")).rejects.toBeInstanceOf(ApiError);
    expect(server.requests).toEqual([]);
  });

  test("sendo に届かなければ network で失敗する", async () => {
    const { server, core } = await setup({ signIn: false });
    server.failNext("network");
    const error = await core.signIn(TOKEN).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(core.isSignedIn()).toBe(false);
  });

  test("ログアウトすると、トークンと同期したデータを消す", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(1);

    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));
    await core.signOut();
    expect(core.isSignedIn()).toBe(false);
    expect(await core.listArticles()).toEqual([]);
    expect(await core.listFeeds()).toEqual([]);
    expect(await db.all("select key from settings")).toEqual([]);
    expect(changes).toEqual([["articles", "feeds", "folders"]]);
  });

  test("ログインしていなければ同期しない", async () => {
    const db = await openMemoryDb();
    const core = await ReaderCore.open({ db, baseUrl: "https://sendo.test/api/v1" });
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("unauthorized");
  });
});

describe("ログインのし直しと中断", () => {
  test("別のトークンでログインし直すと、前の手元のデータとカーソルを消して最初から同期する", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(1);

    server.token = "sendo_other_account";
    await core.signIn("sendo_other_account");
    expect(await core.listArticles()).toEqual([]);
    expect(await core.listFeeds()).toEqual([]);

    server.requests.length = 0;
    await core.sync();
    expect(server.requests).toEqual(["GET /sync"]);
  });

  test("通信が止まっていても、ログアウトはすぐ終わり、止まっていた同期は手元に書き戻さない", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    server.failNext("hang");
    const syncing = core.sync();

    await core.signOut();
    const error = await syncing.catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(core.isSignedIn()).toBe(false);
    expect(await core.listFeeds()).toEqual([]);
    expect(await db.all("select key from settings")).toEqual([]);
  });

  test("ログアウトの前に届いていたページも、ログアウトのあとには書き戻さない", async () => {
    const { server, core } = await setup();
    server.pageSize = 1;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    // 2 ページめで止める。1 ページめ（フィード）は書き込まれる
    server.failNext(null, "hang");
    const syncing = core.sync();
    await vi.waitFor(() => expect(server.requests).toHaveLength(3));

    await core.signOut();
    await syncing.catch(() => undefined);
    expect(await core.listFeeds()).toEqual([]);
    expect(await core.listArticles()).toEqual([]);
  });

  test("応答が来なければ、時間切れで network として失敗する", async () => {
    const server = new FakeSendo();
    const core = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
      requestTimeoutMs: 20,
    });
    await core.signIn(TOKEN);
    server.failNext("hang");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect((error as ApiError).message).toContain("20ms");
  });
});
