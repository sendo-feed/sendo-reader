import { expect, test } from "vitest";
import { ReaderCore } from "../src";
import { CONFIRMED_WORKSPACE_DEFAULT_KEY } from "../src/db/workspaces";
import { getCompleteCursor } from "../src/sync/pull";
import { FakeSendo } from "./fake-sendo";
import { openMemoryDb } from "./helpers";

const DEFAULT = "72d91742-2fcd-442c-87f1-4457515824cd";
const PRIVATE = "59d6d826-6f13-4f11-ba93-5778592ffb16";
const SUBSCRIPTION = "c73848a3-0807-4545-9e03-4d380aa53eb2";
const FEED = {
  id: "feed-1",
  url: "https://example.com/feed",
  title: null,
  siteUrl: null,
  folderId: null,
  createdAt: "2026-11-25T00:00:00Z",
  deleted: false,
};
const workspace = (id: string, name: string) => ({
  id,
  name,
  createdAt: FEED.createdAt,
  deleted: false,
});

async function setup() {
  const db = await openMemoryDb();
  const legacy = new FakeSendo();
  legacy.signInAs();
  const server = {
    fetch: legacy.fetch,
  };
  const core = await ReaderCore.open({
    db,
    baseUrl: "https://sendo.test/api/v1",
    fetch: (input, init) => server.fetch(input, init),
  });
  await core.restoreSession();
  return { core, db, legacy, server };
}

test("デフォルト対応前の Reader のカーソルと一覧を引き継いでも、現在の印を補える", async () => {
  const { core, db, legacy } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  legacy.createWorkspace("Personal", PRIVATE);
  legacy.setDefaultWorkspace(PRIVATE);
  await core.sync();
  const cursor = await getCompleteCursor(db);
  // この印を保存しなかった版の Reader が同じカーソルまで取得した状態。
  await db.run("delete from settings where key = ?", [CONFIRMED_WORKSPACE_DEFAULT_KEY]);
  await db.run("update workspaces set synced_is_default = 0");
  expect((await core.listWorkspaces()).every((item) => item.isDefault === undefined)).toBe(true);
  const result = await core.sync();
  expect(result.pull.reset).toBe(false);
  expect(await getCompleteCursor(db)).toBe(cursor);
  expect(
    (await core.listWorkspaces()).filter((item) => item.isDefault).map((item) => item.id),
  ).toEqual([PRIVATE]);
  expect(legacy.requests).toContain("GET /workspaces");
});

test.each([false, true])(
  "切り替えの差分の途中で切断しても、全ページが届くまで確定した印を保つ（旧項目の削除: %s）",
  async (deletePrevious) => {
    const { core, db, legacy, server } = await setup();
    legacy.workspacesSupported = true;
    legacy.createWorkspace("default", DEFAULT);
    legacy.createWorkspace("Personal", PRIVATE);
    legacy.setDefaultWorkspace(DEFAULT);
    await core.sync();
    const cursor = await getCompleteCursor(db);
    let online = false;
    server.fetch = async (input, init) => {
      const url = new URL((input as Request).url);
      if (!url.pathname.endsWith("/sync")) return legacy.fetch(input, init);
      const base = { folders: [], feeds: [], articles: [] };
      if (url.searchParams.get("cursor") === cursor) {
        return Response.json({
          ...base,
          cursor: "default-demoted",
          hasMore: true,
          workspaces: deletePrevious
            ? [
                { id: DEFAULT, deleted: true },
                { ...workspace(PRIVATE, "Personal"), isDefault: true },
              ]
            : [{ ...workspace(DEFAULT, "default"), isDefault: false }],
        });
      }
      expect(url.searchParams.get("cursor")).toBe("default-demoted");
      if (!online) throw new TypeError("offline");
      return Response.json({
        ...base,
        cursor: "default-switched",
        hasMore: false,
        workspaces: deletePrevious ? [] : [{ ...workspace(PRIVATE, "Personal"), isDefault: true }],
      });
    };
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    const resumed = await ReaderCore.open({
      db,
      baseUrl: "https://sendo.test/api/v1",
      fetch: (input, init) => server.fetch(input, init),
    });
    await resumed.restoreSession();
    const defaults = async () =>
      (await resumed.listWorkspaces()).filter((item) => item.isDefault).map((item) => item.id);
    const partial = await resumed.workspaceData();
    expect(partial.defaultWorkspaceId).toBe(DEFAULT);
    expect(await defaults()).toEqual(deletePrevious ? [] : [DEFAULT]);
    if (deletePrevious) expect(partial.workspaces.map((row) => row.id)).not.toContain(DEFAULT);
    expect(await getCompleteCursor(db)).toBe(cursor);
    online = true;
    await resumed.sync();
    expect(await defaults()).toEqual([PRIVATE]);
  },
);

