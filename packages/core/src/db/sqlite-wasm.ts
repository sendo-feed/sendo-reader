import type { Database as Oo1Database } from "@sqlite.org/sqlite-wasm";
import type { Database, Executor, Row, SqlValue } from "./database";

/**
 * 公式の sqlite-wasm（oo1 の API）を、core の Database の窓口に包む。
 *
 * sqlite-wasm は同期的に動くので、そのままだと await の合間にほかの呼び出しが割り込み、
 * トランザクションの途中に別の書き込みが入る。そこで、すべての呼び出しを 1 列に並べて順に
 * 実行する。Web では opfs-sahpool の DB を、テストでは Node の :memory: の DB を渡す。
 */
export function wrapSqliteWasm(db: Oo1Database): Database {
  const executor: Executor = {
    async run(sql, params) {
      if (params === undefined || params.length === 0) db.exec(sql);
      else db.exec(sql, { bind: [...params] });
    },
    async all<T extends Row>(sql: string, params?: readonly SqlValue[]) {
      // 列の値は SqlValue（文字列、数、null）だけを使う（BLOB や bigint の列は作らない）
      const rows =
        params === undefined || params.length === 0
          ? db.selectObjects(sql)
          : db.selectObjects(sql, [...params]);
      return rows as T[];
    },
  };

  let tail: Promise<unknown> = Promise.resolve();
  /** 前の呼び出しが終わってから実行する（失敗しても列は止めない） */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    run: (sql, params) => exclusive(() => executor.run(sql, params)),
    all: <T extends Row>(sql: string, params?: readonly SqlValue[]) =>
      exclusive(() => executor.all<T>(sql, params)),
    transaction: (fn) =>
      exclusive(async () => {
        db.exec("begin immediate");
        try {
          const result = await fn(executor);
          db.exec("commit");
          return result;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      }),
  };
}
