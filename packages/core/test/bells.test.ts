import { describe, expect, test } from "vitest";
import { ApiError, MAX_BELLS, ReaderCore, type Table } from "../src";
import { FakeSendo } from "./fake-sendo";
import { openMemoryDb, setup } from "./helpers";

/** 購読を 1 つ持ち、同期し終えた端末 */
async function subscribed() {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
  await context.core.sync();
  return { ...context, feed };
}

/** 手元に見える、購読だけのベルを付けたフィード */
async function belledFeeds(core: Awaited<ReturnType<typeof setup>>["core"]): Promise<string[]> {
  return (await core.listBells())
    .filter((bell) => bell.words === null && bell.feedId !== null)
    .map((bell) => bell.feedId ?? "");
}

describe("購読のベル", () => {
  test("付けると手元にすぐ出て、同期で sendo に、この端末が決めた ID のベルができる", async () => {
    const { server, core, feed } = await subscribed();
    const changes: Table[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    await core.setFeedBell(feed.id, true);
    const [local] = await core.listBells();
    expect(local).toMatchObject({ feedId: feed.id, words: null, createdAt: server.now });
    expect(changes).toEqual([["bells"]]);
    expect(server.requests).not.toContain("POST /bells");

    await core.sync();
    expect(server.bellRequests).toEqual([{ id: local?.id, feedId: feed.id }]);
    expect(server.activeBells()).toMatchObject([
      { id: local?.id, feedId: feed.id, subscriptionId: feed.subscriptionId, words: null },
    ]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([
      { ...local, subscriptionId: feed.subscriptionId, createdAt: server.now },
    ]);
  });

  test("同じ状態を頼み直しても、2 つ積まない", async () => {
    const { core, feed } = await subscribed();
    await core.setFeedBell(feed.id, true);
    await core.setFeedBell(feed.id, true);
    expect(await core.countPending()).toBe(1);
    await core.setFeedBell(feed.id, false);
    await core.setFeedBell(feed.id, false);
    expect(await core.countPending()).toBe(2);
    expect(await core.listBells()).toEqual([]);
  });

  test("届かない間に付けて外したら、戻ったときに付けてから外し、sendo でも外れたまま", async () => {
    const { server, core, feed } = await subscribed();
    await core.setFeedBell(feed.id, true);
    server.failNext("network");
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(await belledFeeds(core)).toEqual([feed.id]);

    await core.setFeedBell(feed.id, false);
    expect(await belledFeeds(core)).toEqual([]);
    expect(await core.countPending()).toBe(2);
    const result = await core.sync();
    expect(result.push).toMatchObject({ sent: 2, rejected: [] });
    expect(server.bellRequests).toHaveLength(1);
    expect(server.activeBells()).toEqual([]);
    expect([...server.bells.values()]).toMatchObject([{ deleted: true }]);
    expect(await core.listBells()).toEqual([]);
  });

  test("ほかの端末で付けたベルを取り込む前に、送る前に付けて外したら、sendo のそのベルも外れる", async () => {
    const { server, core, feed } = await subscribed();
    const other = server.addBell({ feedId: feed.id });
    await core.setFeedBell(feed.id, true);
    await core.setFeedBell(feed.id, false);
    expect(await belledFeeds(core)).toEqual([]);

    await core.sync();
    expect(server.requests).toContain(`DELETE /bells/${other.id}`);
    expect(server.activeBells()).toEqual([]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([]);
  });

  test("外してすぐ付け直すと、sendo では外したベルが消え、新しいベルが残る", async () => {
    const { server, core, feed } = await subscribed();
    const old = server.addBell({ feedId: feed.id });
    await core.sync();
    expect(await belledFeeds(core)).toEqual([feed.id]);

    await core.setFeedBell(feed.id, false);
    await core.setFeedBell(feed.id, true);
    const [local] = await core.listBells();
    expect(local?.id).not.toBe(old.id);
    await core.sync();
    expect(server.bells.get(old.id)?.deleted).toBe(true);
    expect(server.activeBells()).toMatchObject([{ id: local?.id, feedId: feed.id }]);
    expect(await belledFeeds(core)).toEqual([feed.id]);
  });

  test("付けている途中にもう一度押すと、付け終えてから外し、外れた状態が sendo に残る", async () => {
    const { server, core, feed } = await subscribed();
    await core.setFeedBell(feed.id, true);
    server.onRequest = async (path) => {
      if (path !== "POST /bells") return;
      server.onRequest = null;
      await core.setFeedBell(feed.id, false);
    };
    await core.sync();
    expect(server.bellRequests).toHaveLength(1);
    expect(server.activeBells()).toEqual([]);
    expect([...server.bells.values()]).toMatchObject([{ deleted: true }]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([]);
  });

  test("ほかの端末で同じ購読に付けてあったら、手元は sendo のベルに合わせ、そのあと外せる", async () => {
    const { server, core, feed } = await subscribed();
    const other = server.addBell({ feedId: feed.id });
    await core.setFeedBell(feed.id, true);
    await core.sync();
    expect(server.activeBells()).toMatchObject([{ id: other.id }]);
    expect(await core.listBells()).toMatchObject([{ id: other.id, feedId: feed.id }]);

    await core.setFeedBell(feed.id, false);
    await core.sync();
    expect(server.activeBells()).toEqual([]);
    expect(await core.listBells()).toEqual([]);
  });

  test("付けている途中に外し、sendo に同じ購読のベルがあったら、そのベルを外す", async () => {
    const { server, core, feed } = await subscribed();
    const other = server.addBell({ feedId: feed.id });
    await core.setFeedBell(feed.id, true);
    server.onRequest = async (path) => {
      if (path !== "POST /bells") return;
      server.onRequest = null;
      await core.setFeedBell(feed.id, false);
    };
    await core.sync();
    expect(server.requests).toContain(`DELETE /bells/${other.id}`);
    expect(server.activeBells()).toEqual([]);
    expect(await core.listBells()).toEqual([]);
  });

  test("sendo が付けたあとに応答が届かず、その間に外したら、送り直して同じベルが返り、sendo でも外れる", async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    server.signInAs();
    let lost = false;
    const core = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      now: () => server.now,
      fetch: async (input, init) => {
        const request = input as Request;
        const response = await server.fetch(input, init);
        if (
          !lost &&
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/bells")
        ) {
          lost = true;
          throw new TypeError("fetch failed");
        }
        return response;
      },
    });
    await core.restoreSession();
    await core.sync();
    await core.setFeedBell(feed.id, true);
    const [local] = await core.listBells();
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(server.activeBells()).toMatchObject([{ id: local?.id }]);

    await core.setFeedBell(feed.id, false);
    await core.sync();
    expect(server.bellRequests).toEqual([
      { id: local?.id, feedId: feed.id },
      { id: local?.id, feedId: feed.id },
    ]);
    expect(server.activeBells()).toEqual([]);
    expect([...server.bells.values()]).toMatchObject([{ id: local?.id, deleted: true }]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([]);
  });

  test("ベルが先のページに、その購読があとのページに届いても、購読が届いたらベルが見える", async () => {
    const server = new FakeSendo();
    server.signInAs();
    let reorder = false;
    let feedsPage: Record<string, unknown> | null = null;
    let beforeFeeds: unknown[] = [];
    const core: ReaderCore = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      now: () => server.now,
      fetch: async (input, init) => {
        const url = new URL((input as Request).url);
        if (!reorder || !url.pathname.endsWith("/sync")) return server.fetch(input, init);
        if (url.searchParams.get("cursor") === "bells-first") {
          beforeFeeds = await core.listBells();
          return Response.json(feedsPage);
        }
        // sendo は表ごとにページを送るので、ベルの行が購読の行より先のページに入ることがある
        const body = (await (await server.fetch(input, init)).json()) as Record<string, unknown>;
        feedsPage = { ...body, bells: [] };
        return Response.json({ ...body, feeds: [], cursor: "bells-first", hasMore: true });
      },
    });
    await core.restoreSession();
    await core.sync();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const bell = server.addBell({ feedId: feed.id });
    const changes: Table[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));

    reorder = true;
    await core.sync();
    expect(beforeFeeds).toEqual([]);
    expect(changes).toEqual([["bells"], ["bells", "feeds"]]);
    expect(await core.listBells()).toMatchObject([{ id: bell.id, feedId: feed.id }]);
  });

  test("購読がほかの端末で消されていたら、付けたベルは断られて表示が戻る", async () => {
    const { server, core, feed } = await subscribed();
    server.unsubscribe(feed.id);
    await core.setFeedBell(feed.id, true);
    expect(await belledFeeds(core)).toEqual([feed.id]);
    const changes: Table[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    const result = await core.sync();
    expect(result.push.rejected).toMatchObject([
      { op: { kind: "setFeedBell", feedId: feed.id }, error: { kind: "not_found" } },
    ]);
    expect(changes[0]).toEqual(["bells"]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([]);
    expect(server.activeBells()).toEqual([]);
  });

  test("ほかの端末で付け外ししたベルが、同期で届く", async () => {
    const { server, core, feed } = await subscribed();
    const bell = server.addBell({ feedId: feed.id });
    const result = await core.sync();
    expect(result.pull.changed).toEqual(new Set(["bells"]));
    expect(await core.listBells()).toEqual([
      {
        id: bell.id,
        subscriptionId: feed.subscriptionId,
        feedId: feed.id,
        words: null,
        createdAt: server.now,
      },
    ]);

    server.removeBell(bell.id);
    await core.sync();
    expect(await core.listBells()).toEqual([]);
  });

  test("購読をやめると、そのベルも手元からすぐ消え、sendo の外した印が届いても消えたまま", async () => {
    const { server, core, feed } = await subscribed();
    const words = server.addBell({ words: "Rust" });
    server.addBell({ feedId: feed.id });
    await core.sync();
    expect(await core.listBells()).toHaveLength(2);

    await core.unsubscribe(feed.id);
    expect(await core.listBells()).toMatchObject([{ id: words.id }]);
    await core.sync();
    expect(server.activeBells()).toMatchObject([{ id: words.id }]);
    expect(await core.listBells()).toMatchObject([{ id: words.id }]);
  });

  test("送る前のベルを付けてすぐ購読をやめると、見えず、上限にも数えない", async () => {
    const { server, core, feed } = await subscribed();
    const second = server.subscribe({ url: "https://news.example/rss", title: "News" });
    for (let i = 1; i < MAX_BELLS; i++) server.addBell({ words: `word${i}` });
    await core.sync();

    await core.setFeedBell(feed.id, true);
    await core.unsubscribe(feed.id);
    expect(await belledFeeds(core)).toEqual([]);
    expect(await core.listBells()).toHaveLength(MAX_BELLS - 1);
    await core.setFeedBell(second.id, true);
    expect(await belledFeeds(core)).toEqual([second.id]);

    await core.sync();
    const serverFeedBells = server.activeBells().filter((bell) => bell.feedId !== null);
    expect(serverFeedBells.map((bell) => bell.feedId)).toEqual([second.id]);
    expect(await belledFeeds(core)).toEqual([second.id]);
  });

  test("ベルを付けて購読をやめ、同期が届く前に購読し直しても、古いベルは見えない", async () => {
    const { server, core } = await setup();
    // 購読し直したことは、購読の ID で分かる（ワークスペースに対応した sendo が返す）
    server.workspacesSupported = true;
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    server.fetchable.set(feed.url, "Blog");
    await core.sync();
    await core.setFeedBell(feed.id, true);
    await core.unsubscribe(feed.id);

    // 購読する前に、付ける操作と購読をやめる操作を送る（受け付けたベルは手元の表に残る）
    const again = await core.subscribe(feed.url);
    expect(again?.id).toBe(feed.id);
    expect(again?.subscriptionId).not.toBe(feed.subscriptionId);
    expect(server.requests).toContain("POST /bells");
    expect(await core.listBells()).toEqual([]);

    await core.sync();
    expect(server.activeBells()).toEqual([]);
    expect(await core.listBells()).toEqual([]);
  });

  test("ワークスペースに対応した sendo でも、付けて同期したベルは見え、上限に数える", async () => {
    const { server, core } = await setup();
    // 手元の購読に ID が入るので、ベルの購読の ID と突き合わせて見せる
    server.workspacesSupported = true;
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const second = server.subscribe({ url: "https://news.example/rss", title: "News" });
    for (let i = 1; i < MAX_BELLS; i++) server.addBell({ words: `word${i}` });
    await core.sync();
    expect(feed.subscriptionId).not.toBeNull();

    await core.setFeedBell(feed.id, true);
    await core.sync();
    expect(await core.countPending()).toBe(0);
    const bells = await core.listBells();
    expect(bells.filter((bell) => bell.feedId !== null)).toMatchObject([
      { feedId: feed.id, subscriptionId: feed.subscriptionId, words: null },
    ]);
    expect(bells).toHaveLength(MAX_BELLS);
    await expect(core.setFeedBell(second.id, true)).rejects.toMatchObject({ kind: "invalid" });
  });

  test(`有効なベルは ${MAX_BELLS} 個まで。ちょうどまでは付けられ、超える分は断る`, async () => {
    const { server, core, feed } = await subscribed();
    const second = server.subscribe({ url: "https://news.example/rss", title: "News" });
    for (let i = 1; i < MAX_BELLS; i++) server.addBell({ words: `word${i}` });
    await core.sync();

    await core.setFeedBell(feed.id, true);
    expect(await core.listBells()).toHaveLength(MAX_BELLS);
    const refused = core.setFeedBell(second.id, true);
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ kind: "invalid" });
    expect(await core.countPending()).toBe(1);
  });

  test("ベルに対応する前の sendo でも同期は止まらず、付けたベルは断られて戻る", async () => {
    const { server, core, feed } = await subscribed();
    server.bellsSupported = false;
    await core.setFeedBell(feed.id, true);
    await core.sync();
    expect(await core.listBells()).toEqual([]);
    expect(await core.countPending()).toBe(0);

    // 対応したら、ベルの位置のないカーソルにも、有効なベルが最初から届く
    const removed = server.addBell({ words: "removed" });
    server.removeBell(removed.id);
    const kept = server.addBell({ feedId: feed.id });
    server.bellsSupported = true;
    await core.sync();
    expect(await core.listBells()).toMatchObject([{ id: kept.id }]);
  });

  test("ログアウトすると、ベルも消える", async () => {
    const { server, core, feed } = await subscribed();
    server.addBell({ feedId: feed.id });
    await core.sync();
    await core.signOut();
    expect(await core.listBells()).toEqual([]);
  });

  test("同期で届いたベルの形が違えば server として失敗し、手元は変えない", async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml" });
    server.addBell({ feedId: feed.id });
    server.signInAs();
    const core = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      fetch: async (input, init) => {
        const response = await server.fetch(input, init);
        if (!new URL((input as Request).url).pathname.endsWith("/sync")) return response;
        const body = (await response.json()) as { bells: Record<string, unknown>[] };
        body.bells = body.bells.map((bell) => ({ ...bell, feedId: 1 }));
        return new Response(JSON.stringify(body));
      },
    });
    await core.restoreSession();
    const error = await core.sync().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "server" });
    expect((error as ApiError).message).toContain("bells[0].feedId");
    expect(await core.listBells()).toEqual([]);
    expect(await core.listFeeds()).toEqual([]);
  });
});
