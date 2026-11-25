import { describe, expect, test, vi } from "vitest";
import { type ApiError, ReaderCore } from "../src";
import { migrate } from "../src/db/schema";
import { FakeSendo, USER } from "./fake-sendo";
import { openMemoryDb, setup } from "./helpers";

const USER_B = { id: "user-b", email: "b@example.com" };

describe("ログイン（sendo のセッション）", () => {
  test("sendo でログインしていれば、そのユーザーで使い始め、開き直したらネットワークを待たない", async () => {
    const { db, server, core } = await setup({ signIn: false });
    expect(core.isSignedIn()).toBe(false);
    server.signInAs();
    expect(await core.restoreSession()).toBe(true);
    expect(core.isSignedIn()).toBe(true);
    expect(core.currentUser()).toEqual(USER);
    expect(server.requests).toEqual(["GET /me"]);

    const reopened = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
    });
    expect(reopened.isSignedIn()).toBe(true);
    expect(reopened.currentUser()).toEqual(USER);
    server.requests.length = 0;
    expect(await reopened.restoreSession()).toBe(true);
    expect(server.requests).toEqual([]);
  });

  test("sendo でログインしていなければ false で、何も置かない", async () => {
    const { core, db } = await setup({ signIn: false });
    expect(await core.restoreSession()).toBe(false);
    expect(core.isSignedIn()).toBe(false);
    expect(await db.all("select key from settings")).toEqual([]);
  });

  test("sendo に届かなければ network で失敗する", async () => {
    const { server, core } = await setup({ signIn: false });
    server.signInAs();
    server.failNext("network");
    const error = await core.restoreSession().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(core.isSignedIn()).toBe(false);
  });

  test("ログアウトすると、sendo のセッションと、同期したデータとユーザーを消す", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(1);

    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));
    server.requests.length = 0;
    await core.signOut();
    // 手元はネットワークを待たずに消え、sendo へ送る印だけが残る
    expect(server.requests).toEqual([]);
    expect(core.isSignedIn()).toBe(false);
    expect(core.currentUser()).toBeNull();
    expect(await core.listArticles()).toEqual([]);
    expect(await core.listFeeds()).toEqual([]);
    expect(await db.all("select key from settings")).toEqual([{ key: "auth.logoutPending" }]);
    expect(changes).toEqual([
      ["articles", "feeds", "folders", "savedPages", "settings", "workspaces"],
    ]);

    expect(await core.sendPendingSignOut()).toBe(true);
    expect(server.requests).toEqual(["POST /auth/logout"]);
    expect(server.sessions.size).toBe(0);
    expect(await db.all("select key from settings")).toEqual([]);
    // 送るものがなければ、何も送らない
    expect(await core.sendPendingSignOut()).toBe(true);
    expect(server.requests).toEqual(["POST /auth/logout"]);
  });

  test("ログアウトは、sendo からの答えが止まっていても待たない", async () => {
    const { server, core } = await setup();
    server.failNext("hang");
    await core.signOut();
    expect(core.isSignedIn()).toBe(false);
  });

  test("ログアウトが sendo に届かなくても手元は消し、残ったクッキーでは自動でログインしない", async () => {
    const { server, core, db } = await setup();
    await core.signOut();
    server.failNext("network");
    expect(await core.sendPendingSignOut()).toBe(false);
    expect(core.isSignedIn()).toBe(false);
    expect(await db.all("select key from settings")).toEqual([{ key: "auth.logoutPending" }]);

    // 開き直しても、sendo に聞かずにログインしていないことにする
    server.requests.length = 0;
    expect(await core.restoreSession()).toBe(false);
    expect(server.requests).toEqual([]);

    // ログインの操作をしたら、先にログアウトを送る
    await core.prepareSignIn();
    expect(server.sessions.size).toBe(0);
    expect(await db.all("select key from settings")).toEqual([]);
    server.signInAs();
    expect(await core.restoreSession()).toBe(true);
  });

  test("ログアウトを送れないうちは、ログインに進ませない", async () => {
    const { server, core, db } = await setup();
    await core.signOut();
    server.failNext("network");
    const error = await core.prepareSignIn().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(await db.all("select key from settings")).toEqual([{ key: "auth.logoutPending" }]);
  });

  test("送れていないログアウトがなければ、prepareSignIn は何も送らない", async () => {
    const { server, core } = await setup({ signIn: false });
    await core.prepareSignIn();
    expect(server.requests).toEqual([]);
  });

  test("ログインしていなければ同期しない", async () => {
    const db = await openMemoryDb();
    const core = await ReaderCore.open({ db, baseUrl: "https://sendo.test/api/v1" });
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("unauthorized");
  });

  test("前の版のトークンは消し、手元の行は次にログインしたときに消す", async () => {
    const server = new FakeSendo();
    const db = await openMemoryDb();
    await migrate(db, 3);
    await db.run("insert into settings (key, value) values ('auth.token', 'sendo_old')");
    await db.run(`insert into folders (id, name, created_at) values ('old-folder', 'Old', 0)`);
    const core = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
    });
    expect(await db.all("select key from settings")).toEqual([]);
    expect(core.isSignedIn()).toBe(false);

    server.signInAs();
    await core.restoreSession();
    expect(await core.listFolders()).toEqual([]);
  });
});

