import { expect, test } from "vitest";
import { ReaderCore } from "../src";
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
