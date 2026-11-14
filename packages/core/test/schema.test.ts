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
    expect(tables.map((t) => t.name)).toEqual(["articles", "feeds", "folders", "settings"]);
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
});
