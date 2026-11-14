import { ApiError, errorFromBody, type SendoApi } from "../api/client";
import type { MarkReadUpToCursorRequest } from "../api/sync-contract";
import type { Executor } from "../db/database";
import { clearSyncedRows } from "../db/synced";

/**
 * 手元にすぐ反映して、あとで sendo に送る操作（docs/decisions/local-first.md、sendo の sync.md）。
 *
 * どの操作も、何度送っても同じ結果になる（冪等）ようにする。送ったかどうか分からないまま
 * やり直しても壊れない。
 */
export type Operation =
  | { kind: "setArticleState"; articleId: string; read?: boolean; starred?: boolean; at: number }
  | {
      kind: "markRead";
      scope: MarkReadScope;
      /**
       * 押したときに手元で未読だった記事。手元ではこれだけを既読にする（あとから届いた記事を
       * 巻き込まない。カーソルが古すぎて取り直したあとも、同じ記事を既読に重ね直せる）
       */
      articleIds: string[];
      /** 押したときの同期のカーソル。sendo には、これより後に届いた記事を既読にしないよう頼む */
      cursor: string;
      at: number;
    }
  | { kind: "createFolder"; folderId: string; name: string; at: number }
  | { kind: "renameFolder"; folderId: string; name: string }
  | { kind: "deleteFolder"; folderId: string }
  | { kind: "moveFeed"; feedId: string; folderId: string | null }
  | { kind: "unsubscribe"; feedId: string };

export type MarkReadScope = MarkReadUpToCursorRequest["scope"];

/** 手元で作ったフォルダの仮の ID。sendo が ID を返したら、それに付け替える */
export const LOCAL_ID_PREFIX = "local-";

/** 同じものへの操作をまとめるときの鍵 */
export function keyOf(op: Operation): string {
  switch (op.kind) {
    case "setArticleState":
      return op.articleId;
    case "markRead":
      return "all" in op.scope ? "all" : "feedId" in op.scope ? op.scope.feedId : op.scope.folderId;
    case "createFolder":
    case "renameFolder":
    case "deleteFolder":
      return op.folderId;
    case "moveFeed":
    case "unsubscribe":
      return op.feedId;
  }
}

/**
 * 列の最後にある同じ鍵の操作に、新しい操作をまとめられるならまとめた操作を返す。
 * まとめるのは、上書きしても意味が変わらないもの（既読・スター、名前、フォルダの移動）だけ。
 */
export function merge(previous: Operation, next: Operation): Operation | null {
  if (previous.kind === "setArticleState" && next.kind === "setArticleState") {
    if (previous.articleId !== next.articleId) return null;
    const merged: Operation = { ...previous, at: next.at };
    if (next.read !== undefined) merged.read = next.read;
    if (next.starred !== undefined) merged.starred = next.starred;
    return merged;
  }
  if (previous.kind === "renameFolder" && next.kind === "renameFolder") {
    return previous.folderId === next.folderId ? next : null;
  }
  if (previous.kind === "moveFeed" && next.kind === "moveFeed") {
    return previous.feedId === next.feedId ? next : null;
  }
  return null;
}

/** 操作を手元の DB に当てる。同期で届いた行の上に、まだ送り終えていない操作を重ねるときにも使う */
export async function applyLocally(tx: Executor, op: Operation): Promise<void> {
  switch (op.kind) {
    case "setArticleState": {
      // sendo と同じく、すでにその状態なら時刻は変えない
      const read = op.read === undefined ? null : op.read ? 1 : 0;
      const starred = op.starred === undefined ? null : op.starred ? 1 : 0;
      await tx.run(
        `update articles set
           read_at = case ?1 when 1 then coalesce(read_at, ?3) when 0 then null else read_at end,
           starred_at = case ?2 when 1 then coalesce(starred_at, ?3) when 0 then null else starred_at end
         where id = ?4`,
        [read, starred, op.at, op.articleId],
      );
      return;
    }
    case "markRead":
      await tx.run(
        `update articles set read_at = ?
         where read_at is null and id in (select value from json_each(?))`,
        [op.at, JSON.stringify(op.articleIds)],
      );
      return;
    case "createFolder":
      await tx.run(
        "insert into folders (id, name, created_at) values (?, ?, ?) on conflict (id) do nothing",
        [op.folderId, op.name, op.at],
      );
      return;
    case "renameFolder":
      await tx.run("update folders set name = ? where id = ?", [op.name, op.folderId]);
      return;
    case "deleteFolder":
      await tx.run("delete from folders where id = ?", [op.folderId]);
      await tx.run("update feeds set folder_id = null where folder_id = ?", [op.folderId]);
      return;
    case "moveFeed":
      await tx.run("update feeds set folder_id = ? where id = ?", [op.folderId, op.feedId]);
      return;
    case "unsubscribe":
      await tx.run("delete from feeds where id = ?", [op.feedId]);
      // 購読をやめたフィードの記事は、スターを付けたもの以外を手元から消す（sync.md）
      await tx.run("delete from articles where feed_id = ? and starred_at is null", [op.feedId]);
      return;
  }
}

/** まとめて既読の範囲を、articles の条件にする */
export function scopeCondition(scope: MarkReadScope): [string, string[]] {
  if ("feedId" in scope) return ["feed_id = ?", [scope.feedId]];
  if ("folderId" in scope) {
    return ["feed_id in (select id from feeds where folder_id = ?)", [scope.folderId]];
  }
  return ["1 = 1", []];
}

/** 送った結果。手元で作ったフォルダに、sendo が ID を付けたら remap を返す */
export type SendResult = { remap?: { from: string; to: string } };