test("デフォルトを手元で切り替え、接続が戻ったら空の旧デフォルトの削除より先に送る", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  const initial = legacy.createWorkspace("default", DEFAULT);
  legacy.createWorkspace("Personal", PRIVATE);
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  await expect(core.deleteWorkspace(DEFAULT)).rejects.toMatchObject({
    code: "workspace_is_default",
  });
  await core.setDefaultWorkspace(PRIVATE);
  expect(await core.listWorkspaces()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: DEFAULT, isDefault: false }),
      expect.objectContaining({ id: PRIVATE, isDefault: true }),
    ]),
  );
  await core.deleteWorkspace(DEFAULT);
  legacy.failNext("network");
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(legacy.workspaceDefaultId).toBe(DEFAULT);
  expect(await core.countPending()).toBe(2);
  await core.sync();
  expect(legacy.workspaceDefaultId).toBe(PRIVATE);
  expect(initial.deletedAt).not.toBeNull();
  expect(await core.countPending()).toBe(0);
  expect(await core.listWorkspaces()).toMatchObject([{ id: PRIVATE, isDefault: true }]);
});

test("別端末でデフォルトになった項目の削除を拒否されたら、復元して印を揃える", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  legacy.createWorkspace("Personal", PRIVATE);
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  legacy.setDefaultWorkspace(PRIVATE);
  await core.deleteWorkspace(PRIVATE);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, isDefault: true }]);
  const result = await core.sync();
  expect(result.push.rejected).toMatchObject([{ error: { code: "workspace_is_default" } }]);
  expect(
    (await core.listWorkspaces()).filter((item) => item.isDefault).map((item) => item.id),
  ).toEqual([PRIVATE]);
});

test.each(["workspace_is_default", "workspace_not_empty"])(
  "削除拒否後に通信が切れても、拒否された削除を再送しない（%s）",
  async (code) => {
    const { core, legacy, server } = await setup();
    legacy.workspacesSupported = true;
    legacy.createWorkspace("default", DEFAULT);
    const personal = legacy.createWorkspace("Personal", PRIVATE);
    legacy.setDefaultWorkspace(DEFAULT);
    await core.sync();
    const member =
      code === "workspace_not_empty"
        ? legacy.subscribe({ url: FEED.url, workspaceId: PRIVATE })
        : null;
    if (member === null) legacy.setDefaultWorkspace(PRIVATE);
    await core.deleteWorkspace(PRIVATE);
    let rejected = false;
    server.fetch = async (input, init) => {
      const request = input as Request;
      if (rejected) throw new TypeError("offline");
      const response = await legacy.fetch(input, init);
      if (request.method === "DELETE") {
        expect(response.status).toBe(409);
        expect(await response.clone().json()).toMatchObject({ error: { code } });
        rejected = true;
      }
      return response;
    };
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(await core.countPending()).toBe(0);
    expect((await core.listWorkspaces()).find((item) => item.id === PRIVATE)).toMatchObject({
      isDefault: member === null,
    });
    server.fetch = legacy.fetch;
    if (member === null) legacy.setDefaultWorkspace(DEFAULT);
    else legacy.unsubscribe(member.id);
    await core.sync();
    expect(personal.deletedAt).toBeNull();
  },
);

test("切り替えが拒否されても、後から積んだ切り替えは表示とキューに残す", async () => {
  const { core, legacy, server } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  const removed = legacy.createWorkspace("Personal", PRIVATE);
  const reading = legacy.createWorkspace("Reading");
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  await core.setDefaultWorkspace(PRIVATE);
  await core.setDefaultWorkspace(reading.id);
  removed.deletedAt = legacy.now;
  let readingOnline = false;
  server.fetch = async (input, init) => {
    const request = input as Request;
    if (request.method === "PATCH" && request.url.endsWith(reading.id) && !readingOnline) {
      throw new TypeError("offline");
    }
    return legacy.fetch(input, init);
  };
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(await core.countPending()).toBe(1);
  expect(
    (await core.listWorkspaces()).filter((item) => item.isDefault).map((item) => item.id),
  ).toEqual([reading.id]);
  expect(legacy.workspaceDefaultId).toBe(DEFAULT);
  readingOnline = true;
  await core.sync();
  expect(legacy.workspaceDefaultId).toBe(reading.id);
});

