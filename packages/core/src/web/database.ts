import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database } from "../db/database";
import { wrapSqliteWasm } from "../db/sqlite-wasm";

/** 代表を引き継いだとき、前の代表のワーカーが OPFS の取っ手を放すまで待つ時間 */
const OPEN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;

/**
 * OPFS の SQLite を開く（公式の sqlite-wasm と opfs-sahpool。docs/decisions/local-first.md）。
 * Dedicated Worker の中でだけ動く。同じ名前の DB を開けるのは同時に 1 つのワーカーだけ。
 *
 * 前の代表のタブが閉じた直後は、OPFS の取っ手がまだ放されていないことがあるので、間を
 * 空けて開き直す。opfs-sahpool は、開くのに失敗すると既定ではデータを消すので、
 * preserveOnInitFailure を必ず付ける（消すと、ユーザーの手元のデータと未送信の操作を失う）。
 */
export async function openWebDatabase(name: string): Promise<Database> {
  // sqlite-wasm は、使わない VFS（COOP ／ COEP が要る opfs）を入れられないことを console に
  // 書くので捨てる。型には出ていないが、初期化の設定（Emscripten の Module）を受け取る
  const init = sqlite3InitModule as unknown as (config: {
    print: (text: string) => void;
    printErr: (text: string) => void;
  }) => ReturnType<typeof sqlite3InitModule>;
  const sqlite3 = await init({ print: () => {}, printErr: () => {} });

  for (let attempt = 0; ; attempt++) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: `${name}-sahpool`,
        directory: `.${name}`,
        preserveOnInitFailure: true,
        // 前の失敗を覚えたままにせず、もう一度開いてみる（失敗してもデータは消えない）
        forceReinitIfPreviouslyFailed: true,
      } as Parameters<typeof sqlite3.installOpfsSAHPoolVfs>[0]);
      return wrapSqliteWasm(new pool.OpfsSAHPoolDb(`/${name}.sqlite3`));
    } catch (error) {
      const delay = OPEN_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
