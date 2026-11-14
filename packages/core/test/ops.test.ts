import { describe, expect, test } from "vitest";
import type { ApiError } from "../src";
import { createSendoApi } from "../src/api/client";
import { normalizeFolderName } from "../src/reader";
import { pull } from "../src/sync/pull";
import { listPending } from "../src/sync/queue";
import { TOKEN } from "./fake-sendo";
import { setup } from "./helpers";

/** 記事が 1 件ある状態で同期を済ませる */
async function withArticle() {
  const context = await setup();
  const feed = context.server.subscribe({ url: "https://example.com/feed.xml" });
  const article = context.server.deliver(feed.id, { title: "a" });
  await context.core.sync();
  return { ...context, feed, article };
}

/** 送らずに、差分の取り込みだけをする（送り終えていない操作が残ったまま取り込む場面） */
async function pullOnly(context: Awaited<ReturnType<typeof setup>>) {
  const api = createSendoApi({
    baseUrl: "https://sendo.test/api/v1",
    token: () => TOKEN,
    fetch: context.server.fetch,
  });
  return pull(context.db, api, { now: () => context.server.now });
}

describe("既読とスター", () => {
  test("手元にすぐ反映し、同期で sendo に送る", async () => {
    const { server, core, article } = await withArticle();
    await core.setRead(article.id, true);
    await core.setStarred(article.id, true);

    expect(await core.getArticle(article.id)).toMatchObject({
      readAt: server.now,
      starredAt: server.now,
    });
    expect(await core.countPending()).toBe(1);
    expect(server.inbox.get(article.id)?.readAt).toBeNull();

    const result = await core.sync();
    expect(result.push.sent).toBe(1);
    expect(await core.countPending()).toBe(0);
    expect(server.inbox.get(article.id)).toMatchObject({
      readAt: server.now,
      starredAt: server.now,
    });
  });

  test("届かなければ操作は残り、手元の変更も保ったまま、次の同期で送る", async () => {
    const { server, core, article } = await withArticle();
    await core.setRead(article.id, true);
    server.failNext("network");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect(await core.countPending()).toBe(1);
    expect((await core.getArticle(article.id))?.readAt).not.toBeNull();

    await core.sync();
    expect(await core.countPending()).toBe(0);
    expect(server.inbox.get(article.id)?.readAt).not.toBeNull();
  });

  test("まだ送っていない操作は、同期で届いた古い状態の上に重ね直す", async () => {
    const context = await withArticle();
    const { server, core, article } = context;
    await core.setRead(article.id, true);
    // 別の端末でスターを付けた（sendo ではまだ未読）
    server.setArticleState(article.id, { starred: true });

    await pullOnly(context);
    expect(await core.getArticle(article.id)).toMatchObject({
      starredAt: server.now,
      readAt: server.now,
    });
  });

  test("ぶつかったら、sendo が後から受けたほうを採る", async () => {
    const { server, core, article } = await withArticle();
    await core.setRead(article.id, true);
    await core.sync();
    // 別の端末で未読に戻した（あとから受けた）
    server.advance(1000);
    server.setArticleState(article.id, { read: false });
    await core.sync();
    expect((await core.getArticle(article.id))?.readAt).toBeNull();
  });

  test("最後の操作が同じ記事への既読・スターなら、1 つにまとめる", async () => {
    const { core, article, db } = await withArticle();
    await core.setRead(article.id, true);
    await core.setStarred(article.id, true);
    await core.setRead(article.id, false);
    const pending = await listPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.op).toMatchObject({
      kind: "setArticleState",
      articleId: article.id,
      read: false,
      starred: true,
    });
  });

  test("あいだに別の操作があれば、まとめない（送る順番を変えない）", async () => {
    const context = await withArticle();
    const { server, core, article } = context;
    await core.setRead(article.id, false);
    await core.markAllRead({ all: true });
    await core.setRead(article.id, false);
    expect((await listPending(context.db)).map((p) => p.op.kind)).toEqual([
      "setArticleState",
      "markRead",
      "setArticleState",
    ]);
    await core.sync();
    // 最後に未読に戻したので、sendo でも未読
    expect(server.inbox.get(article.id)?.readAt).toBeNull();
    expect((await core.getArticle(article.id))?.readAt).toBeNull();
  });

  test("送っている途中にまとめられた操作は、送り終えても消さずにもう一度送る", async () => {
    const { server, core, article } = await withArticle();
    await core.setRead(article.id, true);
    let changed = false;
    server.onRequest = async (path) => {
      if (path.startsWith("PATCH /articles/") && !changed) {
        changed = true;
        await core.setStarred(article.id, true);
      }
    };
    await core.sync();
    // まとめた操作を、同じ同期の中でもう一度送る
    expect(server.requests.filter((r) => r.startsWith("PATCH /articles/"))).toHaveLength(2);
    expect(await core.countPending()).toBe(0);
    expect(server.inbox.get(article.id)?.starredAt).not.toBeNull();
  });

  test("sendo になくなった記事への操作は捨て、手元からも消す", async () => {
    const { server, core, article } = await withArticle();
    await core.setStarred(article.id, true);
    server.inbox.delete(article.id);
    const result = await core.sync();
    expect(result.push.rejected.map((r) => r.error.kind)).toEqual(["not_found"]);
    expect(await core.getArticle(article.id)).toBeNull();
    expect(await core.countPending()).toBe(0);
  });

  test("サーバーの不具合やトークンの取り消しでは止め、操作を残す", async () => {
    const { server, core, article, db } = await withArticle();
    await core.setRead(article.id, true);
    server.failNext(500);
    expect(((await core.sync().catch((e: unknown) => e)) as ApiError).kind).toBe("server");
    server.token = "sendo_rotated";
    expect(((await core.sync().catch((e: unknown) => e)) as ApiError).kind).toBe("unauthorized");
    expect(await db.all("select attempts from pending_ops")).toEqual([{ attempts: 2 }]);
  });
});

