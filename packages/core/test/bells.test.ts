import { describe, expect, test } from "vitest";
import {
  ApiError,
  BELL_WORDS_PROBLEMS,
  feedBell,
  MAX_BELL_WORDS,
  MAX_BELL_WORDS_LENGTH,
  MAX_BELLS,
  ReaderCore,
  type Table,
} from "../src";
import { migrate, SCHEMA_VERSION } from "../src/db/schema";
import { FakeSendo, USER } from "./fake-sendo";
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
      { op: { kind: "setBell", feedId: feed.id }, error: { kind: "not_found" } },
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
        matchKey: null,
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

  test.each([
    ["フィードの ID が文字列でない", { feedId: 1 }],
    ["購読も言葉もない", { feedId: null, words: null }],
  ])("同期で届いたベルの形が違えば（%s）server として失敗し、手元は変えない", async (_, patch) => {
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
        body.bells = body.bells.map((bell) => ({ ...bell, ...patch }));
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

/** 手元に見えるベルの組（フィードの ID と言葉） */
async function bellTargets(core: Awaited<ReturnType<typeof setup>>["core"]) {
  return (await core.listBells()).map((bell) => ({ feedId: bell.feedId, words: bell.words }));
}

/** sendo の有効なベルの組 */
function serverTargets(server: FakeSendo) {
  return server.activeBells().map((bell) => ({ feedId: bell.feedId, words: bell.words }));
}

describe("言葉のベル", () => {
  test("言葉だけのベルを付けると手元にすぐ出て、同期で sendo に言葉のベルができる", async () => {
    const { server, core } = await subscribed();
    const changes: Table[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    await core.setWordBell(" Azure\u3000障害 ", true);
    const [local] = await core.listBells();
    expect(local).toMatchObject({
      feedId: null,
      subscriptionId: null,
      words: "Azure 障害",
      matchKey: "azure 障害",
      createdAt: server.now,
    });
    expect(changes).toEqual([["bells"]]);
    expect(server.requests).not.toContain("POST /bells");

    await core.sync();
    expect(server.bellRequests).toEqual([{ id: local?.id, words: "Azure 障害" }]);
    expect(serverTargets(server)).toEqual([{ feedId: null, words: "Azure 障害" }]);
    expect(await core.countPending()).toBe(0);
    expect(await core.listBells()).toEqual([local]);
  });

  test("並びや大文字と小文字が違っても同じベルなので 2 つ作らず、もう一度押すと外れる", async () => {
    const { server, core } = await subscribed();
    await core.setWordBell("Azure 障害", true);
    await core.setWordBell("障害 azure", true);
    expect(await core.countPending()).toBe(1);
    expect(await bellTargets(core)).toEqual([{ feedId: null, words: "Azure 障害" }]);

    await core.setWordBell("AZURE 障害", false);
    expect(await core.listBells()).toEqual([]);
    await core.sync();
    expect(server.bellRequests).toHaveLength(1);
    expect(server.activeBells()).toEqual([]);
  });

  test("ほかの端末で付けた同じ組の言葉のベルがあれば、手元は sendo のベルに合わせ、外せる", async () => {
    const { server, core } = await subscribed();
    const other = server.addBell({ words: "azure 障害" });
    await core.setWordBell("Azure 障害", true);
    await core.sync();
    expect(server.activeBells()).toMatchObject([{ id: other.id }]);
    expect(await core.listBells()).toMatchObject([
      { id: other.id, words: "azure 障害", matchKey: "azure 障害" },
    ]);

    // 届いたベルと同じ組なので、付け直しても積まない
    await core.setWordBell("AZURE 障害", true);
    expect(await core.countPending()).toBe(0);
    await core.setWordBell("Azure 障害", false);
    await core.sync();
    expect(server.requests).toContain(`DELETE /bells/${other.id}`);
    expect(server.activeBells()).toEqual([]);
    expect(await core.listBells()).toEqual([]);
  });

  test("ほかの端末で付けた言葉のベルが、照合用の言葉と一緒に届き、送る前の操作が同じ組の行を隠す", async () => {
    const { server, core } = await subscribed();
    const other = server.addBell({ words: "Rust" });
    await core.sync();
    expect(await core.listBells()).toMatchObject([
      { id: other.id, feedId: null, words: "Rust", matchKey: "rust" },
    ]);

    await core.setWordBell("rust", false);
    expect(await core.listBells()).toEqual([]);
    await core.setWordBell("RUST", true);
    const [local] = await core.listBells();
    expect(local).toMatchObject({ words: "RUST", matchKey: "rust" });
    expect(local?.id).not.toBe(other.id);

    await core.sync();
    expect(server.bells.get(other.id)?.deleted).toBe(true);
    expect(server.activeBells()).toMatchObject([{ id: local?.id, words: "RUST" }]);
    expect(await core.listBells()).toEqual([local]);
  });

  test("届かない間に付けた言葉のベルは手元にすぐ出て、つながったら送られる", async () => {
    const { server, core } = await subscribed();
    server.failNext("network");
    await core.setWordBell("Azure 障害", true);
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(await bellTargets(core)).toEqual([{ feedId: null, words: "Azure 障害" }]);
    expect(server.activeBells()).toEqual([]);

    await core.sync();
    expect(serverTargets(server)).toEqual([{ feedId: null, words: "Azure 障害" }]);
    expect(await core.countPending()).toBe(0);
  });

  test(`言葉が ${MAX_BELL_WORDS} 個・${MAX_BELL_WORDS_LENGTH} 文字を超えるか空なら、積む前に断る。ちょうどは付けられる`, async () => {
    const { server, core } = await subscribed();
    const words = Array.from({ length: MAX_BELL_WORDS }, (_, i) => `w${i}`);
    const long = "あ".repeat(MAX_BELL_WORDS_LENGTH);
    const refusals: [string, string][] = [
      [[...words, "w8"].join(" "), BELL_WORDS_PROBLEMS.too_many_words],
      [`${long}い`, BELL_WORDS_PROBLEMS.too_long],
      ["Azure\u0000", BELL_WORDS_PROBLEMS.invalid_character],
      ["\u3000 ", BELL_WORDS_PROBLEMS.empty],
    ];
    for (const [input, message] of refusals) {
      const refused = core.setWordBell(input, true);
      await expect(refused).rejects.toBeInstanceOf(ApiError);
      await expect(refused).rejects.toMatchObject({ kind: "invalid", message });
    }
    expect(await core.countPending()).toBe(0);

    await core.setWordBell(words.join(" "), true);
    await core.setWordBell(long, true);
    await core.sync();
    expect(serverTargets(server)).toEqual([
      { feedId: null, words: words.join(" ") },
      { feedId: null, words: long },
    ]);
  });

  test("購読のベルに言葉を足すと購読 AND 言葉のベルになり、言葉を消すと購読だけのベルに戻る", async () => {
    const { server, core, feed } = await subscribed();
    await core.setFeedBell(feed.id, true);
    await core.sync();
    const [feedOnly] = server.activeBells();

    await core.setFeedBellWords(feed.id, "Rust");
    expect(await bellTargets(core)).toEqual([{ feedId: feed.id, words: "Rust" }]);
    // sendo にはベルを書き換える API がないので、外してから付ける
    expect(await core.countPending()).toBe(2);
    await core.sync();
    expect(server.bells.get(feedOnly?.id ?? "")?.deleted).toBe(true);
    expect(serverTargets(server)).toEqual([{ feedId: feed.id, words: "Rust" }]);
    expect(await bellTargets(core)).toEqual([{ feedId: feed.id, words: "Rust" }]);

    await core.setFeedBellWords(feed.id, "  ");
    expect(await bellTargets(core)).toEqual([{ feedId: feed.id, words: null }]);
    await core.sync();
    expect(serverTargets(server)).toEqual([{ feedId: feed.id, words: null }]);
    expect(await core.countPending()).toBe(0);
  });

  test("同じ組の言葉を入れ直しても積まない。言葉の上限を超えたら、今のベルを残して断る", async () => {
    const { core, feed } = await subscribed();
    await core.setFeedBellWords(feed.id, "Rust");
    const pending = await core.countPending();
    await core.setFeedBellWords(feed.id, "rust");
    expect(await core.countPending()).toBe(pending);

    const tooMany = Array.from({ length: MAX_BELL_WORDS + 1 }, (_, i) => `w${i}`).join(" ");
    await expect(core.setFeedBellWords(feed.id, tooMany)).rejects.toMatchObject({
      kind: "invalid",
      message: BELL_WORDS_PROBLEMS.too_many_words,
    });
    expect(await core.countPending()).toBe(pending);
    expect(await bellTargets(core)).toEqual([{ feedId: feed.id, words: "Rust" }]);
  });

  test("購読 AND 言葉のベルがある購読は、付けても何もせず、外すとその購読のベルがすべて外れる", async () => {
    const { server, core, feed } = await subscribed();
    const words = server.addBell({ words: "Azure" });
    server.addBell({ feedId: feed.id });
    server.addBell({ feedId: feed.id, words: "Rust" });
    await core.sync();

    await core.setFeedBell(feed.id, true);
    expect(await core.countPending()).toBe(0);
    await core.setFeedBell(feed.id, false);
    expect(await core.listBells()).toMatchObject([{ id: words.id }]);
    await core.sync();
    expect(serverTargets(server)).toEqual([{ feedId: null, words: "Azure" }]);
  });

  test(`有効なベルが ${MAX_BELLS} 個あっても、言葉を替えられる（外してから付ける）`, async () => {
    const { server, core, feed } = await subscribed();
    for (let i = 1; i < MAX_BELLS; i++) server.addBell({ words: `word${i}` });
    server.addBell({ feedId: feed.id });
    await core.sync();
    expect(await core.listBells()).toHaveLength(MAX_BELLS);

    await core.setFeedBellWords(feed.id, "Rust");
    await expect(core.setWordBell("Azure", true)).rejects.toMatchObject({ kind: "invalid" });
    await core.sync();
    expect(server.activeBells()).toHaveLength(MAX_BELLS);
    expect(server.activeBells().filter((bell) => bell.feedId !== null)).toMatchObject([
      { feedId: feed.id, words: "Rust" },
    ]);
  });

  test("言葉を替える操作を送っている途中に、もう一度言葉を替えると、最後の言葉のベルが sendo に残る", async () => {
    const { server, core, feed } = await subscribed();
    await core.setFeedBell(feed.id, true);
    await core.sync();
    await core.setFeedBellWords(feed.id, "Rust");
    server.onRequest = async (path) => {
      if (!path.startsWith("DELETE /bells/")) return;
      server.onRequest = null;
      await core.setFeedBellWords(feed.id, "Go");
    };
    await core.sync();
    expect(serverTargets(server)).toEqual([{ feedId: feed.id, words: "Go" }]);
    expect(await core.countPending()).toBe(0);
    expect(await bellTargets(core)).toEqual([{ feedId: feed.id, words: "Go" }]);
  });

  test("同じ購読にベルが 2 つあるとき、言葉を替えると、出しているベル（あとに作ったもの）だけを外して付け、ほかのベルは残す", async () => {
    const { server, core, feed } = await subscribed();
    const feedOnly = server.addBell({ feedId: feed.id });
    server.advance(1);
    const rust = server.addBell({ feedId: feed.id, words: "Rust" });
    await core.sync();
    expect(feedBell(await core.listBells(), feed.id)).toMatchObject({ id: rust.id });

    await core.setFeedBellWords(feed.id, "Go");
    expect(await bellTargets(core)).toEqual([
      { feedId: feed.id, words: null },
      { feedId: feed.id, words: "Go" },
    ]);
    expect(feedBell(await core.listBells(), feed.id)).toMatchObject({ words: "Go" });
    await core.sync();
    expect(server.bells.get(rust.id)?.deleted).toBe(true);
    expect(server.bells.get(feedOnly.id)?.deleted).toBe(false);
    expect(serverTargets(server)).toEqual([
      { feedId: feed.id, words: null },
      { feedId: feed.id, words: "Go" },
    ]);
  });

  test("同じ購読のほかのベルがもうその組なら、出しているベルを外すだけで、同じ組を 2 つ作らない", async () => {
    const { server, core, feed } = await subscribed();
    const feedOnly = server.addBell({ feedId: feed.id });
    server.advance(1);
    server.addBell({ feedId: feed.id, words: "Rust" });
    await core.sync();

    await core.setFeedBellWords(feed.id, "");
    expect(await core.countPending()).toBe(1);
    expect(await core.listBells()).toMatchObject([{ id: feedOnly.id }]);
    await core.sync();
    expect(server.bellRequests).toEqual([]);
    expect(serverTargets(server)).toEqual([{ feedId: feed.id, words: null }]);
  });

  test("言葉を替えるときに付けるほうが断られると（ほかの端末が同時に上限に達した）、外したベルも戻らず、その購読にベルは残らない", async () => {
    const { server, core, feed } = await subscribed();
    for (let i = 1; i < MAX_BELLS; i++) server.addBell({ words: `word${i}` });
    const feedOnly = server.addBell({ feedId: feed.id });
    await core.sync();

    await core.setFeedBellWords(feed.id, "Rust");
    // 外したあと、付ける前に、ほかの端末が空いた 1 つにベルを付ける
    server.onRequest = async (path) => {
      if (path !== "POST /bells") return;
      server.onRequest = null;
      server.addBell({ words: "other" });
    };
    const result = await core.sync();
    expect(result.push.rejected).toMatchObject([
      { op: { kind: "setBell", feedId: feed.id, words: { words: "Rust" }, on: true } },
    ]);
    expect(server.bells.get(feedOnly.id)?.deleted).toBe(true);
    expect(server.activeBells().filter((bell) => bell.feedId !== null)).toEqual([]);
    expect(await core.countPending()).toBe(0);
    expect((await core.listBells()).filter((bell) => bell.feedId !== null)).toEqual([]);
  });

  test("一覧から外すと、そのベルだけが外れる（同じ購読のほかのベルは残る）", async () => {
    const { server, core, feed } = await subscribed();
    const feedOnly = server.addBell({ feedId: feed.id });
    const rust = server.addBell({ feedId: feed.id, words: "Rust" });
    await core.sync();

    await core.removeBell(rust.id);
    await core.removeBell(rust.id);
    expect(await core.countPending()).toBe(1);
    expect(await core.listBells()).toMatchObject([{ id: feedOnly.id }]);
    await core.sync();
    expect(server.activeBells()).toMatchObject([{ id: feedOnly.id }]);
  });
});

/**
 * 前の版（言葉のベルの照合用の言葉を置く前）で、ログインして最後まで同期し終え、ベルの行を置いた
 * 手元の DB を作る
 */
async function previousVersionDb(server: FakeSendo) {
  const db = await openMemoryDb();
  await migrate(db, SCHEMA_VERSION - 1);
  const response = await server.fetch("https://sendo.test/api/v1/sync?includeBells=true");
  const page = (await response.json()) as {
    cursor: string;
    feeds: { id: string; url: string }[];
    bells: { id: string; feedId: string | null; words: string | null }[];
  };
  await db.run("insert into settings (key, value) values ('auth.user', ?), ('sync.cursor', ?)", [
    JSON.stringify(USER),
    page.cursor,
  ]);
  for (const feed of page.feeds) {
    await db.run("insert into feeds (id, url, created_at) values (?, ?, 1)", [feed.id, feed.url]);
  }
  for (const bell of page.bells) {
    await db.run("insert into bells (id, feed_id, words, created_at) values (?, ?, ?, 1)", [
      bell.id,
      bell.feedId,
      bell.words,
    ]);
  }
  return db;
}

async function openCore(server: FakeSendo, db: Awaited<ReturnType<typeof openMemoryDb>>) {
  const core = await ReaderCore.open({
    db,
    baseUrl: "https://sendo.test/api/v1",
    fetch: server.fetch,
    now: () => server.now,
  });
  await core.restoreSession();
  return core;
}

describe("前の版の手元の DB", () => {
  test("前の版で置いた言葉のベルは、次の同期で最初から取り直し、照合用の言葉と一緒に置き直す", async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const feedBell = server.addBell({ feedId: feed.id });
    server.advance(1);
    const words = server.addBell({ words: "Azure 障害" });
    server.signInAs();
    const core = await openCore(server, await previousVersionDb(server));
    // 照合用の言葉がないと、同じ組かを見分けられない。取り直すまで出さない
    expect(await core.listBells()).toMatchObject([{ id: feedBell.id }]);

    const result = await core.sync();
    expect(result.pull.reset).toBe(true);
    expect(await core.listBells()).toMatchObject([
      { id: feedBell.id, words: null, matchKey: null },
      { id: words.id, words: "Azure 障害", matchKey: "azure 障害" },
    ]);
  });

  test("前の版に言葉のベルがなければ、取り直さない", async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    const feedBell = server.addBell({ feedId: feed.id });
    server.signInAs();
    const core = await openCore(server, await previousVersionDb(server));
    const result = await core.sync();
    expect(result.pull.reset).toBe(false);
    expect(await core.listBells()).toMatchObject([{ id: feedBell.id, matchKey: null }]);
  });

  test("前の版で積んだ購読のベルの操作は、組のベルの操作として見え、送られる", async () => {
    const server = new FakeSendo();
    const feed = server.subscribe({ url: "https://blog.example/feed.xml", title: "Blog" });
    server.signInAs();
    const db = await openMemoryDb();
    await migrate(db, SCHEMA_VERSION - 1);
    // 前の版でログインして同期し、オフラインで購読にベルを付けたまま閉じた
    await db.run("insert into settings (key, value) values ('auth.user', ?)", [
      JSON.stringify(USER),
    ]);
    await db.run("insert into feeds (id, url, created_at) values (?, ?, 1)", [feed.id, feed.url]);
    const bellId = crypto.randomUUID();
    await db.run(
      "insert into pending_ops (kind, key, payload, created_at) values ('setFeedBell', ?, ?, 1)",
      [feed.id, JSON.stringify({ kind: "setFeedBell", feedId: feed.id, bellId, on: true, at: 5 })],
    );

    const core = await openCore(server, db);
    expect(await core.listBells()).toEqual([
      {
        id: bellId,
        subscriptionId: null,
        feedId: feed.id,
        words: null,
        matchKey: null,
        createdAt: 5,
      },
    ]);
    // 移した操作は、同じ組の新しい操作と同じ鍵なので、外す操作がそれを隠す
    await core.setFeedBell(feed.id, false);
    expect(await core.listBells()).toEqual([]);
    await core.sync();
    expect(server.bellRequests).toEqual([{ id: bellId, feedId: feed.id }]);
    expect(server.activeBells()).toEqual([]);
    expect(await core.countPending()).toBe(0);
  });
});