test("ワークスペースだけに対応した Sendo ではデフォルト設定を送らない", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  legacy.createWorkspace("Personal", PRIVATE);
  await core.sync();
  await expect(core.setDefaultWorkspace(PRIVATE)).rejects.toMatchObject({
    code: "workspace_default_unavailable",
  });
  expect(await core.countPending()).toBe(0);
  await core.deleteWorkspace(PRIVATE);
  await core.sync();
  expect(legacy.requests).not.toContain(`PATCH /workspaces/${PRIVATE}`);
  expect(legacy.requests).toContain(`DELETE /workspaces/${PRIVATE}`);
});

test("デフォルト非対応の Sendo に戻ったら、切り替えとそれに続く削除を送らない", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  legacy.createWorkspace("Personal", PRIVATE);
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  await core.setDefaultWorkspace(PRIVATE);
  await core.deleteWorkspace(DEFAULT);
  legacy.workspaceDefaultId = null;
  const result = await core.sync();
  expect(result.push.rejected).toMatchObject([
    { error: { code: "workspace_default_unavailable" } },
    { error: { code: "workspace_default_unavailable" } },
  ]);
  expect(legacy.requests).not.toContain(`PATCH /workspaces/${PRIVATE}`);
  expect(legacy.requests).not.toContain(`DELETE /workspaces/${DEFAULT}`);
  expect((await core.listWorkspaces()).every((item) => item.isDefault === undefined)).toBe(true);
  legacy.workspaceDefaultId = DEFAULT;
  await core.sync();
  expect((await core.listWorkspaces()).find((item) => item.id === DEFAULT)?.isDefault).toBe(true);
});

test("デフォルトの切り替えが拒否されたら、未送信の削除で現在のデフォルトを隠さない", async () => {
  const { core, legacy, server } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  const removed = legacy.createWorkspace("Personal", PRIVATE);
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  await core.setDefaultWorkspace(PRIVATE);
  await core.deleteWorkspace(DEFAULT);
  expect(await core.listWorkspaces()).toMatchObject([{ id: PRIVATE, isDefault: true }]);
  removed.deletedAt = legacy.now;
  let deleteOnline = false;
  server.fetch = async (input, init) => {
    const request = input as Request;
    if (request.method === "DELETE" && !deleteOnline) throw new TypeError("offline");
    return legacy.fetch(input, init);
  };
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(await core.countPending()).toBe(1);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, isDefault: true }]);
  deleteOnline = true;
  const result = await core.sync();
  expect(result.push.rejected).toMatchObject([{ error: { code: "workspace_is_default" } }]);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, isDefault: true }]);
});

test("切り替えの拒否後に再表示した項目の削除が成功したら、同期を待たず通知する", async () => {
  const { core, legacy, server } = await setup();
  legacy.workspacesSupported = true;
  const initial = legacy.createWorkspace("default", DEFAULT);
  const removed = legacy.createWorkspace("Personal", PRIVATE);
  const reading = legacy.createWorkspace("Reading");
  legacy.setDefaultWorkspace(DEFAULT);
  await core.sync();
  await core.setDefaultWorkspace(PRIVATE);
  await core.deleteWorkspace(DEFAULT);
  removed.deletedAt = legacy.now;
  legacy.setDefaultWorkspace(reading.id);
  const changes: string[][] = [];
  core.onChange((tables) => changes.push([...tables].sort()));
  server.fetch = async (input, init) => {
    const path = new URL((input as Request).url).pathname;
    if (path.endsWith("/sync")) throw new TypeError("offline");
    return legacy.fetch(input, init);
  };
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(initial.deletedAt).not.toBeNull();
  expect(changes).toContainEqual(["workspaces"]);
  expect((await core.listWorkspaces()).map((item) => item.id)).toEqual([reading.id]);
});