describe("すべて既読", () => {
  test("押したときに手元にあった記事だけを既読にし、カーソルを境界に送る", async () => {
    const { server, core, feed, article } = await withArticle();
    await core.markAllRead({ all: true });
    expect((await core.getArticle(article.id))?.readAt).toBe(server.now);

    // 押したあと、送る前に届いた記事は未読のまま
    const later = server.deliver(feed.id, { title: "later" });
    await core.sync();
    expect(server.markReadRequests).toHaveLength(1);
    expect(server.markReadRequests[0]).toMatchObject({ all: true });
    expect(typeof server.markReadRequests[0]?.cursor).toBe("string");
    expect(server.inbox.get(article.id)?.readAt).not.toBeNull();
    expect(server.inbox.get(later.id)?.readAt).toBeNull();
    expect((await core.getArticle(later.id))?.readAt).toBeNull();
  });

  test("あとから届いた記事は、重ね直しでも既読にしない", async () => {
    const context = await withArticle();
    const { server, core, feed } = context;
    await core.markAllRead({ feedId: feed.id });
    const later = server.deliver(feed.id);
    await pullOnly(context);
    expect((await core.getArticle(later.id))?.readAt).toBeNull();
  });

  test("フィードやフォルダで絞って既読にする", async () => {
    const { server, core } = await setup();
    const folder = server.createFolder("Tech");
    const a = server.subscribe({ url: "https://a.example/feed", folderId: folder.id });
    const b = server.subscribe({ url: "https://b.example/feed" });
    const inA = server.deliver(a.id);
    const inB = server.deliver(b.id);
    await core.sync();

    await core.markAllRead({ folderId: folder.id });
    expect((await core.getArticle(inA.id))?.readAt).not.toBeNull();
    expect((await core.getArticle(inB.id))?.readAt).toBeNull();
    await core.sync();
    expect(server.inbox.get(inA.id)?.readAt).not.toBeNull();
    expect(server.inbox.get(inB.id)?.readAt).toBeNull();
  });

  test("まだ一度も同期していなければ、何もしない", async () => {
    const { core } = await setup();
    await core.markAllRead({ all: true });
    expect(await core.countPending()).toBe(0);
  });
});

