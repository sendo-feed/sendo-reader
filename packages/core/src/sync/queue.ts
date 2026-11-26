import { ApiError, type SendoApi } from "../api/client";
import type { Database, Executor } from "../db/database";
import { putSavedPage, removeSavedPage } from "../db/saved-pages";
import { invalidateWorkspaceDefault, putWorkspaceDefault } from "../db/workspaces";
import type { Table } from "../models";
import {
  applyLocally,
  dropWorkspaceReadOverlay,
  isRetryable,
  isWorkspaceOperation,
  keyOf,
  merge,
  type Operation,
  remapFolderId,
  send,
  undo,
} from "./ops";
import type { SyncPage } from "./page";

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
export async function enqueue(
  tx: Executor,
  op: Operation,
  now: number,
  options: {
    /** この番号以下の操作にはまとめない（通信が要る操作より前に送る操作に、あとの意図を混ぜない） */
    mergeAbove?: number;
  } = {},
): Promise<number> {
  await applyLocally(tx, op);
  const [last] = await tx.all<PendingRow>(
    "select id, kind, key, payload, rev from pending_ops order by id desc limit 1",
  );
  if (
    last !== undefined &&
    last.id > (options.mergeAbove ?? 0) &&
    last.kind === op.kind &&
    last.key === keyOf(op)
  ) {
    const merged = merge(JSON.parse(last.payload) as Operation, op);
    if (merged !== null) {
      await tx.run("update pending_ops set payload = ?, rev = rev + 1 where id = ?", [
        JSON.stringify(merged),
        last.id,
      ]);
      return last.id;
    }
  }
  const [inserted] = await tx.all<{ id: number }>(
    "insert into pending_ops (kind, key, payload, created_at) values (?, ?, ?, ?) returning id",
    [op.kind, keyOf(op), JSON.stringify(op), now],
  );
  if (inserted === undefined) throw new Error("操作を積めなかった");
  return inserted.id;
}

