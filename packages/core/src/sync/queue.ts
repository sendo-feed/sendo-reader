import { ApiError, type SendoApi } from "../api/client";
import type { Database, Executor } from "../db/database";
import { applyLocally, keyOf, merge, type Operation, remapFolderId, send, undo } from "./ops";

/**
 * 操作キュー（docs/decisions/local-first.md、sendo の sync.md の 5）。
 *
 * 操作は、手元の DB への反映と一緒に、同じトランザクションで積む。送るのは積んだ順に 1 つずつで、
 * 届かなければそこで止め、次の同期でその操作からやり直す（順番を入れ替えない）。
 */

interface PendingRow {
  id: number;
  kind: string;
  key: string;
  payload: string;
  rev: number;
  [column: string]: string | number | null;
}

export interface PendingOperation {
  id: number;
  /** まとめるたびに増える。送っている間にまとめられたら、送り終えても消さずにもう一度送る */
  rev: number;
  op: Operation;
}

/**
 * 操作を手元に反映し、キューに積む。列の最後が同じものへのまとめられる操作なら、まとめる
 * （途中の操作を飛び越えてまとめると、送る順番が変わって意味が変わるので、最後だけ）。
 */
export async function enqueue(tx: Executor, op: Operation, now: number): Promise<void> {
  await applyLocally(tx, op);
  const [last] = await tx.all<PendingRow>(
    "select id, kind, key, payload, rev from pending_ops order by id desc limit 1",
  );
  if (last !== undefined && last.kind === op.kind && last.key === keyOf(op)) {
    const merged = merge(JSON.parse(last.payload) as Operation, op);
    if (merged !== null) {
      await tx.run("update pending_ops set payload = ?, rev = rev + 1 where id = ?", [
        JSON.stringify(merged),
        last.id,
      ]);
      return;
    }
  }
  await tx.run("insert into pending_ops (kind, key, payload, created_at) values (?, ?, ?, ?)", [
    op.kind,
    keyOf(op),
    JSON.stringify(op),
    now,
  ]);
}

/** まだ送り終えていない操作を、積んだ順に読む */
export async function listPending(db: Executor): Promise<PendingOperation[]> {
  const rows = await db.all<PendingRow>(
    "select id, kind, key, payload, rev from pending_ops order by id",
  );
  return rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    op: JSON.parse(row.payload) as Operation,
  }));
}

export async function countPending(db: Executor): Promise<number> {
  const [row] = await db.all<{ count: number }>("select count(*) as count from pending_ops");
  return row?.count ?? 0;
}

/** 同期で届いた行の上に、まだ送り終えていない操作を重ねる（楽観的な更新を保つ） */
export async function reapplyPending(tx: Executor): Promise<void> {
  for (const { op } of await listPending(tx)) await applyLocally(tx, op);
}

export interface PushResult {
  /** sendo が受け付けた操作の数 */
  sent: number;
  /** sendo が受け付けなかった（やり直しても変わらない）ので捨てた操作 */
  rejected: { op: Operation; error: ApiError }[];
}

/**
 * 積んだ操作を順に送る。届かない、サーバーの不具合、トークンが使えないときは、そこで止めて
 * ApiError を投げる（操作は残る）。受け付けられなかった操作は、手元の反映を戻して捨てる。
 */
export async function push(db: Database, api: SendoApi, signal: AbortSignal): Promise<PushResult> {
  const result: PushResult = { sent: 0, rejected: [] };
  while (true) {
    signal.throwIfAborted();
    const [next] = await db.all<PendingRow>(
      "select id, kind, key, payload, rev from pending_ops order by id limit 1",
    );
    if (next === undefined) return result;
    const op = JSON.parse(next.payload) as Operation;

    try {
      const sent = await send(api, op, signal);
      await db.transaction(async (tx) => {
        // 送っている間にログアウトしていたら、手元には書かない
        signal.throwIfAborted();
        if (sent.remap !== undefined) await remapFolderId(tx, sent.remap.from, sent.remap.to);
        await complete(tx, next.id, next.rev);
      });
      result.sent += 1;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (isTransient(error)) {
        if (!signal.aborted) {
          await db.run(
            "update pending_ops set attempts = attempts + 1, last_error = ? where id = ?",
            [`${error.kind}: ${error.message}`, next.id],
          );
        }
        throw error;
      }
      // やり直しても変わらない。手元の反映を sendo の状態に戻し、捨てる
      await undo(
        api,
        op,
        (fn) =>
          db.transaction(async (tx) => {
            signal.throwIfAborted();
            await fn(tx);
          }),
        signal,
      );
      await db.transaction(async (tx) => {
        signal.throwIfAborted();
        await tx.run("delete from pending_ops where id = ?", [next.id]);
      });
      result.rejected.push({ op, error });
    }
  }
}

/** 送り終えた操作を消す。送っている間にまとめられていたら（rev が変わっていたら）残す */
async function complete(tx: Executor, id: number, rev: number): Promise<void> {
  await tx.run("delete from pending_ops where id = ? and rev = ?", [id, rev]);
}

/** あとでやり直せば通るかもしれない失敗 */
function isTransient(error: ApiError): boolean {
  return error.kind === "network" || error.kind === "server" || error.kind === "unauthorized";
}