describe("フォルダ", () => {
  test("手元で作ったフォルダは仮の ID で使え、sendo が付けた ID に付け替える", async () => {
    const { server, core, feed } = await withArticle();
    const tempId = await core.createFolder("  Tech   news ");
    await core.moveFeed(feed.id, tempId);
    expect(await core.listFolders()).toMatchObject([{ id: tempId, name: "Tech news" }]);
    expect(await core.listFeeds()).toMatchObject([{ folderId: tempId }]);

    await core.sync();
    const [created] = [...server.folders.values()];
    expect(created?.name).toBe("Tech news");
    expect(server.feeds.get(feed.id)?.folderId).toBe(created?.id);
    expect(await core.listFolders()).toMatchObject([{ id: created?.id, name: "Tech news" }]);
    expect(await core.listFeeds()).toMatchObject([{ folderId: created?.id }]);
    expect(await core.countPending()).toBe(0);
  });

  test("同じ名前のフォルダが sendo にあれば、それに付け替える", async () => {
    const { server, core } = await withArticle();
    const existing = server.createFolder("Tech");
    const tempId = await core.createFolder("Tech");
    await core.sync();
    expect(server.folders.size).toBe(1);
    expect((await core.listFolders()).map((f) => f.id)).toEqual([existing.id]);
    expect(tempId).not.toBe(existing.id);
  });

  test("名前の変更を受け付けられなかったら、sendo の名前に戻す", async () => {
    const { server, core } = await withArticle();
    const tech = server.createFolder("Tech");
    server.createFolder("News");
    await core.sync();

    await core.renameFolder(tech.id, "News");
    expect((await core.listFolders()).find((f) => f.id === tech.id)?.name).toBe("News");
    const result = await core.sync();
    expect(result.push.rejected.map((r) => r.error.kind)).toEqual(["conflict"]);
    expect((await core.listFolders()).find((f) => f.id === tech.id)?.name).toBe("Tech");
  });

  test("消したフォルダへの移動を受け付けられなかったら、sendo の所属に戻す", async () => {
    const { server, core, feed } = await withArticle();
    const gone = server.createFolder("Gone");
    await core.sync();
    await core.moveFeed(feed.id, gone.id);
    server.deleteFolder(gone.id);

    const result = await core.sync();
    expect(result.push.rejected.map((r) => r.error.kind)).toEqual(["invalid"]);
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id, folderId: null }]);
  });

  test("フォルダを消すと、手元でもフィードをフォルダなしに戻す。sendo になくても成功とする", async () => {
    const { server, core, feed } = await withArticle();
    const folder = server.createFolder("Tech");
    server.moveFeed(feed.id, folder.id);
    await core.sync();

    await core.deleteFolder(folder.id);
    expect(await core.listFolders()).toEqual([]);
    expect(await core.listFeeds()).toMatchObject([{ folderId: null }]);
    server.deleteFolder(folder.id);
    const result = await core.sync();
    expect(result.push).toEqual({ sent: 1, rejected: [], remapped: [] });
  });

  test("フォルダ名は空白をまとめ、200 文字（UTF-16）で切り、サロゲートペアの途中では切らない", () => {
    expect(normalizeFolderName(" a \n b ")).toBe("a b");
    expect(() => normalizeFolderName("  ")).toThrow(RangeError);
    expect(normalizeFolderName("x".repeat(250))).toHaveLength(200);
    const emoji = `${"x".repeat(199)}😀`;
    expect(normalizeFolderName(emoji)).toBe("x".repeat(199));
  });
});