test("古いカーソルを維持したまま購読の所属とワークスペースを別々のページから取り込む", async () => {
  const { core, db, legacy, server } = await setup();
  const feed = legacy.subscribe({ url: FEED.url });
  const article = legacy.deliver(feed.id);
  await core.sync();
  const oldCursor = await getCompleteCursor(db);
  expect(await core.workspacesAvailable()).toBe(false);
  expect(await core.listFeeds()).toMatchObject([{ id: feed.id }]);
  expect((await core.listFeeds())[0]?.workspaceId).toBeUndefined();

  let secondPageOnline = false;
  server.fetch = async (input, init) => {
    const url = new URL((input as Request).url);
    if (!url.pathname.endsWith("/sync")) return legacy.fetch(input, init);
    expect(url.searchParams.get("includeWorkspaces")).toBe("true");
    const cursor = url.searchParams.get("cursor");
    const page = { folders: [], articles: [], feeds: [] };
    if (cursor === oldCursor) {
      return Response.json({
        ...page,
        cursor: "resume",
        hasMore: true,
        feeds: [{ ...FEED, id: feed.id, workspaceId: DEFAULT, subscriptionId: SUBSCRIPTION }],
        workspaces: [],
      });
    }
    expect(cursor).toBe("resume");
    if (!secondPageOnline) throw new TypeError("offline");
    return Response.json({
      ...page,
      cursor: "complete",
      hasMore: false,
      workspaces: [workspace(DEFAULT, "default")],
    });
  };

  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(await core.workspacesAvailable()).toBe(true);
  expect(await core.listWorkspaces()).toEqual([]);
  expect(await core.listFeeds()).toMatchObject([
    { id: feed.id, workspaceId: DEFAULT, subscriptionId: SUBSCRIPTION },
  ]);
  secondPageOnline = true;
  await core.sync();
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, name: "default" }]);
  expect(await core.getArticle(article.id)).not.toBeNull();
});

test("作成、変更、購読の移動、空になったワークスペースの削除を順に同期する", async () => {
  const { core, legacy, server } = await setup();
  const writes: [string, unknown][] = [];
  let first = true;
  server.fetch = async (input, init) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sync")) {
      const initial = first;
      first = false;
      return Response.json({
        cursor: initial ? "start" : "end",
        hasMore: false,
        folders: [],
        articles: [],
        feeds: initial ? [{ ...FEED, workspaceId: DEFAULT, subscriptionId: SUBSCRIPTION }] : [],
        workspaces: initial ? [workspace(DEFAULT, "default")] : [{ id: DEFAULT, deleted: true }],
      });
    }
    if (request.method === "GET") return legacy.fetch(input, init);
    writes.push([
      `${request.method} ${path}`,
      request.method === "DELETE" ? null : await request.json(),
    ]);
    return new Response(null, { status: 204 });
  };
  await core.sync();
  await expect(core.deleteWorkspace(DEFAULT)).rejects.toMatchObject({
    code: "workspace_not_empty",
  });
  await core.createWorkspace("個人", PRIVATE);
  await core.renameWorkspace(PRIVATE, "手元の購読");
  await expect(core.moveFeedToWorkspace(FEED.id, "outdated", PRIVATE)).rejects.toMatchObject({
    kind: "not_found",
  });
  await core.moveFeedToWorkspace(FEED.id, SUBSCRIPTION, PRIVATE);
  await core.deleteWorkspace(DEFAULT);
  expect(await core.listWorkspaces()).toMatchObject([{ id: PRIVATE, name: "手元の購読" }]);
  expect(await core.listFeeds()).toMatchObject([{ id: FEED.id, workspaceId: PRIVATE }]);
  expect(await core.countPending()).toBe(4);

  await core.sync();
  expect(await core.countPending()).toBe(0);
  expect(writes).toEqual([
    ["POST /api/v1/workspaces", { id: PRIVATE, name: "個人" }],
    [`PATCH /api/v1/workspaces/${PRIVATE}`, { name: "手元の購読" }],
    [`PATCH /api/v1/feeds/${FEED.id}`, { subscriptionId: SUBSCRIPTION, workspaceId: PRIVATE }],
    [`DELETE /api/v1/workspaces/${DEFAULT}`, null],
  ]);
});

test("別端末で購読が入ったため削除を拒否されたら、サーバーのワークスペースに戻す", async () => {
  const { core, legacy, server } = await setup();
  let first = true;
  server.fetch = async (input, init) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sync")) {
      const initial = first;
      first = false;
      return Response.json({
        cursor: initial ? "start" : "end",
        hasMore: false,
        folders: [],
        articles: [],
        feeds: initial ? [] : [{ ...FEED, workspaceId: DEFAULT, subscriptionId: SUBSCRIPTION }],
        workspaces: initial ? [workspace(DEFAULT, "default")] : [],
      });
    }
    if (request.method === "DELETE" && path.endsWith(DEFAULT)) {
      return Response.json(
        { error: { code: "workspace_not_empty", message: "empty first" } },
        { status: 409 },
      );
    }
    if (path.endsWith("/workspaces")) {
      return Response.json({ items: [workspace(DEFAULT, "default")] });
    }
    return legacy.fetch(input, init);
  };
  await core.sync();
  await core.deleteWorkspace(DEFAULT);
  expect(await core.listWorkspaces()).toEqual([]);
  const result = await core.sync();
  expect(result.push.rejected).toHaveLength(1);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, name: "default" }]);
  expect(await core.listFeeds()).toMatchObject([{ workspaceId: DEFAULT }]);
});

