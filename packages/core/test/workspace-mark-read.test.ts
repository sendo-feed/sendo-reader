import { expect, test } from "vitest";
import { getCompleteCursor } from "../src/sync/pull";
import { setup } from "./helpers";

async function seed() {
  const { db, core, server } = await setup();
  server.workspacesSupported = true;
  const publicSpace = server.createWorkspace("Public");
  const privateSpace = server.createWorkspace("Personal");
  const folder = server.createFolder("Shared folder");
  const publicFeed = server.subscribe({
    url: "https://public.example/feed",
    workspaceId: publicSpace.id,
    folderId: folder.id,
  });
  const privateFeed = server.subscribe({
    url: "https://private.example/feed",
    workspaceId: privateSpace.id,
    folderId: folder.id,
  });
  const publicArticle = server.deliver(publicFeed.id, { title: "Public" });
  const privateArticle = server.deliver(privateFeed.id, { title: "Private" });
  await core.sync();
  return {
    db,
    core,
    server,
    publicSpace,
    privateSpace,
    folder,
    publicFeed,
    privateFeed,
    publicArticle,
    privateArticle,
  };
}

test("購読を移動してもフォルダ内の保存済みの購読 ID と同期カーソルだけで再送する", async () => {
  const {
    db,
    core,
    server,
    publicSpace,
    privateSpace,
    folder,
    publicFeed,
    privateFeed,
    publicArticle,
    privateArticle,
  } = await seed();
  const cursor = await getCompleteCursor(db);
  const options = { workspaceIds: [publicSpace.id] };
  expect(await core.markAllRead({ folderId: folder.id }, options)).toEqual([publicArticle.id]);
  expect(await core.countUnread([publicSpace.id])).toMatchObject({ total: 0 });
  expect(await core.countUnread([privateSpace.id])).toMatchObject({ total: 1 });

  server.failNext(null, "network");
  await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
  // 別端末で、2 つの購読を入れ替えても、押したときに外側だった購読は既読にしない。
  privateFeed.workspaceId = publicSpace.id;
  publicFeed.workspaceId = privateSpace.id;
  await core.sync();
  expect(server.markReadRequests).toEqual([
    { cursor, subscriptionIds: [publicFeed.subscriptionId] },
  ]);
  expect(publicArticle.readAt).not.toBeNull();
  expect(privateArticle.readAt).toBeNull();
});

test("複数の表示先を使い、90 購読を超えても同じカーソルで送る", async () => {
  const { db, core, server, publicSpace, privateSpace } = await seed();
  for (let index = 0; index < 89; index += 1) {
    const feed = server.subscribe({
      url: `https://example.com/${index}`,
      workspaceId: publicSpace.id,
    });
    server.deliver(feed.id);
  }
  await core.sync();
  const cursor = await getCompleteCursor(db);
  const ids = await core.markAllRead(
    { all: true },
    { workspaceIds: [publicSpace.id, privateSpace.id] },
  );
  expect(ids).toHaveLength(91);
  await core.sync();
  expect(server.markReadRequests).toMatchObject([{ cursor }, { cursor }]);
  const sizes = server.markReadRequests.map((body) => (body.subscriptionIds as string[]).length);
  expect(sizes).toEqual([90, 1]);
  expect([...server.inbox.values()].every((article) => article.readAt !== null)).toBe(true);
});

test("日時を絞った操作では選んだ記事 ID だけを送り、選択外の購読は変更しない", async () => {
  const { core, server, publicSpace, publicFeed, publicArticle, privateArticle } = await seed();
  server.advance(1000);
  const recent = server.deliver(publicFeed.id, { title: "New" });
  await core.sync();
  expect(
    await core.markAllRead(
      { feedId: publicFeed.id },
      {
        workspaceIds: [publicSpace.id],
        publishedBefore: recent.publishedAt,
      },
    ),
  ).toEqual([publicArticle.id]);
  await core.sync();
  expect(server.markReadRequests).toEqual([{ ids: [publicArticle.id] }]);
  expect(recent.readAt).toBeNull();
  expect(privateArticle.readAt).toBeNull();
});