describe("購読をやめる", () => {
  test("手元ではフィードと、スターのない記事をすぐ消し、sendo にも送る", async () => {
    const { server, core, feed, article } = await withArticle();
    const starred = server.deliver(feed.id);
    server.setArticleState(starred.id, { starred: true });
    await core.sync();

    await core.unsubscribe(feed.id);
    expect(await core.listFeeds()).toEqual([]);
    expect((await core.listArticles()).map((a) => a.id)).toEqual([starred.id]);
    await core.sync();
    expect(server.feeds.get(feed.id)?.deletedAt).not.toBeNull();
    expect(await core.getArticle(article.id)).toBeNull();
  });
});

describe("ログインとの関係", () => {
  test("ログインしていなければ書き込めない", async () => {
    const { core } = await setup({ signIn: false });
    const error = await core.setRead("x", true).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("unauthorized");
  });

  test("ログアウトすると、まだ送っていない操作も消す", async () => {
    const { core, article, db } = await withArticle();
    await core.setRead(article.id, true);
    await core.signOut();
    expect(await db.all("select id from pending_ops")).toEqual([]);
  });

  test("送っている途中にログアウトしたら、操作の結果を手元に書かない", async () => {
    const { server, core, article, db } = await withArticle();
    const tempId = await core.createFolder("Tech");
    server.onRequest = async (path) => {
      if (path === "POST /folders") await core.signOut();
    };
    await core.sync().catch(() => undefined);
    expect(await db.all("select id from folders")).toEqual([]);
    expect(tempId.startsWith("local-")).toBe(true);
    expect(await core.getArticle(article.id)).toBeNull();
  });

  test("カーソルが古すぎて作り直しても、まだ送っていない操作は重ね直す", async () => {
    const context = await withArticle();
    const { server, core, article } = context;
    const gone = server.createFolder("Gone");
    await core.sync();
    await core.setStarred(article.id, true);
    server.deleteFolder(gone.id);
    server.purgeTombstones();

    const result = await pullOnly(context);
    expect(result.reset).toBe(true);
    expect((await core.getArticle(article.id))?.starredAt).not.toBeNull();
    expect(await core.countPending()).toBe(1);
  });
});

describe("受け付けられなかった操作の扱い", () => {
  test("送っている間に新しい操作がまとめられていたら、断られても捨てずに送り直す", async () => {
    const { server, core } = await withArticle();
    const tech = server.createFolder("Tech");
    server.createFolder("News");
    await core.sync();

    await core.renameFolder(tech.id, "News");
    server.onRequest = async (path) => {
      if (path === `PATCH /folders/${tech.id}` && server.folders.get(tech.id)?.name === "Tech") {
        server.onRequest = null;
        await core.renameFolder(tech.id, "Technology");
      }
    };
    const result = await core.sync();
    expect(result.push.rejected).toEqual([]);
    expect(server.folders.get(tech.id)?.name).toBe("Technology");
    expect((await core.listFolders()).find((f) => f.id === tech.id)?.name).toBe("Technology");
    expect(await core.countPending()).toBe(0);
  });

  test("まとめて既読を断られたら、最初から取り直して sendo の状態に戻す", async () => {
    const { server, core, article } = await withArticle();
    await core.markAllRead({ all: true });
    expect((await core.getArticle(article.id))?.readAt).not.toBeNull();

    server.failNext(400);
    const result = await core.sync();
    expect(result.push.rejected.map((r) => r.error.kind)).toEqual(["invalid"]);
    expect(result.pull.pages).toBeGreaterThan(0);
    expect((await core.getArticle(article.id))?.readAt).toBeNull();
  });

  test("戻し方の決まっていない操作を断られても、残りの操作は取り直したあとに重ね直す", async () => {
    const { server, core, feed, article } = await withArticle();
    const folder = server.createFolder("Tech");
    await core.sync();
    await core.deleteFolder(folder.id);
    await core.setStarred(article.id, true);

    server.failNext(400);
    await core.sync();
    // フォルダの削除は断られたので戻り、スターは送られている
    expect((await core.listFolders()).map((f) => f.id)).toEqual([folder.id]);
    expect(server.inbox.get(article.id)?.starredAt).not.toBeNull();
    expect((await core.getArticle(article.id))?.starredAt).not.toBeNull();
    expect(await core.listFeeds()).toMatchObject([{ id: feed.id }]);
  });
});