test("未対応のサーバーでは以前の同期を続け、ワークスペースの操作をキューに入れない", async () => {
  const { core, legacy } = await setup();
  legacy.subscribe({ url: FEED.url });
  await core.sync();
  expect(await core.workspacesAvailable()).toBe(false);
  expect(await core.listWorkspaces()).toEqual([]);
  expect(await core.listFeeds()).toHaveLength(1);
  await expect(core.createWorkspace("個人", PRIVATE)).rejects.toMatchObject({
    code: "workspaces_unavailable",
  });
  expect(await core.countPending()).toBe(0);
});

test("移動先の作成拒否後に通信が途切れても、購読は最後に同期した所属に戻る", async () => {
  const { core, legacy, server } = await setup();
  server.fetch = async (input, init) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sync")) {
      return Response.json({
        cursor: "start",
        hasMore: false,
        folders: [],
        articles: [],
        feeds: [{ ...FEED, workspaceId: DEFAULT, subscriptionId: SUBSCRIPTION }],
        workspaces: [workspace(DEFAULT, "default")],
      });
    }
    if (path.endsWith("/workspaces") && request.method === "POST") {
      return Response.json(
        { error: { code: "workspace_exists", message: "duplicate" } },
        { status: 409 },
      );
    }
    if (path.endsWith("/workspaces")) return Response.json({ items: [] });
    if (request.method === "PATCH") throw new TypeError("offline");
    return legacy.fetch(input, init);
  };
  await core.sync();
  await core.createWorkspace("個人", PRIVATE);
  await core.moveFeedToWorkspace(FEED.id, SUBSCRIPTION, PRIVATE);
  await core.deleteWorkspace(DEFAULT);
  expect(await core.listFeeds()).toMatchObject([{ workspaceId: PRIVATE }]);
  expect(await core.listWorkspaces()).toMatchObject([{ id: PRIVATE }]);
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  expect(await core.countPending()).toBe(2);
  expect(await core.listFeeds()).toMatchObject([{ workspaceId: DEFAULT }]);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT }]);
});

test("先に呼んだ購読追加を送ってから、同じワークスペースの削除を送る", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  const destination = legacy.createWorkspace("default", DEFAULT);
  legacy.fetchable.set(FEED.url, "フィード");
  await core.sync();

  const checkingUser = Promise.withResolvers<void>();
  const checkedUser = Promise.withResolvers<void>();
  legacy.onRequest = async (path) => {
    if (path === "GET /me") {
      checkingUser.resolve();
      await checkedUser.promise;
    }
  };
  const subscribing = core.subscribe(FEED.url, null, destination.id);
  await checkingUser.promise;
  try {
    await core.deleteWorkspace(destination.id);
  } finally {
    checkedUser.resolve();
  }
  const feed = await subscribing;
  expect(feed?.workspaceId).toBe(destination.id);
  expect((await core.sync()).push.rejected).toHaveLength(1);
  expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT, name: "default" }]);
});

test("差分で購読が届いて削除予定のワークスペースが戻ったら購読と一緒に通知する", async () => {
  const { core, legacy } = await setup();
  legacy.workspacesSupported = true;
  legacy.createWorkspace("default", DEFAULT);
  await core.sync();

  const pulling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  legacy.onRequest = async (path) => {
    if (path.startsWith("GET /sync")) {
      pulling.resolve();
      await release.promise;
    }
  };
  const pending = core.sync();
  await pulling.promise;
  try {
    await core.deleteWorkspace(DEFAULT);
    expect(await core.listWorkspaces()).toEqual([]);
    legacy.subscribe({ url: FEED.url, workspaceId: DEFAULT });
  } finally {
    release.resolve();
  }
  const changes: string[][] = [];
  const off = core.onChange((tables) => changes.push([...tables].sort()));
  try {
    await pending;
    expect(changes).toContainEqual(["feeds", "workspaces"]);
    expect(await core.listWorkspaces()).toMatchObject([{ id: DEFAULT }]);
  } finally {
    off();
  }
});
