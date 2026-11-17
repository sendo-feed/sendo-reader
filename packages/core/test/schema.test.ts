import { describe, expect, test } from "vitest";
import { NewerSchemaError, ReaderCore, SCHEMA_VERSION } from "../src";
import { migrate } from "../src/db/schema";
import { openMemoryDb } from "./helpers";

describe("手元の DB のスキーマ", () => {
  test("マイグレーションを当てると、版が最新になり、表ができる", async () => {
    const db = await openMemoryDb();
    await migrate(db);
    const [version] = await db.all<{ user_version: number }>("pragma user_version");
    expect(version?.user_version).toBe(SCHEMA_VERSION);
    const tables = await db.all<{ name: string }>(
      "select name from sqlite_schema where type = 'table' order by name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "article_contents",
      "article_page_contents",
      "articles",
      "feeds",
      "folders",
      "pending_ops",
      "settings",
      "sqlite_sequence",
      "synced_settings",
    ]);
  });

  test("前の版で積んだまとめて既読には、手元で既読にした記事をすべて ID でも頼む印を足す", async () => {
    const db = await openMemoryDb();
    await migrate(db, 2);
    const old = {
      kind: "markRead",
      scope: { all: true },
      articleIds: ["a1", "a2"],
      cursor: "c",
      at: 1,
    };
    await db.run(
      "insert into pending_ops (kind, key, payload, created_at) values ('markRead', 'all', ?, 1)",
      [JSON.stringify(old)],
    );
    await db.run(
      "insert into pending_ops (kind, key, payload, created_at) values ('setArticleState', 'a1', ?, 1)",
      [JSON.stringify({ kind: "setArticleState", articleId: "a1", read: true, at: 1 })],
    );
    await migrate(db);
    const rows = await db.all<{ payload: string }>("select payload from pending_ops order by id");
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
      { ...old, extraIds: ["a1", "a2"] },
      { kind: "setArticleState", articleId: "a1", read: true, at: 1 },
    ]);
  });

  test("前の版が手元で作ったフォルダの仮の ID（local- ＋ UUID）から、local- を外す", async () => {
    const db = await openMemoryDb();
    await migrate(db, 4);
    const uuid = crypto.randomUUID();
    const local = `local-${uuid}`;
    await db.run(
      "insert into folders (id, name, created_at) values (?, 'Tech', 1), ('f1', 'News', 1)",
      [local],
    );
    await db.run(
      `insert into feeds (id, url, folder_id, created_at)
       values ('feed-1', 'https://a.example/', ?, 1), ('feed-2', 'https://b.example/', 'f1', 1)`,
      [local],
    );
    const ops = [
      {
        kind: "createFolder",
        key: local,
        payload: { kind: "createFolder", folderId: local, name: "Tech", at: 1 },
      },
      {
        kind: "renameFolder",
        key: local,
        payload: { kind: "renameFolder", folderId: local, name: "Tech 2" },
      },
      {
        kind: "moveFeed",
        key: "feed-1",
        payload: { kind: "moveFeed", feedId: "feed-1", folderId: local },
      },
      {
        kind: "markRead",
        key: local,
        payload: {
          kind: "markRead",
          scope: { folderId: local },
          articleIds: ["a1"],
          cursor: null,
          extraIds: ["a1"],
          at: 1,
        },
      },
      {
        kind: "moveFeed",
        key: "feed-2",
        payload: { kind: "moveFeed", feedId: "feed-2", folderId: "f1" },
      },
    ];
    for (const op of ops) {
      await db.run("insert into pending_ops (kind, key, payload, created_at) values (?, ?, ?, 1)", [
        op.kind,
        op.key,
        JSON.stringify(op.payload),
      ]);
    }

    await migrate(db);
    expect(await db.all("select id from folders order by name")).toEqual([
      { id: "f1" },
      { id: uuid },
    ]);
    expect(await db.all("select id, folder_id from feeds order by id")).toEqual([
      { id: "feed-1", folder_id: uuid },
      { id: "feed-2", folder_id: "f1" },
    ]);
    const rows = await db.all<{ key: string; payload: string }>(
      "select key, payload from pending_ops order by id",
    );
    expect(rows.map((row) => ({ key: row.key, payload: JSON.parse(row.payload) }))).toEqual([
      { key: uuid, payload: { ...ops[0]?.payload, folderId: uuid } },
      { key: uuid, payload: { ...ops[1]?.payload, folderId: uuid } },
      { key: "feed-1", payload: { ...ops[2]?.payload, folderId: uuid } },
      { key: uuid, payload: { ...ops[3]?.payload, scope: { folderId: uuid } } },
      { key: "feed-2", payload: ops[4]?.payload },
    ]);
  });

  test("古い既読の記事を消すための索引を外し、未読の一覧を未読の行だけから読む", async () => {
    const db = await openMemoryDb();
    await migrate(db);
    const indexes = await db.all<{ name: string }>(
      "select name from sqlite_schema where type = 'index' and tbl_name = 'articles' order by name",
    );
    expect(indexes.map((index) => index.name)).not.toContain("articles_received_idx");
    const plan = await db.all<{ detail: string }>(
      `explain query plan select id from articles where read_at is null
       order by published_at desc, id desc limit 50`,
    );
    expect(plan.map((row) => row.detail).join()).toContain("articles_unread_published_idx");
  });

  test("2 回当てても何も変わらない", async () => {
    const db = await openMemoryDb();
    await migrate(db);
    await db.run("insert into folders (id, name, created_at) values ('f1', 'Tech', 1)");
    await migrate(db);
    expect(await db.all("select id from folders")).toEqual([{ id: "f1" }]);
  });

  test("このアプリより新しい版の DB は開かない（壊さない）", async () => {
    const db = await openMemoryDb();
    await db.run(`pragma user_version = ${SCHEMA_VERSION + 1}`);
    await expect(
      ReaderCore.open({ db, baseUrl: "https://sendo.test/api/v1" }),
    ).rejects.toBeInstanceOf(NewerSchemaError);
  });

  test("トランザクションの途中で失敗したら、書き込みを巻き戻す", async () => {
    const db = await openMemoryDb();
    await migrate(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into folders (id, name, created_at) values ('f1', 'Tech', 1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.all("select id from folders")).toEqual([]);
  });

  test("トランザクションの間は、ほかの読み書きを待たせる", async () => {
    const db = await openMemoryDb();
    await migrate(db);
    const order: string[] = [];
    const inTx = db.transaction(async (tx) => {
      await tx.run("insert into folders (id, name, created_at) values ('f1', 'Tech', 1)");
      order.push("tx: inserted");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("tx: done");
    });
    const read = db.all("select id from folders").then((rows) => {
      order.push(`read: ${rows.length}`);
    });
    await Promise.all([inTx, read]);
    expect(order).toEqual(["tx: inserted", "tx: done", "read: 1"]);
  });

  test("画像の URL の列を足しても、すでにある記事とフィードは残り、URL は null のまま", async () => {
    const db = await openMemoryDb();
    await migrate(db, 6);
    await db.run(
      "insert into feeds (id, url, created_at) values ('feed-1', 'https://a.example/', 1)",
    );
    await db.run(
      `insert into articles (id, feed_id, title, published_at, received_at)
       values ('a1', 'feed-1', 'old', 1, 1)`,
    );
    await migrate(db);
    expect(await db.all("select id, icon_url from feeds")).toEqual([
      { id: "feed-1", icon_url: null },
    ]);
    expect(await db.all("select id, title, thumbnail_url from articles")).toEqual([
      { id: "a1", title: "old", thumbnail_url: null },
    ]);
  });
});