describe("付け替えの通知と、取り直したあとのまとめて既読", () => {
  test("同じ名前のフォルダに付け替えたら、差分がなくても、フォルダとフィードの変更を知らせる", async () => {
    const { server, core, feed } = await withArticle();
    const existing = server.createFolder("Tech");
    await core.sync();
    const tempId = await core.createFolder("Tech");
    await core.moveFeed(feed.id, tempId);
    // フィードの移動は送ったあと、差分には何も載らないようにする
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));

    await core.sync();
    expect(changes[0]).toEqual(["feeds", "folders"]);
    expect((await core.listFolders()).map((f) => f.id)).toEqual([existing.id]);
  });

  test("カーソルが古すぎて取り直しても、まだ送っていないまとめて既読を重ね直す", async () => {
    const context = await withArticle();
    const { server, core, article } = context;
    const gone = server.createFolder("Gone");
    await core.sync();
    await core.markAllRead({ all: true });
    server.deleteFolder(gone.id);
    server.purgeTombstones();

    const result = await pullOnly(context);
    expect(result.reset).toBe(true);
    expect((await core.getArticle(article.id))?.readAt).not.toBeNull();
  });

  test("未読がなければ、まとめて既読は何もしない", async () => {
    const { core, article } = await withArticle();
    await core.setRead(article.id, true);
    await core.sync();
    await core.markAllRead({ all: true });
    expect(await core.countPending()).toBe(0);
  });
});

describe("送る途中で届かなくなったとき", () => {
  test("断られた操作を戻したあと、残りの操作を手元に重ね直す（このあと届かなくても）", async () => {
    const { server, core, feed } = await withArticle();
    const tech = server.createFolder("Tech");
    server.createFolder("News");
    await core.sync();

    await core.renameFolder(tech.id, "News");
    await core.moveFeed(feed.id, tech.id);
    await core.renameFolder(tech.id, "Technology");
    // 名前の変更（409）と読み直しは届き、フィードの移動で届かなくなる
    server.failNext(null, null, "network");
    const error = await core.sync().catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("network");
    expect((await core.listFolders()).find((f) => f.id === tech.id)?.name).toBe("Technology");
    expect(await core.listFeeds()).toMatchObject([{ folderId: tech.id }]);
  });

  test("付け替えたあとに届かなくなっても、付け替えたことは知らせる", async () => {
    const { server, core, article } = await withArticle();
    const existing = server.createFolder("Tech");
    await core.sync();
    await core.createFolder("Tech");
    await core.setStarred(article.id, true);
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables].sort()));

    // フォルダの作成（409）と探し直しは届き、スターで届かなくなる
    server.failNext(null, null, "network");
    await core.sync().catch(() => undefined);
    expect(changes).toContainEqual(["feeds", "folders"]);
    expect((await core.listFolders()).map((f) => f.id)).toEqual([existing.id]);
  });
});

describe("同じ名前のフォルダに付け替えたあと", () => {
  test("仮のフォルダに重ねていた名前の変更を、付け替えた ID で重ね直す（このあと届かなくても）", async () => {
    const { server, core } = await withArticle();
    const existing = server.createFolder("Tech");
    await core.sync();
    const tempId = await core.createFolder("Tech");
    await core.renameFolder(tempId, "Technology");

    // フォルダの作成（409）と探し直しは届き、名前の変更で届かなくなる
    server.failNext(null, null, "network");
    await core.sync().catch(() => undefined);
    expect(await core.listFolders()).toMatchObject([{ id: existing.id, name: "Technology" }]);
    expect(await core.countPending()).toBe(1);
  });
});