/** 最後に積んだ操作の番号（まだ何もなければ 0） */
export async function lastPendingId(db: Executor): Promise<number> {
  const [row] = await db.all<{ id: number | null }>("select max(id) as id from pending_ops");
  return row?.id ?? 0;
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
export async function reapplyPending(tx: Executor): Promise<boolean> {
  // 削除を先に表示したあとで購読が戻ったら、そのワークスペースも見えるようにする。
  const hidden = await tx.all<{ id: string }>(
    "update workspaces set deleted_locally = 0 where deleted_locally = 1 returning id",
  );
  const pending = await listPending(tx);
  for (const { id, op } of pending) await applyLocally(tx, op, id);
  if (hidden.length === 0 && !pending.some(({ op }) => op.kind === "deleteWorkspace")) return false;
  const after = await tx.all<{ id: string }>("select id from workspaces where deleted_locally = 1");
  const beforeIds = new Set(hidden.map(({ id }) => id));
  return after.length !== hidden.length || after.some(({ id }) => !beforeIds.has(id));
}

/**
 * 同期で届いた記事を、まだ送り終えていないまとめて既読の「ID でも頼む記事」（extraIds）に足す。
 * 押したあとに届いた記事は、sendo で既読・未読が変わっていて（ほかの端末で未読に戻した、など）、
 * 押したときのカーソルでは既読にならないことがある。ID でも頼めば、あとから送ったまとめて既読が
 * 採られ、手元（重ね直して既読）と sendo が揃う。
 * 選択中のワークスペースに対する操作は、送信済みでも差分の完了前までは手元の表示を保つ。
 */
export async function reconcilePendingMarkRead(
  tx: Executor,
  changes: SyncPage["articles"],
  done = false,
): Promise<boolean> {
  if (changes.length === 0 && !done) return false;
  let changed = false;
  const delivered = new Map(
    changes.flatMap<[string, boolean]>((article) =>
      article.deleted ? [] : [[article.id, article.readAt !== null]],
    ),
  );
  for (const { id, op } of await listPending(tx)) {
    if (op.kind === "markWorkspaceRead" && op.acknowledged === true) {
      // 新しい状態を受け取った行は、古いカーソルの楽観更新で上書きしない。
      const articleIds = op.articleIds.filter((articleId) => !delivered.has(articleId));
      if (op.acknowledged === true && done) {
        // 差分に出なかった記事は Sendo が既読にしなかったので、手元の印を外す。
        if (articleIds.length > 0 && (await dropWorkspaceReadOverlay(tx, { ...op, articleIds }))) {
          changed = true;
        }
        await tx.run("delete from pending_ops where id = ?", [id]);
      } else if (articleIds.length < op.articleIds.length) {
        await tx.run("update pending_ops set payload = ? where id = ?", [
          JSON.stringify({ ...op, articleIds }),
          id,
        ]);
      }
      continue;
    }
    if (op.kind === "markWorkspaceRead") {
      // スター変更などの差分が届いても、未送信の既読を重ねられるよう対象は保つ。
      const previous = new Set(op.serverReadArticleIds);
      const serverReadArticleIds = op.articleIds.filter((articleId) => {
        return delivered.get(articleId) ?? previous.has(articleId);
      });
      if (
        previous.size !== serverReadArticleIds.length ||
        serverReadArticleIds.some((articleId) => !previous.has(articleId))
      ) {
        await tx.run("update pending_ops set payload = ? where id = ?", [
          JSON.stringify({ ...op, serverReadArticleIds }),
          id,
        ]);
      }
      continue;
    }
    if (op.kind !== "markRead") continue;
    const extra = new Set(op.extraIds);
    const added = op.articleIds.filter(
      (articleId) => delivered.has(articleId) && !extra.has(articleId),
    );
    if (added.length === 0) continue;
    await tx.run("update pending_ops set payload = ? where id = ?", [
      JSON.stringify({ ...op, extraIds: [...op.extraIds, ...added] }),
      id,
    ]);
  }
  return changed;
}

export interface RejectedOperation {
  op: Operation;
  error: ApiError;
}

export interface PushResult {
  /** sendo が受け付けた操作の数 */
  sent: number;
  /** sendo が受け付けなかった（やり直しても変わらない）ので捨てた操作 */
  rejected: RejectedOperation[];
  /** 手元で作ったフォルダの ID と、まとめた先（sendo にあった、同じ名前のフォルダ）の ID */
  remapped: { from: string; to: string }[];
}

/**
 * 積んだ操作を順に送る。届かない、サーバーの不具合、セッションが切れたときは、そこで止めて
 * ApiError を投げる（操作は残る）。受け付けられなかった操作は、手元の反映を戻して捨てる。
 */
export interface PushOptions {
  /**
   * 手元の DB を変えたら、確定したその時点で呼ぶ（フォルダの付け替え、断られた操作の戻し）。
   * あとの操作が届かずに push が投げても、確定した変更は知らせる
   */
  onChange?: (tables: ReadonlySet<Table>) => void;
  /** 拒否が確定した時点で呼ぶ。後続の通信が失敗しても失敗理由を知らせられる */
  onReject?: (rejection: RejectedOperation) => void;
  /** フォルダをまとめて ID を付け替えたら、確定したその時点で呼ぶ（あとの操作が失敗しても失わない） */
  onRemap?: (remap: { from: string; to: string }) => void;
  /**
   * この操作を送ってよいか（積んだ順に見て、送ってはいけない操作に来たらそこで止める）。
   * 通信が要る操作（購読など）を呼んだあとに積んだ操作を、その操作より先に送らないため
   */
  allow?: (id: number) => boolean;
}

export async function push(
  db: Database,
  api: SendoApi,
  signal: AbortSignal,
  options: PushOptions = {},
): Promise<PushResult> {
  const result: PushResult = { sent: 0, rejected: [], remapped: [] };
  while (true) {
    signal.throwIfAborted();
    const [next] = await db.all<PendingRow>(
      `select id, kind, key, payload, rev from pending_ops
       where kind <> 'markWorkspaceRead' or json_extract(payload, '$.acknowledged') is not 1
       order by id limit 1`,
    );
    if (next === undefined) return result;
    if (options.allow !== undefined && !options.allow(next.id)) return result;
    const op = JSON.parse(next.payload) as Operation;

    try {
      const sent = await send(api, op, signal);
      const workspacesChanged = await db.transaction(async (tx) => {
        // 送っている間にログアウトしていたら、手元には書かない
        signal.throwIfAborted();
        let visibleWorkspaceRemoved = false;
        if (op.kind === "setSavedPage") {
          if (sent.savedPage === undefined) await removeSavedPage(tx, op.id);
          else await putSavedPage(tx, sent.savedPage);
        }
        if (op.kind === "deleteWorkspace") {
          const [removed] = await tx.all<{ deleted_locally: number }>(
            "delete from workspaces where id = ? returning deleted_locally",
            [op.workspaceId],
          );
          visibleWorkspaceRemoved = removed?.deleted_locally === 0;
        }
        if (op.kind === "setDefaultWorkspace") await putWorkspaceDefault(tx, op.workspaceId);
        if (op.kind === "moveFeedToWorkspace") {
          await tx.run(
            "update feeds set synced_workspace_id = ? where id = ? and subscription_id = ?",
            [op.workspaceId, op.feedId, op.subscriptionId],
          );
        }
        if (op.kind === "markWorkspaceRead") {
          const serverRead = new Set(op.serverReadArticleIds);
          await tx.run("update pending_ops set payload = ? where id = ? and rev = ?", [
            JSON.stringify({
              ...op,
              articleIds: op.articleIds.filter((articleId) => !serverRead.has(articleId)),
              acknowledged: true,
            }),
            next.id,
            next.rev,
          ]);
        } else {
          await complete(tx, next.id, next.rev);
        }
        if (sent.remap === undefined) return visibleWorkspaceRemoved;
        await remapFolderId(tx, sent.remap.from, sent.remap.to);
        return (await reapplyPending(tx)) || visibleWorkspaceRemoved;
      });
      result.sent += 1;
      const changed = new Set<Table>();
      if (op.kind === "setSavedPage") changed.add("savedPages");
      if (workspacesChanged) changed.add("workspaces");
      if (sent.remap !== undefined) {
        result.remapped.push(sent.remap);
        options.onRemap?.(sent.remap);
        // フォルダと、そこに入れたフィードが変わる
        changed.add("folders");
        changed.add("feeds");
      }
      if (changed.size > 0) options.onChange?.(changed);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (isRetryable(error)) {
        if (!signal.aborted) {
          await db.run(
            "update pending_ops set attempts = attempts + 1, last_error = ? where id = ?",
            [`${error.kind}: ${error.message}`, next.id],
          );
        }
        throw error;
      }
      // やり直しても変わらない。ただし、送っている間に同じものへの操作がまとめられていたら
      // （rev が変わっていたら）、まとめた新しい操作を送り直す（戻さない、捨てない）
      if ((await currentRev(db, next.id)) !== next.rev) continue;
      const rejectedProtectedDeletion =
        op.kind === "deleteWorkspace" &&
        (error.code === "workspace_is_default" ||
          error.code === "workspace_default_unavailable" ||
          (op.requireDefaultSupport && error.code === "workspace_not_empty"));
      const rejectedDefaultChange = op.kind === "setDefaultWorkspace";
      // デフォルトの拒否は応答だけで戻せる。取り直しに失敗しても拒否済みの操作は再送しない。
      if (!rejectedProtectedDeletion && !rejectedDefaultChange) {
        await undo(
          api,
          op,
          error,
          (fn) =>
            db.transaction(async (tx) => {
              signal.throwIfAborted();
              await fn(tx);
            }),
          signal,
        );
      }
      const workspacesChanged = await db.transaction(async (tx) => {
        signal.throwIfAborted();
        if (rejectedProtectedDeletion && error.code === "workspace_is_default") {
          await putWorkspaceDefault(tx, op.workspaceId);
        }
        if (rejectedDefaultChange && error.kind === "not_found") {
          await tx.run("delete from workspaces where id = ?", [op.workspaceId]);
        }
        if (error.code === "workspace_default_unavailable") await invalidateWorkspaceDefault(tx);
        // 戻している間にまとめられたら残す（次の同期で、重ね直してから送る）
        await complete(tx, next.id, next.rev);
        // 戻したところに、残りの操作を重ね直す（このあと届かなくても、手元は最新の操作のまま）
        return reapplyPending(tx);
      });
      const changed = new Set<Table>(
        op.kind === "recordArticleOpens"
          ? []
          : op.kind === "setSavedPage"
            ? ["savedPages"]
            : op.kind === "setSettings"
              ? ["settings"]
              : isWorkspaceOperation(op)
                ? ["workspaces", "feeds"]
                : ["folders", "feeds", "articles"],
      );
      if (workspacesChanged) changed.add("workspaces");
      if (changed.size > 0) options.onChange?.(changed);
      const rejection = { op, error };
      result.rejected.push(rejection);
      options.onReject?.(rejection);
    }
  }
}

async function currentRev(db: Executor, id: number): Promise<number | null> {
  const [row] = await db.all<{ rev: number }>("select rev from pending_ops where id = ?", [id]);
  return row?.rev ?? null;
}

/** 送り終えた操作を消す。送っている間にまとめられていたら（rev が変わっていたら）残す */
async function complete(tx: Executor, id: number, rev: number): Promise<void> {
  await tx.run("delete from pending_ops where id = ? and rev = ?", [id, rev]);
}