test("カーソルを拒否されたら操作対象を広げず、ローカルを同期結果に戻す", async () => {
  const { core, server, publicSpace, publicArticle, privateArticle } = await seed();
  await core.markAllRead({ all: true }, { workspaceIds: [publicSpace.id] });
  server.onRequest = async (path) => {
    if (path === "POST /articles/mark-read") server.failNext(400);
  };
  const result = await core.sync();
  expect(result.push.rejected).toHaveLength(1);
  expect(await core.countPending()).toBe(0);
  expect(await core.getArticle(publicArticle.id)).toMatchObject({ readAt: null });
  expect(await core.getArticle(privateArticle.id)).toMatchObject({ readAt: null });
  expect(server.requests.filter((path) => path === "POST /articles/mark-read")).toHaveLength(1);
});

test("同期の完了位置がないときは既読にせず、操作を積まない", async () => {
  const { db, core, publicSpace, publicArticle } = await seed();
  await db.run("delete from settings where key = 'sync.completeCursor'");
  await expect(
    core.markAllRead({ all: true }, { workspaceIds: [publicSpace.id] }),
  ).rejects.toMatchObject({ code: "sync_incomplete" });
  expect(await core.getArticle(publicArticle.id)).toMatchObject({ readAt: null });
  expect(await core.countPending()).toBe(0);
});

test("操作を積んだ直後の差分で未読化が届いた記事に、古いカーソルの既読を重ねない", async () => {
  const { core, server, publicSpace, publicArticle } = await seed();
  const pullStarted = Promise.withResolvers<void>();
  const allowPull = Promise.withResolvers<void>();
  server.onRequest = async (path) => {
    if (path.startsWith("GET /sync")) {
      pullStarted.resolve();
      await allowPull.promise;
    }
  };
  const syncing = core.sync();
  await pullStarted.promise;
  try {
    await core.markAllRead({ all: true }, { workspaceIds: [publicSpace.id] });
    server.setArticleState(publicArticle.id, { read: true });
    server.setArticleState(publicArticle.id, { read: false });
  } finally {
    allowPull.resolve();
  }
  await syncing;
  await core.sync();
  expect(publicArticle.readAt).toBeNull();
  expect(await core.getArticle(publicArticle.id)).toMatchObject({ readAt: null });
});

test("同じフィードを購読し直したときも、スター記事を古い購読から既読にしない", async () => {
  const { core, server, publicSpace, publicFeed, publicArticle } = await seed();
  server.setArticleState(publicArticle.id, { starred: true });
  await core.sync();
  await core.markAllRead({ all: true }, { workspaceIds: [publicSpace.id] });
  server.unsubscribe(publicFeed.id);
  const next = server.subscribe({
    id: publicFeed.id,
    url: publicFeed.url,
    workspaceId: publicSpace.id,
  });
  expect(next.subscriptionId).not.toBe(publicFeed.subscriptionId);
  const result = await core.sync();
  expect(result.pull.reset).toBe(false);
  expect(server.markReadRequests).toMatchObject([{ subscriptionIds: [publicFeed.subscriptionId] }]);
  expect(await core.getArticle(publicArticle.id)).toMatchObject({
    readAt: null,
    starredAt: expect.any(Number),
  });
});

test("画面が認識していない購読が選択中のワークスペースに届いても、既読の対象に加えない", async () => {
  const { core, server, publicSpace, publicFeed, privateFeed, privateArticle } = await seed();
  await core.moveFeedToWorkspace(privateFeed.id, privateFeed.subscriptionId, publicSpace.id);
  await core.sync();
  expect(await core.countUnread([publicSpace.id])).toMatchObject({ total: 2 });

  await core.markAllRead(
    { all: true },
    { workspaceIds: [publicSpace.id], subscriptionIds: [publicFeed.subscriptionId] },
  );
  await core.sync();
  expect(server.markReadRequests).toMatchObject([{ subscriptionIds: [publicFeed.subscriptionId] }]);
  expect(privateArticle.readAt).toBeNull();
});

test("画面の未読数を取得してから同期が進んだときは、そのカーソルで一括既読をしない", async () => {
  const { core, server, publicSpace, publicFeed } = await seed();
  const snapshot = await core.workspaceReadCounts([publicSpace.id], 0);
  const recent = server.deliver(publicFeed.id, { title: "New" });
  await core.sync();
  await expect(
    core.markAllRead(
      { all: true },
      {
        workspaceIds: [publicSpace.id],
        subscriptionIds: [publicFeed.subscriptionId],
        expectedCursor: snapshot.cursor,
      },
    ),
  ).rejects.toMatchObject({ code: "workspace_sync_changed" });
  expect(await core.countPending()).toBe(0);
  expect(await core.getArticle(recent.id)).toMatchObject({ readAt: null });
});
