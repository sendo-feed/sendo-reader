import { describe, expect, test } from "vitest";
import { ApiError, ReaderCore } from "../src";
import { TOKEN } from "./fake-sendo";
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
