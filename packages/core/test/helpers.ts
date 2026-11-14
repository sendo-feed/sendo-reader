import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type Database, ReaderCore, wrapSqliteWasm } from "../src";
import { FakeSendo, TOKEN } from "./fake-sendo";

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;

/** 本番と同じ sqlite-wasm を、Node のメモリーの DB で開く */
export async function openMemoryDb(): Promise<Database> {
  sqlite3 ??= await sqlite3InitModule();
  return wrapSqliteWasm(new sqlite3.oo1.DB(":memory:"));
}

/** 偽の sendo と、それにつないだ ReaderCore を用意する */
export async function setup(options: { signIn?: boolean } = {}) {
  const server = new FakeSendo();
  const db = await openMemoryDb();
  const core = await ReaderCore.open({
    db,
    baseUrl: "https://sendo.test/api/v1",
    fetch: server.fetch,
    now: () => server.now,
  });
  if (options.signIn ?? true) await core.signIn(TOKEN);
  return { server, db, core };
}

export const DAY = 24 * 60 * 60 * 1000;