/** 操作を sendo に送る。失敗したら ApiError を投げる。signal で中断する（ログアウトなど） */
export async function send(api: SendoApi, op: Operation, signal: AbortSignal): Promise<SendResult> {
  const { client } = api;
  switch (op.kind) {
    case "setArticleState": {
      const body: { read?: boolean; starred?: boolean } = {};
      if (op.read !== undefined) body.read = op.read;
      if (op.starred !== undefined) body.starred = op.starred;
      check(
        await client.PATCH("/articles/{id}", {
          params: { path: { id: op.articleId } },
          body,
          signal,
        }),
      );
      return {};
    }
    case "markRead":
      await api.markReadUpToCursor({ scope: op.scope, cursor: op.cursor }, signal);
      return {};
    case "createFolder": {
      const created = await client.POST("/folders", { body: { name: op.name }, signal });
      if (created.response.status === 409) {
        // 同じ名前のフォルダがすでにある（前に送って応答だけ失った、または別の端末で作った）。
        // それに付け替える
        const existing = await findFolderByName(api, op.name, signal);
        if (existing !== null) return { remap: { from: op.folderId, to: existing } };
      }
      const folder = check(created).folder;
      return { remap: { from: op.folderId, to: folder.id } };
    }
    case "renameFolder":
      check(
        await client.PATCH("/folders/{id}", {
          params: { path: { id: op.folderId } },
          body: { name: op.name },
          signal,
        }),
      );
      return {};
    case "deleteFolder":
      try {
        check(
          await client.DELETE("/folders/{id}", { params: { path: { id: op.folderId } }, signal }),
        );
      } catch (error) {
        // すでにない。消したかった状態になっている
        if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
      }
      return {};
    case "moveFeed":
      check(
        await client.PATCH("/feeds/{id}", {
          params: { path: { id: op.feedId } },
          body: { folderId: op.folderId },
          signal,
        }),
      );
      return {};
    case "unsubscribe":
      try {
        check(await client.DELETE("/feeds/{id}", { params: { path: { id: op.feedId } }, signal }));
      } catch (error) {
        if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
      }
      return {};
  }
}

/**
 * sendo が受け付けなかった（やり直しても変わらない）操作の、手元への反映を戻す。
 * 戻す先は sendo の今の状態にする。通信が要るものは、ここで読み直す。
 *
 * 戻し方が決まっていないもの（sendo が状態を変えずに断ったので、次の差分にも載らないもの）は、
 * 同期で届いた手元の行を消して、最初から取り直す。
 */
export async function undo(
  api: SendoApi,
  op: Operation,
  error: ApiError,
  write: (fn: (tx: Executor) => Promise<void>) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  switch (op.kind) {
    case "setArticleState":
      if (error.kind === "not_found") {
        // 記事が受信箱にない（購読をやめた、など）。手元からも消す
        await write((tx) => tx.run("delete from articles where id = ?", [op.articleId]));
        return;
      }
      break;
    case "createFolder":
      // sendo にはないフォルダ。手元からも消す
      await write(async (tx) => {
        await tx.run("delete from folders where id = ?", [op.folderId]);
        await tx.run("update feeds set folder_id = null where folder_id = ?", [op.folderId]);
      });
      return;
    case "renameFolder": {
      const folder = check(await api.client.GET("/folders", { signal })).items.find(
        (item) => item.id === op.folderId,
      );
      await write((tx) =>
        folder === undefined
          ? tx.run("delete from folders where id = ?", [op.folderId])
          : tx.run("update folders set name = ? where id = ?", [folder.name, folder.id]),
      );
      return;
    }
    case "moveFeed": {
      const feed = check(await api.client.GET("/feeds", { signal })).items.find(
        (item) => item.id === op.feedId,
      );
      await write((tx) =>
        feed === undefined
          ? tx.run("delete from feeds where id = ?", [op.feedId])
          : tx.run("update feeds set folder_id = ? where id = ?", [feed.folderId, feed.id]),
      );
      return;
    }
    case "markRead":
    case "deleteFolder":
    case "unsubscribe":
      break;
  }
  await write(clearSyncedRows);
}

/**
 * 手元で作ったフォルダの仮の ID を、sendo が付けた ID に付け替える。
 * フォルダ、そこに入れたフィード、まだ送っていない操作のすべてを付け替える。
 */
export async function remapFolderId(tx: Executor, from: string, to: string): Promise<void> {
  if (from === to) return;
  // 同期ですでに届いていれば、仮のほうを消す
  await tx.run("delete from folders where id = ? and exists (select 1 from folders where id = ?)", [
    from,
    to,
  ]);
  await tx.run("update folders set id = ? where id = ?", [to, from]);
  await tx.run("update feeds set folder_id = ? where folder_id = ?", [to, from]);
  await tx.run(
    `update pending_ops set payload = json_set(payload, '$.folderId', ?1),
       key = case key when ?2 then ?1 else key end
     where json_extract(payload, '$.folderId') = ?2`,
    [to, from],
  );
  await tx.run(
    `update pending_ops set payload = json_set(payload, '$.scope.folderId', ?1),
       key = case key when ?2 then ?1 else key end
     where json_extract(payload, '$.scope.folderId') = ?2`,
    [to, from],
  );
}

async function findFolderByName(
  api: SendoApi,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { items } = check(await api.client.GET("/folders", { signal }));
  return items.find((item) => item.name === name)?.id ?? null;
}

/** openapi-fetch の結果から、成功ならデータを返し、失敗なら ApiError を投げる */
function check<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok && result.data !== undefined) return result.data;
  if (result.response.ok) return undefined as T;
  throw errorFromBody(result.response.status, result.error);
}