describe("送る前に、セッションのユーザーを確かめる", () => {
  test("セッションが切れたら unauthorized で失敗し、手元のデータと操作を残す。ログインし直したら続きから送る", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    await core.sync();
    await core.setStarred(article.id, true);

    server.expireSession();
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("unauthorized");
    expect(core.isSignedIn()).toBe(true);
    expect(await core.listArticles()).toHaveLength(1);
    expect(await core.countPending()).toBe(1);

    server.signInAs();
    server.requests.length = 0;
    await core.sync();
    expect(server.inbox.get(article.id)?.starredAt).toEqual(expect.any(Number));
    expect(server.requests[0]).toBe("GET /me");
    expect(server.requests.at(-1)).toMatch(/^GET \/sync\?cursor=/);
  });

  test("別のユーザーでログインしていたら、前のユーザーの操作は送らず、手元を消して最初から同期する", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    const article = server.deliver(feed.id);
    await core.sync();
    await core.setStarred(article.id, true);
    // 別のユーザーの受信箱には、この記事がない（偽の sendo は行を分けないので、消した記録を
    // 残さずに消して見立てる）
    server.inbox.delete(article.id);

    server.signInAs(USER_B);
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));
    server.requests.length = 0;
    await core.sync();
    expect(core.currentUser()).toEqual(USER_B);
    expect(server.requests).toEqual([
      "GET /me",
      "GET /sync?includeSaved=true&includeWorkspaces=true",
    ]);
    expect(await core.listArticles()).toEqual([]);
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id }]);
    expect(await core.countPending()).toBe(0);
    expect(changes[0]).toEqual([
      "articles",
      "feeds",
      "folders",
      "savedPages",
      "settings",
      "workspaces",
    ]);
  });

  test("別のユーザーでログインしていたら、前のユーザーのために頼まれた購読は送らない", async () => {
    const { server, core } = await setup();
    server.fetchable.set("https://example.com/feed.xml", "Feed");
    server.signInAs(USER_B);
    const error = await core.subscribe("https://example.com/feed.xml").catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("unauthorized");
    expect(server.feeds.size).toBe(0);
    expect(core.currentUser()).toEqual(USER_B);
  });

  test("同じユーザーでメールが変わっていたら、手元を残してメールだけ置き直す", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();

    const session = server.sessions.get(server.cookie ?? "");
    if (session === undefined) throw new Error("セッションがない");
    session.email = "renamed@example.com";
    await core.sync();
    expect(core.currentUser()).toEqual({ id: USER.id, email: "renamed@example.com" });
    expect(await core.listArticles()).toHaveLength(1);
    const reopened = await ReaderCore.open({ db, baseUrl: "https://sendo.test/api/v1" });
    expect(reopened.currentUser()?.email).toBe("renamed@example.com");
  });
});

describe("ログアウトと中断", () => {
  test("通信が止まっていても、ログアウトはすぐ終わり、止まっていた同期は手元に書き戻さない", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    // /me は通り、差分の取り込みで止まる
    server.failNext(null, "hang");
    const syncing = core.sync();
    await vi.waitFor(() =>
      expect(server.requests.at(-1)).toBe("GET /sync?includeSaved=true&includeWorkspaces=true"),
    );

    await core.signOut();
    const error = await syncing.catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(core.isSignedIn()).toBe(false);
    expect(await core.listFeeds()).toEqual([]);
    expect(await db.all("select key from settings")).toEqual([{ key: "auth.logoutPending" }]);
  });

  test("ログアウトの前に届いていたページも、ログアウトのあとには書き戻さない", async () => {
    const { server, core } = await setup();
    server.pageSize = 1;
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    // /me と 1 ページめ（フィード）は通り、2 ページめで止める
    server.requests.length = 0;
    server.failNext(null, null, "hang");
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
    server.signInAs();
    await core.restoreSession();
    server.failNext("hang");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect((error as ApiError).message).toContain("20ms");
  });

  test("ヘッダーのあとで本文が止まっても、時間切れで network として失敗し、本文を取り消す", async () => {
    const server = new FakeSendo();
    const core = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      fetch: server.fetch,
      requestTimeoutMs: 20,
    });
    server.signInAs();
    await core.restoreSession();
    server.failNext("hang-body");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect((error as ApiError).message).toContain("20ms");
    expect(server.cancelledBodies).toBe(1);

    // 同期の列が止まったままにならず、次の同期は進む
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(1);
  });

  test("本文が止まっていても、ログアウトで終わり、ログインし直せば同期できる", async () => {
    const { server, core } = await setup();
    server.failNext(null, "hang-body");
    const syncing = core.sync();
    await vi.waitFor(() =>
      expect(server.requests).toContain("GET /sync?includeSaved=true&includeWorkspaces=true"),
    );

    await core.signOut();
    const error = await syncing.catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(server.cancelledBodies).toBe(1);

    // ログインの操作をして（先にログアウトを送る）、Google から戻ってきた
    await core.prepareSignIn();
    server.signInAs();
    expect(await core.restoreSession()).toBe(true);
    const feed = server.subscribe({ url: "https://example.com/feed.xml" });
    server.deliver(feed.id);
    await core.sync();
    expect(await core.listArticles()).toHaveLength(1);
  });
});

describe("ログインとログアウトが重なったとき", () => {
  test("ユーザーを確かめている間にログアウトしたら、ログインは中断され、ユーザーを置かずに false を返す", async () => {
    const { server, core, db } = await setup({ signIn: false });
    server.signInAs();
    server.onRequest = async (path) => {
      if (path === "GET /me") await core.signOut();
    };
    expect(await core.restoreSession()).toBe(false);
    expect(core.isSignedIn()).toBe(false);
    expect(await db.all("select key from settings")).toEqual([{ key: "auth.logoutPending" }]);
  });

  test("確かめている間にログアウトして答えが止まっていても、ログインは中断される", async () => {
    const { server, core } = await setup({ signIn: false });
    server.signInAs();
    server.failNext("hang");
    const restoring = core.restoreSession();
    await core.signOut();
    expect(await restoring).toBe(false);
    expect(core.isSignedIn()).toBe(false);
  });

  test("確かめている間にログアウトして本文が止まっていても、ログインは中断される", async () => {
    const { server, core } = await setup({ signIn: false });
    server.signInAs();
    server.failNext("hang-body");
    const restoring = core.restoreSession();
    await vi.waitFor(() => expect(server.requests).toEqual(["GET /me"]));
    await core.signOut();
    expect(await restoring).toBe(false);
    expect(core.isSignedIn()).toBe(false);
    expect(server.cancelledBodies).toBe(1);
  });

  test("先に始めた確かめが遅れて返っても、あとから置いたユーザーを上書きしない", async () => {
    const { server, core } = await setup({ signIn: false });
    server.signInAs(USER_B);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.onRequest = async (path) => {
      if (path === "GET /me") {
        server.onRequest = null;
        await held;
      }
    };
    const first = core.restoreSession();
    await vi.waitFor(() => expect(server.onRequest).toBeNull());
    expect(await core.restoreSession()).toBe(true);
    expect(core.currentUser()).toEqual(USER_B);

    // 遅れた答えは、別のユーザーのものになっていた
    server.signInAs();
    release();
    // 先に始めたほうは、そのときの様子（ログインしている）を返す
    expect(await first).toBe(true);
    expect(core.currentUser()).toEqual(USER_B);
  });

  test("手元の DB を消すとき（ログアウト、ユーザーの切り替え）にだけ、DB の外のデータも消してもらう", async () => {
    let cleared = 0;
    const { server, core } = await setup({
      onDataCleared: async () => {
        cleared += 1;
      },
    });
    // 初めて使い始めたときにも消す（前に使っていた人のものが残っていないように）
    expect(cleared).toBe(1);
    await core.sync();
    expect(cleared).toBe(1);

    // セッションが切れただけでは、手元のデータと同じく残す
    server.expireSession();
    await core.sync().catch(() => {});
    expect(cleared).toBe(1);

    // 別のユーザーに替わったら消す
    server.signInAs(USER_B);
    await core.sync();
    expect(cleared).toBe(2);

    // ログアウトで消す。消すのに失敗しても、ログアウトは終わる
    await core.signOut();
    expect(cleared).toBe(3);
  });

  test("DB の外のデータを消せなくても、ログアウトは終わる", async () => {
    const { core } = await setup({
      onDataCleared: () => Promise.reject(new Error("キャッシュを消せない")),
    });
    await core.signOut();
    expect(core.isSignedIn()).toBe(false);
  });
});
